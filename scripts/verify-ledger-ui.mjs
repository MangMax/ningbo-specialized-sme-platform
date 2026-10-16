#!/usr/bin/env node
/**
 * RL-17 的**真实**窄屏验收:`nuxt build` → 起 `.output/server/index.mjs` → 真 Chrome 按 390×844 打开 → 量像素。
 *
 * ── 为什么要有这个脚本,而不是一条 vitest ────────────────────────────────
 * 这条断言问的是**布局事实**:「390 视口下 `documentElement.scrollWidth` 有没有超过
 * `clientWidth`」。vitest 跑在裸 node 下(`vitest.config.ts` 的 `environment: 'node'`),
 * 没有排版引擎 —— 就算挂 jsdom,`scrollWidth` 也永远是 0,量不出真东西。
 * mock 出来的宽度更是自己骗自己:这次要抓的正是「分页条在窄屏撑破页面」这种
 * **只有真排版才会出现**的毛病(实测 390 视口 scrollWidth 468 / clientWidth 390,溢出 78px,
 * 元凶是 `PaginationContent` 基础类 `flex-row` 不换行 + 几百页时 11 个条目 452px 宽)。
 *
 * 与 `scripts/verify-prod-openapi.mjs` 同一分工:单元测试守「决定」,这个脚本守「事实」。
 * 零依赖:Chrome 走 CDP,连接用 Node 24 的内置 `WebSocket`,不引 playwright/puppeteer。
 *
 * 用法:`node scripts/verify-ledger-ui.mjs [--port 3491] [--skip-build]`
 * 退出码 0 = 全部通过;非 0 = 有一条不符合预期(并打印实测数字)。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(flag('port', '3491'))
const DEBUG_PORT = PORT + 1
const SKIP_BUILD = args.includes('--skip-build')
const BASE = `http://127.0.0.1:${PORT}`

/** 桌面与窄屏逻辑视口;页面根节点的实测宽度都在下面报告。 */
const VIEWPORTS = [
  { name: '桌面 1440×900', width: 1440, height: 900 },
  { name: '窄屏 390×844', width: 390, height: 844 },
]

const problems = []
const ok = (msg) => console.log(`✓ ${msg}`)
const bad = (msg) => {
  console.log(`✗ ${msg}`)
  problems.push(msg)
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))))
  })
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error(`等不到 ${url}`)
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端(只用到 navigate / evaluate)
// ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const waiter = this.pending.get(msg.id)
      if (waiter) {
        this.pending.delete(msg.id)
        msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result)
      }
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} 超时`))
      }, 30_000)
    })
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return new Cdp(ws)
}

/**
 * 在页面里求值一次。
 */
async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result.value
}

/**
 * 等页面**真的把数据渲染出来**,再量。
 *
 * 为什么不能睡固定时长:第一版写的是 `sleep(4500)`,冷启动的生产实例上那一觉没睡够,
 * 于是第一个视图量到的是「还没加载」的页面 —— 分页条根本不存在,`pagination` 断言被
 * **静默跳过**,而脚本照样打印 ✓。这类「检查自己把自己跳过去」的验收比没有验收更坏:
 * 它给出的是假的安心。所以改成轮询到「有数据行」为止,等不到就**判失败**(而不是跳过)。
 */
async function waitUntil(cdp, sessionId, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(cdp, sessionId, expression)
    if (last) return true
    await sleep(300)
  }
  return false
}

/**
 * 打开一个页面,等它就绪,再求值。
 *
 * 每次都新建 target:**同一个 target 反复 navigate 会带上上一页的滚动位置与
 * `documentElement` 状态**,量出来的宽度偶尔是上一页的,那次串味很难查。
 */
async function openAndMeasure(cdp, url, expression, readyExpression, viewport = VIEWPORTS[0]) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url }, sessionId)
    if (readyExpression) {
      const ready = await waitUntil(cdp, sessionId, readyExpression)
      if (!ready) throw new Error(`${url} 在 30s 内没有渲染出数据行 —— 量不出东西,按失败算`)
    }
    return await evaluate(cdp, sessionId, expression)
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function openSession(cdp, url, viewport) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)
  if (!(await waitUntil(cdp, sessionId, READY))) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    throw new Error(`${url} 在 30s 内没有渲染出表格数据`)
  }
  return { targetId, sessionId }
}

async function clickSelector(cdp, sessionId, selector) {
  const rect = await evaluate(cdp, sessionId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!rect) throw new Error(`找不到可点击元素:${selector}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
}

async function clickButtonContaining(cdp, sessionId, text) {
  const rect = await evaluate(cdp, sessionId, `(() => {
    const el = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes(${JSON.stringify(text)}));
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!rect) throw new Error(`找不到按钮:${text}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
}

async function clickElementContaining(cdp, sessionId, selector, text) {
  const rect = await evaluate(cdp, sessionId, `(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => (item.textContent ?? '').includes(${JSON.stringify(text)}));
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!rect) throw new Error(`找不到包含「${text}」的元素:${selector}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
}

async function setInputValue(cdp, sessionId, selector, value) {
  await evaluate(cdp, sessionId, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error('找不到搜索输入框:' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
}

function overflowViolation(m, label) {
  return m.scrollWidth > m.clientWidth
    ? `${label}:页面级横向溢出 ${m.scrollWidth - m.clientWidth}px(scrollWidth ${m.scrollWidth} / clientWidth ${m.clientWidth})`
    : null
}

async function installMotionAndFetchGate(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    window.__rl20Motion = { control: false, table: false, drawer: false };
    document.addEventListener('transitionrun', (event) => {
      if (!['transform', 'translate', 'scale', 'rotate'].includes(event.propertyName)) return;
      if (event.target.matches('button,[role="tab"],[data-slot="select-trigger"]')) window.__rl20Motion.control = true;
      if (event.target.tagName === 'TBODY') window.__rl20Motion.table = true;
    }, true);
    document.addEventListener('animationstart', (event) => {
      if (event.target.matches('[data-testid="enterprise-drawer"]')) window.__rl20Motion.drawer = true;
    }, true);
    if (!window.__rl20NativeFetch) {
      window.__rl20NativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const gate = window.__rl20FetchGate;
        if (gate?.active && url.includes(gate.pattern)) {
          gate.requested = true;
          return new Promise((resolve, reject) => {
            gate.releases.push(() => window.__rl20NativeFetch(input, init).then(resolve, reject));
          });
        }
        return window.__rl20NativeFetch(input, init);
      };
    }
  })()`)
}

async function startFetchGate(cdp, sessionId, pattern) {
  await evaluate(cdp, sessionId, `window.__rl20FetchGate = { active: true, requested: false, releases: [], pattern: ${JSON.stringify(pattern)} }`)
}

async function finishFetchGate(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    const gate = window.__rl20FetchGate;
    if (gate) {
      gate.active = false;
      for (const release of gate.releases.splice(0)) release();
    }
  })()`)
}

async function waitForLoadingEvidence(cdp, sessionId, pageKind) {
  const statusSelector = pageKind === 'ledger' ? '[data-testid="ledger-loading-status"]' : '[data-testid="comparison-loading-status"]'
  const expression = `(() => {
    const status = document.querySelector(${JSON.stringify(statusSelector)});
    const body = document.querySelector('tbody');
    const gate = window.__rl20FetchGate;
    return !!gate?.requested && (status?.textContent ?? '').includes('正在') && body?.dataset.loading === 'true';
  })()`
  return waitUntil(cdp, sessionId, expression)
}

async function verifyLedgerSearchLoading(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0])
  const { targetId, sessionId } = page
  try {
    await installMotionAndFetchGate(cdp, sessionId)
    const name = await evaluate(cdp, sessionId, `document.querySelector('tbody tr button')?.textContent?.trim() ?? ''`)
    if (!name) {
      bad('企业列表 · 搜索:初始结果没有可搜索的企业名称')
      return
    }

    await startFetchGate(cdp, sessionId, '/api/roster/enterprises?')
    await setInputValue(cdp, sessionId, 'input[aria-label*="企业名称"]', name)
    const searchLoading = await waitForLoadingEvidence(cdp, sessionId, 'ledger')
    if (!searchLoading) bad('企业列表 · 搜索:请求期间没有可见加载状态')
    else ok('企业列表 · 搜索:请求期间显示加载状态')
    await finishFetchGate(cdp, sessionId)
    const searchIdle = await waitUntil(cdp, sessionId, `(() => !document.querySelector('[data-testid="ledger-loading-status"]')?.textContent?.includes('正在') && [...document.querySelectorAll('tbody tr button')].some((el) => (el.textContent ?? '').trim() === ${JSON.stringify(name)}))()`)
    if (!searchIdle) bad('企业列表 · 搜索:匹配结果未在释放请求后渲染')
    else ok(`企业列表 · 搜索:名称筛选返回 ${JSON.stringify(name)}`)
  } finally {
    await finishFetchGate(cdp, sessionId).catch(() => {})
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function verifyLedgerLoadingAndDrawer(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0])
  const { targetId, sessionId } = page
  try {
    await installMotionAndFetchGate(cdp, sessionId)

    // 排序变化:用受控 fetch 保持真实加载态可观察,并核对 Pinia Colada isLoading 驱动的提示。
    await startFetchGate(cdp, sessionId, '/api/roster/enterprises?')
    await clickSelector(cdp, sessionId, '[role="combobox"][aria-label="排序方式"]')
    const optionReady = await waitUntil(cdp, sessionId, `(() => [...document.querySelectorAll('[role="option"]')].some((el) => (el.textContent ?? '').includes('企业名称')))()`)
    if (!optionReady) {
      bad('企业列表 · 排序:没有出现「企业名称」选项')
    } else {
      await clickElementContaining(cdp, sessionId, '[role="option"]', '企业名称')
      const loading = await waitForLoadingEvidence(cdp, sessionId, 'ledger')
      if (!loading) bad('企业列表 · 排序:加载请求期间没有可见状态或表体忙碌标记')
      else ok('企业列表 · 排序:Pinia Colada isLoading 提示在请求期间可见')
      const motion = await waitUntil(cdp, sessionId, 'window.__rl20Motion.control && window.__rl20Motion.table')
      if (!motion) bad('企业列表 · 排序:没有观察到控件反馈和表体位移动效事件')
      else ok('企业列表 · 控件与表体:transitionrun 事件均已观察')
      await finishFetchGate(cdp, sessionId)
      const idle = await waitUntil(cdp, sessionId, `(() => document.querySelector('tbody')?.dataset.loading !== 'true' && !(document.querySelector('[data-testid="ledger-loading-status"]')?.textContent ?? '').includes('正在'))()`)
      if (!idle) bad('企业列表 · 排序:释放请求后加载状态没有收敛')
    }

    // 翻页:同一张表应显示与筛选、排序相同的加载提示。
    // 右侧抽屉按方向卡覆盖表格,先收起它,否则分页按钮被面板覆盖会点到后面的详情链接。
    await evaluate(cdp, sessionId, `document.querySelector('[data-testid="enterprise-drawer"] button[aria-label="关闭"]')?.click()`)
    const drawerClosed = await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return !drawer || drawer.getAttribute('data-state') === 'closed';
    })()`)
    if (!drawerClosed) bad('企业列表 · 翻页:翻页前无法收起覆盖分页条的侧边抽屉')
    await startFetchGate(cdp, sessionId, '/api/roster/enterprises?')
    await clickSelector(cdp, sessionId, '[data-slot="pagination-next"]')
    const pageLoading = await waitForLoadingEvidence(cdp, sessionId, 'ledger')
    if (!pageLoading) {
      const state = await evaluate(cdp, sessionId, `(() => {
        const el = document.querySelector('[data-slot="pagination-next"]');
        const rect = el?.getBoundingClientRect();
        return { gate: window.__rl20FetchGate && { requested: window.__rl20FetchGate.requested, releases: window.__rl20FetchGate.releases.length, pattern: window.__rl20FetchGate.pattern }, page: new URLSearchParams(location.search).get('page'), next: el && { tag: el.tagName, disabled: el.disabled, ariaDisabled: el.getAttribute('aria-disabled'), text: el.textContent?.trim(), rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } };
      })()`)
      bad(`企业列表 · 翻页:请求期间没有可见加载状态 ${JSON.stringify(state)}`)
    }
    else ok('企业列表 · 翻页:请求期间显示加载状态')
    await finishFetchGate(cdp, sessionId)
    const pageIdle = await waitUntil(cdp, sessionId, `(() => document.querySelector('tbody')?.dataset.loading !== 'true' && !(document.querySelector('[data-testid="ledger-loading-status"]')?.textContent ?? '').includes('正在'))()`)
    if (!pageIdle) {
      const state = await evaluate(cdp, sessionId, `(() => ({
        href: location.href,
        status: document.querySelector('[data-testid="ledger-loading-status"]')?.textContent,
        bodyLoading: document.querySelector('tbody')?.dataset.loading,
        error: document.querySelector('[role="alert"]')?.textContent,
        rows: document.querySelectorAll('tbody tr').length,
        gate: window.__rl20FetchGate && { requested: window.__rl20FetchGate.requested, active: window.__rl20FetchGate.active, releases: window.__rl20FetchGate.releases.length, pattern: window.__rl20FetchGate.pattern },
      }))()`)
      bad(`企业列表 · 翻页:释放请求后加载状态没有收敛 ${JSON.stringify(state)}`)
    }

    // 抽屉:关上后从行内重新打开,以 animationstart 而不是固定等待时长确认滑入动画。
    await evaluate(cdp, sessionId, `document.querySelector('[data-testid="enterprise-drawer"] button[aria-label="关闭"]')?.click()`)
    const closed = await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return !drawer || drawer.getAttribute('data-state') === 'closed';
    })()`)
    if (!closed) bad('企业列表 · 抽屉:关闭动作没有完成')
    else {
      await evaluate(cdp, sessionId, `document.querySelector('tbody tr button')?.click()`)
      const drawerMotion = await waitUntil(cdp, sessionId, 'window.__rl20Motion.drawer')
      if (!drawerMotion) bad('企业列表 · 抽屉:没有观察到侧滑 animationstart 事件')
      else ok('企业列表 · 抽屉:侧滑 animationstart 事件已观察')
      const drawerData = await waitUntil(cdp, sessionId, `(() => {
        const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
        return drawer?.getAttribute('data-state') === 'open' && drawer.textContent?.includes('称号历史');
      })()`)
      if (!drawerData) bad('企业列表 · 抽屉:未显示企业称号历史')
      else ok('企业列表 · 抽屉:企业称号历史已渲染')
    }
  } finally {
    await finishFetchGate(cdp, sessionId).catch(() => {})
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function verifyComparisonSearchAndMotion(cdp) {
  const page = await openSession(cdp, `${BASE}/comparison`, VIEWPORTS[0])
  const { targetId, sessionId } = page
  try {
    await installMotionAndFetchGate(cdp, sessionId)
    const name = await evaluate(cdp, sessionId, `document.querySelector('tbody tr a')?.textContent?.trim() ?? ''`)
    if (!name) {
      bad('两侧名录比对 · 搜索:筛选方向后没有结果可用于搜索验收')
      return
    }
    await startFetchGate(cdp, sessionId, '/api/comparison')
    await setInputValue(cdp, sessionId, 'input[aria-label*="企业名称"]', name)
    const searchLoading = await waitForLoadingEvidence(cdp, sessionId, 'comparison')
    if (!searchLoading) bad('两侧名录比对 · 搜索:请求期间没有可见加载状态')
    else ok('两侧名录比对 · 搜索:请求期间显示加载状态')
    await finishFetchGate(cdp, sessionId)
    const searched = await waitUntil(cdp, sessionId, `(() => {
      const status = document.querySelector('[data-testid="comparison-loading-status"]');
      const rows = [...document.querySelectorAll('tbody tr a')].map((el) => (el.textContent ?? '').trim());
      return !(status?.textContent ?? '').includes('正在') && rows.some((row) => row === ${JSON.stringify(name)});
    })()`)
    if (!searched) bad(`两侧名录比对 · 搜索:输入「${name}」后没有返回匹配企业`)
    else ok(`两侧名录比对 · 搜索:名称筛选返回 ${JSON.stringify(name)}`)

    // 清空名称筛选,恢复多页数据并用真按钮验收对比表翻页的加载状态。
    await setInputValue(cdp, sessionId, 'input[aria-label*="企业名称"]', '')
    const clearIdle = await waitUntil(cdp, sessionId, `(() => !(document.querySelector('[data-testid="comparison-loading-status"]')?.textContent ?? '').includes('正在') && [...document.querySelectorAll('tbody tr a')].length > 0 && !(document.querySelector('[data-testid="comparison-loading-status"]')?.textContent ?? '').includes('共 1 条'))()`)
    if (!clearIdle) bad('两侧名录比对 · 清空搜索:释放请求后没有恢复结果')

    await startFetchGate(cdp, sessionId, '/api/comparison')
    await clickSelector(cdp, sessionId, 'button[aria-label="下一页"]')
    const pageLoading = await waitForLoadingEvidence(cdp, sessionId, 'comparison')
    if (!pageLoading) bad('两侧名录比对 · 翻页:请求期间没有可见加载状态')
    else ok('两侧名录比对 · 翻页:请求期间显示加载状态')
    await finishFetchGate(cdp, sessionId)
    const pageIdle = await waitUntil(cdp, sessionId, `(() => !(document.querySelector('[data-testid="comparison-loading-status"]')?.textContent ?? '').includes('正在') && document.querySelector('tbody')?.dataset.loading !== 'true')()`)
    if (!pageIdle) bad('两侧名录比对 · 翻页:释放请求后加载状态没有收敛')

    await startFetchGate(cdp, sessionId, '/api/comparison')
    const hasInactiveTab = await evaluate(cdp, sessionId, `!!document.querySelector('[role="tab"][data-state="inactive"]')`)
    if (!hasInactiveTab) {
      bad('两侧名录比对 · 方向筛选:没有可切换的方向控件')
    } else {
      await clickSelector(cdp, sessionId, '[role="tab"][data-state="inactive"]')
      const loading = await waitForLoadingEvidence(cdp, sessionId, 'comparison')
      if (!loading) bad('两侧名录比对 · 方向筛选:请求期间没有可见加载状态')
      else ok('两侧名录比对 · 方向筛选:请求期间显示加载状态')
      const motion = await waitUntil(cdp, sessionId, 'window.__rl20Motion.control && window.__rl20Motion.table')
      if (!motion) bad('两侧名录比对 · 控件与表体:没有观察到位移动效事件')
      else ok('两侧名录比对 · 控件与表体:方向控件与表体 transitionrun 事件均已观察')
      await finishFetchGate(cdp, sessionId)
      const idle = await waitUntil(cdp, sessionId, `(() => document.querySelector('tbody')?.dataset.loading !== 'true' && !(document.querySelector('[data-testid="comparison-loading-status"]')?.textContent ?? '').includes('正在'))()`)
      if (!idle) bad('两侧名录比对 · 方向筛选:释放请求后加载状态没有收敛')
    }
  } finally {
    await finishFetchGate(cdp, sessionId).catch(() => {})
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

/**
 * 就绪判据:**没有骨架屏**、且**有数据行**、且**分页条在**。
 *
 * 第一版只写了「有 `tbody tr`」—— 结果被**骨架行**满足了(`while (loading && !rows.length)`
 * 那一段渲染的就是 8 行 `<TableRow><Skeleton/></TableRow>`),于是量到的是加载中的页面:
 * 标题「加载中」、分页条不存在,而脚本照样打印 ✓。骨架屏也是行,所以判据必须把它排除。
 */
const READY = `(() => (
  !document.querySelector('[data-slot=skeleton]') &&
  document.querySelectorAll('tbody tr').length > 0 &&
  !!document.querySelector('table') &&
  !!document.querySelector('[data-testid="ledger-loading-status"],[data-testid="comparison-loading-status"]') &&
  ![...document.querySelectorAll('[data-testid="ledger-loading-status"],[data-testid="comparison-loading-status"]')]
    .some((el) => (el.textContent ?? '').includes('正在'))
))()`

// ---------------------------------------------------------------------------
// 要验的三个视图
// ---------------------------------------------------------------------------

const PAGES = [
  { name: '企业列表', query: '/', hint: '企业列表' },
  { name: '两侧名录比对', query: '/comparison', hint: '两侧名录比对' },
]

/** 在页面里量:页面级横向溢出、分页条是否越界、表数、筛选入口与加载提示。 */
const MEASURE = `(() => {
  const de = document.documentElement;
  const nextButton = [...document.querySelectorAll('button')].find((el) => (el.textContent ?? '').includes('下一页'));
  const pagination = document.querySelector('[data-slot=pagination]') || nextButton?.parentElement?.parentElement;
  const rect = pagination ? pagination.getBoundingClientRect() : null;
  return {
    title: document.title,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    innerWidth: window.innerWidth,
    tableCount: document.querySelectorAll('table').length,
    nativeSelectCount: document.querySelectorAll('select').length,
    searchInput: !!document.querySelector('input[aria-label*="企业名称"]'),
    loadingStatus: !!document.querySelector('[data-testid="ledger-loading-status"],[data-testid="comparison-loading-status"]'),
    drawerOpen: document.querySelector('[data-testid="enterprise-drawer"]')?.getAttribute('data-state') === 'open',
    pagination: rect ? { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) } : null,
    // 分页条是不是真的换行了(条目用了不止一行高度)
    paginationRows: pagination
      ? new Set([...pagination.querySelectorAll('[data-slot=pagination-item],[data-slot=pagination-previous],[data-slot=pagination-next]')]
          .map((el) => Math.round(el.getBoundingClientRect().top))).size
      : 0,
  };
})()`

async function main() {
  if (!SKIP_BUILD) {
    console.log('▶ pnpm build')
    await run('pnpm', ['build'])
  }
  if (!existsSync('.output/server/index.mjs')) {
    throw new Error('没有 .output/server/index.mjs —— 先 pnpm build,或去掉 --skip-build')
  }

  console.log(`▶ 起生产产物:PORT=${PORT} node .output/server/index.mjs`)
  const server = spawn('node', ['.output/server/index.mjs'], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT) },
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'rl17-chrome-'))
  let chrome
  let cdp

  try {
    await waitForHttp(`${BASE}/api/health`)

    const chromeBin =
      process.env.CHROME_BIN ??
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) =>
        existsSync(p),
      )
    if (!chromeBin) throw new Error('找不到 Chrome(可用 CHROME_BIN 指定)')

    console.log(`▶ 起 Chrome(--headless)调试端口 ${DEBUG_PORT}`)
    chrome = spawn(
      chromeBin,
      [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
    cdp = await connect(version.webSocketDebuggerUrl)

    for (const viewport of VIEWPORTS) {
      for (const page of PAGES) {
        const url = `${BASE}${page.query}`
        const m = await openAndMeasure(cdp, url, MEASURE, READY, viewport)
        const label = `${page.name} · ${viewport.name}`

        const overflow = overflowViolation(m, label)
        if (overflow) {
          bad(overflow)
        } else {
          ok(`${label}:无页面级横向溢出(scrollWidth ${m.scrollWidth} ≤ clientWidth ${m.clientWidth})`)
        }
        if (m.tableCount !== 1) bad(`${label}:应有且只有一个表格,实测 ${m.tableCount}`)
        else ok(`${label}:唯一表格已渲染`)
        if (!m.searchInput) bad(`${label}:没有搜索入口`)
        else ok(`${label}:搜索入口已渲染`)
        if (!m.loadingStatus) bad(`${label}:没有常驻加载状态容器`)
        else ok(`${label}:加载状态容器已渲染`)
        if (page.query === '/' && m.nativeSelectCount !== 0) bad(`${label}:仍有 ${m.nativeSelectCount} 个原生 select`)
        if (page.query === '/' && !m.drawerOpen) bad(`${label}:企业侧边抽屉未打开`)

        if (m.pagination) {
          if (m.pagination.right > m.innerWidth) {
            bad(`${label}:分页条越界,right=${m.pagination.right} > innerWidth=${m.innerWidth}`)
          } else {
            ok(`${label}:分页条在视口内(right ${m.pagination.right} ≤ ${m.innerWidth},宽 ${m.pagination.width},占 ${m.paginationRows} 行)`)
          }
        } else {
          bad(`${label}:没量到分页控制 —— 这一页有结果就必须可翻页,量不到说明断言被跳过了`)
        }
        if (!m.title || !m.title.includes(page.hint)) {
          bad(`${label}:document.title = ${JSON.stringify(m.title)},看不出是${page.hint}`)
        } else {
          ok(`${label}:document.title = ${JSON.stringify(m.title)}`)
        }
      }
    }

    // 先把页面根部横向撑开 80px,确认上面的同一条断言会命中;target 随后关闭,缺陷随 DOM 一并复原。
    const broken = await openAndMeasure(
      cdp,
      `${BASE}/comparison`,
      `(() => { document.body.style.minWidth = 'calc(100vw + 80px)'; return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[0],
    )
    const selfCheck = overflowViolation(broken, '缺陷自检')
    if (!selfCheck) bad('缺陷自检:临时恢复横向溢出后,横溢出断言仍未命中')
    else console.log(`✗ 缺陷自检按预期变红:${selfCheck}`)
    if (selfCheck) ok('缺陷自检:关闭临时 target 后缺陷已复原')

    // ④ 另外两个页面也要有标题(盲测第二轮:这两处仍是空字符串)
    const TITLE_ONLY = [
      {
        name: '/comparison',
        url: `${BASE}/comparison`,
        hint: '两侧名录比对',
        // 等它把表格渲染出来(同样要排除骨架屏),否则量到的是加载中的标题。
        ready: `(() => !document.querySelector('[data-slot=skeleton]') && !!document.querySelector('table'))()`,
      },
      {
        name: '/enterprises/1295',
        url: `${BASE}/enterprises/1295`,
        hint: '企业详情',
        // 企业名是异步取的,等 `h1` 有字。
        ready: `(() => (document.querySelector('h1')?.textContent ?? '').trim().length > 0)()`,
      },
    ]
    for (const page of TITLE_ONLY) {
      const t = await openAndMeasure(
        cdp,
        page.url,
        `(() => ({ title: document.title }))()`,
        page.ready,
      )
      if (!t.title || !t.title.trim()) {
        bad(`${page.name}:document.title 是空字符串`)
      } else if (!t.title.includes(page.hint)) {
        bad(`${page.name}:document.title = ${JSON.stringify(t.title)},看不出是${page.hint}`)
      } else {
        ok(`${page.name}:document.title = ${JSON.stringify(t.title)}`)
      }
    }

    await verifyLedgerSearchLoading(cdp)
    await verifyLedgerLoadingAndDrawer(cdp)
    await verifyComparisonSearchAndMotion(cdp)

    // ⑤ 图例里引用的列名必须真是**这一页的列头**(盲测第二轮:文案写「平台原因」,
    //    而列头叫「平台解释」,用户按字面找不到那一列)
    const legend = await openAndMeasure(
      cdp,
      `${BASE}/comparison`,
      `(() => {
        const note = [...document.querySelectorAll('span')]
          .map((el) => el.textContent ?? '')
          .find((t) => t.includes('徽章只表示取值本身')) ?? '';
        return {
          note,
          quoted: [...note.matchAll(/「([^」]+)」/g)].map((m) => m[1]),
          headers: [...document.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim()),
        };
      })()`,
      `(() => !document.querySelector('[data-slot=skeleton]') && document.querySelectorAll('thead th').length > 0)()`,
    )
    const missing = legend.quoted.filter((q) => !legend.headers.includes(q))
    if (!legend.note) {
      bad('/comparison:没找到图例说明句(选择器可能已改)')
    } else if (missing.length) {
      bad(
        `/comparison:图例引用了不存在的列名 ${JSON.stringify(missing)}(现有列头 ${JSON.stringify(legend.headers)})`,
      )
    } else {
      ok(`/comparison:图例引用的列名都在列头里 ${JSON.stringify(legend.quoted)}`)
    }

    // ⑥ 深链重定向带走查询串(顺手守一条已知回归)
    const redirect = await openAndMeasure(
      cdp,
      `${BASE}/roster?q=%E5%AE%81%E6%B3%A2&page=2`,
      `(() => ({ path: location.pathname, search: location.search }))()`,
      `(() => location.pathname === '/' && location.search.includes('page=2'))()`,
    )
    if (redirect.path !== '/' || !redirect.search.includes('q=') || !redirect.search.includes('page=2')) {
      bad(`/roster 重定向没带走查询串:${JSON.stringify(redirect)}`)
    } else {
      ok(`/roster → ${redirect.path}${redirect.search}`)
    }
  } finally {
    try {
      await cdp?.send('Browser.close')
    } catch {
      /* ignore */
    }
    chrome?.kill()
    server.kill()
    // Chrome 收尾时还在写 profile 目录,立刻删会 ENOTEMPTY(实测)。
    // 清理失败不该把一次**全部通过**的验收变成退出码 1 —— 等一小会儿再删,删不掉就算了。
    await sleep(1000)
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
        break
      } catch {
        await sleep(500)
      }
    }
  }

  if (problems.length) {
    console.log(`\n✗ ${problems.length} 条不符合预期`)
    process.exit(1)
  }
  console.log('\n✓ 企业列表与比对页已覆盖桌面/390px、表格唯一性、搜索与加载、分页、排序、抽屉动效及 /roster 查询串重定向')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
