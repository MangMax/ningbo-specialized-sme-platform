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
  { name: '200% 等效视口 720×900', width: 720, height: 900 },
]

const problems = []
let passed = 0
const ok = (msg) => {
  passed += 1
  console.log(`✓ ${msg}`)
}
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
        clearTimeout(waiter.timeout)
        msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result)
      }
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} 超时`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timeout })
      this.ws.send(JSON.stringify(payload))
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
async function openAndMeasure(cdp, url, expression, readyExpression, viewport = VIEWPORTS[0], mediaFeatures = []) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId)
    if (mediaFeatures.length) await cdp.send('Emulation.setEmulatedMedia', { features: mediaFeatures }, sessionId)
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

async function openSession(cdp, url, viewport, readyExpression = READY) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)
  if (!(await waitUntil(cdp, sessionId, readyExpression))) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    throw new Error(`${url} 在 30s 内没有渲染出表格数据`)
  }
  return { targetId, sessionId }
}

async function clickPoint(cdp, sessionId, rect, label) {
  if (!rect) throw new Error(`找不到可点击元素:${label}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
}

async function clickSelector(cdp, sessionId, selector) {
  const rect = await evaluate(cdp, sessionId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  await clickPoint(cdp, sessionId, rect, selector)
}

async function clickElementContaining(cdp, sessionId, selector, text) {
  const rect = await evaluate(cdp, sessionId, `(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => (item.textContent ?? '').includes(${JSON.stringify(text)}));
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  await clickPoint(cdp, sessionId, rect, `${selector} 包含「${text}」`)
}

async function closeEnterpriseDrawer(cdp, sessionId) {
  const ready = await waitUntil(cdp, sessionId, `(() => {
    const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
    return drawer?.getAttribute('data-state') === 'open' && !!drawer.querySelector('button[aria-label="关闭"]');
  })()`)
  if (!ready) return { ready: false, closed: false, animationEnd: false }

  await evaluate(cdp, sessionId, `(() => {
    window.__rl20DrawerCloseFinished = false;
    window.__rl20DrawerCloseRequested = true;
    document.querySelector('[data-testid="enterprise-drawer"] button[aria-label="关闭"]')?.click();
  })()`)
  const closed = await waitUntil(cdp, sessionId, `(() => {
    const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
    return !drawer || drawer.getAttribute('data-state') === 'closed';
  })()`)
  if (!closed) return { ready, closed: false, animationEnd: false }
  const animationEnd = await waitUntil(cdp, sessionId, `window.__rl20DrawerCloseFinished || !document.querySelector('[data-testid="enterprise-drawer"]')`)
  return { ready, closed, animationEnd }
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

function shadowViolation(m, label) {
  return m.shadowedTargets.length
    ? `${label}:内容区仍有阴影 ${JSON.stringify(m.shadowedTargets)}`
    : null
}

function statusRailViolation(m, label) {
  return m.statusRailWidth === 6
    ? null
    : `${label}:最左状态条应为 6px,实测 ${m.statusRailWidth}px`
}

function mobileCoreContentViolation(m, label) {
  if (m.innerWidth > 420) return null
  if (m.enterpriseMobileContent) {
    const { tableWidth, containerWidth, name, title, difference } = m.enterpriseMobileContent
    if (tableWidth > containerWidth + 1) return `${label}:企业列表窄屏表格仍需横向滚动(${tableWidth}px / ${containerWidth}px)`
    if (!name || name.display === 'none' || name.textOverflow === 'ellipsis' || name.scrollWidth > name.clientWidth) {
      return `${label}:企业列表窄屏企业名称被隐藏或截断 ${JSON.stringify(name)}`
    }
    if (!title || title.display === 'none' || !title.text || title.whiteSpace !== 'normal' || title.scrollWidth > title.clientWidth) {
      return `${label}:企业列表窄屏称号与认定年被隐藏或裁切 ${JSON.stringify(title)}`
    }
    if (!difference || difference.display === 'none' || !difference.text || difference.whiteSpace !== 'normal' || difference.scrollWidth > difference.clientWidth) {
      return `${label}:企业列表窄屏差异状态被隐藏或裁切 ${JSON.stringify(difference)}`
    }
  }
  if (m.comparisonMobileContent) {
    const { tableWidth, containerWidth, name, details } = m.comparisonMobileContent
    if (tableWidth > containerWidth + 1) return `${label}:对比页窄屏表格仍需横向滚动(${tableWidth}px / ${containerWidth}px)`
    if (!name || name.display === 'none' || name.textOverflow === 'ellipsis' || name.scrollWidth > name.clientWidth) {
      return `${label}:对比页窄屏企业名称被隐藏或截断 ${JSON.stringify(name)}`
    }
    if (!details || details.display === 'none' || details.whiteSpace !== 'normal' || !details.text || details.height < 1 || !details.hasStatus) {
      return `${label}:对比页窄屏首行未显示比对状态与解释 ${JSON.stringify(details)}`
    }
  }
  return null
}

function comparisonFiltersViolation(m, label) {
  const filters = m.comparisonFilters
  if (!filters) return `${label}:找不到对比页筛选栏`
  const outside = filters.controls.filter((control) => control.left < -1 || control.right > m.innerWidth + 1)
  const searchTooNarrow = m.innerWidth < 1024 && filters.searchWidth < filters.clientWidth * 0.9
  if (filters.scrollWidth > filters.clientWidth + 1 || outside.length || searchTooNarrow) {
    return `${label}:对比页筛选栏控件越界或窄屏搜索框未铺满 ${JSON.stringify({ filters, outside, searchTooNarrow })}`
  }
  return null
}

function comparisonDirectionValueViolation(m, label) {
  const direction = m.comparisonDirection
  if (!direction?.trigger || !direction.label) return `${label}:找不到当前比对方向`
  const value = direction.value
  if (!value || value.text !== direction.label || value.display === 'none' || value.clientWidth < 1 || value.scrollWidth > value.clientWidth + 1 || value.textOverflow === 'ellipsis') {
    return `${label}:当前比对方向文字被隐藏或裁切 ${JSON.stringify({ label: direction.label, value })}`
  }
  return null
}

function enterpriseDesktopDensityViolation(m, label) {
  if (m.innerWidth < 1024 || m.innerHeight < 800) return null
  const density = m.enterpriseDesktopDensity
  if (!density) return `${label}:找不到企业列表桌面表格滚动区或分页位置`
  if (density.visibleRows < 18) {
    return `${label}:企业列表桌面首屏不足 18 行(${density.visibleRows} 行可完整阅读)`
  }
  if (density.paginationBottom > m.innerHeight) {
    return `${label}:企业列表桌面分页不在首屏(${density.paginationBottom}px > ${m.innerHeight}px)`
  }
  return null
}

const EXPECTED_EASING = 'cubic-bezier(0.32,0.72,0,1)'
const normalizeEasing = (value) => String(value ?? '').replaceAll(/\s/g, '')

function motionCurveViolation(m, label) {
  const mismatches = Object.entries(m.motionCurves ?? {})
    .filter(([, value]) => value != null && normalizeEasing(value) !== EXPECTED_EASING)
    .map(([part, value]) => `${part}=${JSON.stringify(value)}`)
  return mismatches.length
    ? `${label}:核心动效未共用 --ease-snap(${mismatches.join(', ')})`
    : null
}

async function installMotionAndFetchGate(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(() => {
    window.__rl20Motion = { control: false, table: false, drawer: false };
    window.__rl20DrawerOpenMotion = null;
    window.__rl20DrawerCloseClicks = 0;
    window.__rl20DrawerCloseRequested = false;
    window.__rl20DrawerCloseFinished = false;
    document.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="enterprise-drawer"] button[aria-label="关闭"]')) window.__rl20DrawerCloseClicks++;
    }, true);
    document.addEventListener('transitionrun', (event) => {
      if (!['transform', 'translate', 'scale', 'rotate'].includes(event.propertyName)) return;
      if (event.target.matches('button,[data-slot="select-trigger"]')) window.__rl20Motion.control = true;
      if (event.target.tagName === 'TBODY') window.__rl20Motion.table = true;
    }, true);
    document.addEventListener('animationstart', (event) => {
      const drawer = event.target;
      if (!drawer.matches('[data-testid="enterprise-drawer"]') || drawer.getAttribute('data-state') !== 'open') return;
      const left = drawer.getBoundingClientRect().left;
      const motion = {
        started: true,
        ended: false,
        state: 'open',
        animationName: event.animationName,
        startLeft: left,
        endLeft: null,
        minLeft: left,
        maxLeft: left,
        samples: 0,
      };
      window.__rl20DrawerOpenMotion = motion;
      window.__rl20Motion.drawer = true;
      const sample = () => {
        const current = window.__rl20DrawerOpenMotion;
        const liveDrawer = document.querySelector('[data-testid="enterprise-drawer"]');
        if (!current?.started || current.ended || liveDrawer?.getAttribute('data-state') !== 'open') return;
        const sampleLeft = liveDrawer.getBoundingClientRect().left;
        current.samples++;
        current.minLeft = Math.min(current.minLeft, sampleLeft);
        current.maxLeft = Math.max(current.maxLeft, sampleLeft);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, true);
    document.addEventListener('animationend', (event) => {
      const drawer = event.target;
      if (!drawer.matches('[data-testid="enterprise-drawer"]')) return;
      if (drawer.getAttribute('data-state') === 'open') {
        const motion = window.__rl20DrawerOpenMotion;
        if (motion?.started && motion.animationName === event.animationName) {
          motion.endLeft = drawer.getBoundingClientRect().left;
          motion.minLeft = Math.min(motion.minLeft, motion.endLeft);
          motion.maxLeft = Math.max(motion.maxLeft, motion.endLeft);
          motion.samples++;
          motion.ended = true;
          motion.state = 'open';
        }
      }
      if (drawer.getAttribute('data-state') === 'closed' && window.__rl20DrawerCloseRequested) {
        window.__rl20DrawerCloseFinished = true;
        window.__rl20DrawerCloseRequested = false;
      }
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
  const statusSelector = {
    ledger: '[data-testid="ledger-loading-status"]',
    comparison: '[data-testid="comparison-loading-status"]',
    files: '[data-testid="files-loading-status"]',
  }[pageKind]
  const bodySelector = pageKind === 'files' ? 'tbody[data-loading="true"]' : 'tbody[data-loading="true"]'
  const expression = `(() => {
    const status = document.querySelector(${JSON.stringify(statusSelector)});
    const gate = window.__rl20FetchGate;
    return !!gate?.requested && (status?.textContent ?? '').includes('正在') && !!document.querySelector(${JSON.stringify(bodySelector)});
  })()`
  return waitUntil(cdp, sessionId, expression)
}

async function verifyLoadingEasing(cdp, sessionId, selector, label) {
  const timing = await evaluate(cdp, sessionId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return el ? getComputedStyle(el).animationTimingFunction : null;
  })()`)
  if (normalizeEasing(timing) !== EXPECTED_EASING) {
    bad(`${label}:进度线应使用 --ease-snap,实测 ${JSON.stringify(timing)}`)
  } else {
    ok(`${label}:进度线与基本动效共用 --ease-snap`)
  }
}

async function verifyLedgerSearchLoading(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0])
  const { targetId, sessionId } = page
  try {
    await installMotionAndFetchGate(cdp, sessionId)
    const name = await evaluate(cdp, sessionId, `(() => {
      const names = [...document.querySelectorAll('tbody tr button')].map((el) => (el.textContent ?? '').trim()).filter(Boolean);
      return names.at(-1) ?? '';
    })()`)
    if (!name) {
      bad('企业列表 · 搜索:初始结果没有可搜索的企业名称')
      return
    }

    const drawerClose = await closeEnterpriseDrawer(cdp, sessionId)
    if (!drawerClose.ready || !drawerClose.closed || !drawerClose.animationEnd) {
      bad(`企业列表 · 搜索:筛选前没有完成抽屉关闭动画 ${JSON.stringify(drawerClose)}`)
      return
    }

    await startFetchGate(cdp, sessionId, '/api/roster/enterprises?')
    await setInputValue(cdp, sessionId, 'input[aria-label*="企业名称"]', name)
    const searchLoading = await waitForLoadingEvidence(cdp, sessionId, 'ledger')
    if (!searchLoading) bad('企业列表 · 搜索:请求期间没有可见加载状态')
    else ok('企业列表 · 搜索:请求期间显示加载状态')
    await finishFetchGate(cdp, sessionId)
    const searchIdle = await waitUntil(cdp, sessionId, `(() => {
      const status = document.querySelector('[data-testid="ledger-loading-status"]');
      const rows = [...document.querySelectorAll('tbody tr')];
      const match = rows.find((tr) => tr.querySelector('button')?.textContent?.trim() === ${JSON.stringify(name)});
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      const title = drawer?.querySelector('h2')?.textContent?.trim();
      return !(status?.textContent ?? '').includes('正在') && rows.length === 1 && !!match &&
        match.getAttribute('aria-current') === 'true' && drawer?.getAttribute('data-state') === 'open' && title === ${JSON.stringify(name)};
    })()`)
    if (!searchIdle) {
      const state = await evaluate(cdp, sessionId, `(() => ({
        input: document.querySelector('input[aria-label*="企业名称"]')?.value,
        status: document.querySelector('[data-testid="ledger-loading-status"]')?.textContent,
        rows: [...document.querySelectorAll('tbody tr')].map((tr) => ({ name: tr.querySelector('button')?.textContent?.trim(), selected: tr.getAttribute('aria-current') })),
        drawer: (() => { const el = document.querySelector('[data-testid="enterprise-drawer"]'); return el && { state: el.getAttribute('data-state'), title: el.querySelector('h2')?.textContent?.trim() }; })(),
        url: location.href,
      }))()`)
      bad(`企业列表 · 搜索:当前结果落定后,选中行与抽屉没有同步到唯一匹配企业 ${JSON.stringify(state)}`)
    }
    else ok(`企业列表 · 搜索:结果落定后抽屉同步到 ${JSON.stringify(name)}`)

    const emptyQuery = 'RL20无匹配企业校验'
    await setInputValue(cdp, sessionId, 'input[aria-label*="企业名称"]', emptyQuery)
    const emptyIdle = await waitUntil(cdp, sessionId, `(() => {
      const status = document.querySelector('[data-testid="ledger-loading-status"]');
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return !(status?.textContent ?? '').includes('正在') &&
        ![...document.querySelectorAll('tbody tr button[title]')].length &&
        ![...document.querySelectorAll('tbody tr[aria-current="true"]')].length &&
        (!drawer || drawer.getAttribute('data-state') === 'closed');
    })()`)
    if (!emptyIdle) {
      const state = await evaluate(cdp, sessionId, `(() => ({
        input: document.querySelector('input[aria-label*="企业名称"]')?.value,
        status: document.querySelector('[data-testid="ledger-loading-status"]')?.textContent,
        rows: [...document.querySelectorAll('tbody tr')].map((tr) => ({ name: tr.querySelector('button')?.textContent?.trim(), selected: tr.getAttribute('aria-current') })),
        drawer: (() => { const el = document.querySelector('[data-testid="enterprise-drawer"]'); return el && { state: el.getAttribute('data-state'), title: el.querySelector('h2')?.textContent?.trim() }; })(),
        url: location.href,
      }))()`)
      bad(`企业列表 · 搜索:空结果落定后没有清除抽屉选择 ${JSON.stringify(state)}`)
    }
    else ok('企业列表 · 搜索:空结果落定后清除选中行与抽屉')
  } finally {
    await finishFetchGate(cdp, sessionId).catch(() => {})
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function verifyLedgerMobileLoadingOverflow(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[1])
  const { targetId, sessionId } = page
  try {
    await installMotionAndFetchGate(cdp, sessionId)
    const name = await evaluate(cdp, sessionId, `document.querySelector('tbody tr button')?.textContent?.trim() ?? ''`)
    if (!name) {
      bad('企业列表 · 窄屏加载:初始结果没有可筛选的企业名称')
      return
    }

    const drawerClose = await closeEnterpriseDrawer(cdp, sessionId)
    if (!drawerClose.ready || !drawerClose.closed || !drawerClose.animationEnd) {
      bad(`企业列表 · 窄屏加载:筛选前没有完成抽屉关闭动画 ${JSON.stringify(drawerClose)}`)
      return
    }

    await startFetchGate(cdp, sessionId, '/api/roster/enterprises?')
    await setInputValue(cdp, sessionId, 'input[aria-label*="企业名称"]', name)
    const loading = await waitForLoadingEvidence(cdp, sessionId, 'ledger')
    if (!loading) {
      bad('企业列表 · 窄屏加载:没有进入真实请求中的加载状态')
      return
    }

    const measurement = await evaluate(cdp, sessionId, `(() => {
      const scroller = document.querySelector('[data-testid="enterprise-table-scroll"]');
      const table = scroller?.querySelector('table');
      const skeletonRow = [...(scroller?.querySelectorAll('tbody tr') ?? [])]
        .find((row) => row.querySelector('[data-slot="skeleton"]'));
      return {
        clientWidth: scroller?.clientWidth ?? 0,
        scrollWidth: scroller?.scrollWidth ?? 0,
        tableWidth: Math.round(table?.getBoundingClientRect().width ?? 0),
        loading: scroller?.querySelector('tbody')?.getAttribute('data-loading') === 'true',
        skeletonCells: [...(skeletonRow?.querySelectorAll('td') ?? [])].map((cell) => ({
          display: getComputedStyle(cell).display,
          width: Math.round(cell.getBoundingClientRect().width),
        })),
      };
    })()`)
    if (!measurement.loading || measurement.skeletonCells.length !== 6) {
      bad(`企业列表 · 窄屏加载:没有量到六格加载行 ${JSON.stringify(measurement)}`)
    }
    if (measurement.scrollWidth > measurement.clientWidth + 1) {
      bad(`企业列表 · 窄屏加载:表格容器仍可横向滚动(${measurement.scrollWidth}px / ${measurement.clientWidth}px) ${JSON.stringify(measurement)}`)
    } else {
      ok(`企业列表 · 窄屏加载:表格与骨架不横向溢出(${measurement.scrollWidth}px ≤ ${measurement.clientWidth}px)`)
    }
    if (measurement.skeletonCells[2]?.display !== 'none' || measurement.skeletonCells[3]?.display !== 'none') {
      bad(`企业列表 · 窄屏加载:统一代码与属地骨架列应隐藏 ${JSON.stringify(measurement.skeletonCells)}`)
    } else {
      ok('企业列表 · 窄屏加载:统一代码与属地骨架列随正文列一同隐藏')
    }

    // 注入同类表内溢出，确认上面的新断言能抓住移动加载行回归。
    await evaluate(cdp, sessionId, `(() => {
      const table = document.querySelector('[data-testid="enterprise-table-scroll"] table');
      table?.style.setProperty('min-width', '500px', 'important');
    })()`)
    const brokenWidth = await evaluate(cdp, sessionId, `(() => {
      const scroller = document.querySelector('[data-testid="enterprise-table-scroll"]');
      return { clientWidth: scroller?.clientWidth ?? 0, scrollWidth: scroller?.scrollWidth ?? 0 };
    })()`)
    if (brokenWidth.scrollWidth <= brokenWidth.clientWidth + 1) {
      bad(`企业列表 · 窄屏加载缺陷自检:注入骨架宽度后仍未检出 ${JSON.stringify(brokenWidth)}`)
    } else {
      console.log(`✗ 企业列表 · 窄屏加载缺陷自检按预期变红:表格容器横向滚动 ${brokenWidth.scrollWidth}px / ${brokenWidth.clientWidth}px`)
      ok('企业列表 · 窄屏加载缺陷自检:关闭临时 target 后缺陷已复原')
    }
  } finally {
    await finishFetchGate(cdp, sessionId).catch(() => {})
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function verifyLedgerDrawerAsyncClose(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[1])
  const { targetId, sessionId } = page
  try {
    await installMotionAndFetchGate(cdp, sessionId)
    const names = await evaluate(cdp, sessionId, `[
      ...new Set([...document.querySelectorAll('tbody tr:not([aria-current="true"]) button')]
        .map((button) => (button.textContent ?? '').trim()).filter(Boolean))
    ].slice(0, 2)`)
    if (names.length < 2) {
      bad(`企业列表 · 窄屏抽屉:至少需要两家企业来检查加载与失败状态 ${JSON.stringify(names)}`)
      return
    }

    const initialClose = await closeEnterpriseDrawer(cdp, sessionId)
    if (!initialClose.ready || !initialClose.closed || !initialClose.animationEnd) {
      bad(`企业列表 · 窄屏抽屉:打开异步状态前无法收起默认详情抽屉 ${JSON.stringify(initialClose)}`)
      return
    }

    await startFetchGate(cdp, sessionId, '/api/roster/enterprises/')
    await clickElementContaining(cdp, sessionId, 'tbody tr button', names[0])
    const loadingReady = await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return window.__rl20FetchGate?.requested && drawer?.getAttribute('data-state') === 'open' &&
        window.__rl20DrawerOpenMotion?.ended === true &&
        !!drawer.querySelector('[data-slot="skeleton"]') && !!drawer.querySelector('button[aria-label="关闭"]');
    })()`)
    if (!loadingReady) {
      const state = await evaluate(cdp, sessionId, `(() => ({
        gate: { requested: window.__rl20FetchGate?.requested, releases: window.__rl20FetchGate?.releases.length },
        rows: [...document.querySelectorAll('tbody tr')].map((row) => ({ name: row.querySelector('button')?.textContent?.trim(), selected: row.getAttribute('aria-current') })),
        drawer: (() => { const el = document.querySelector('[data-testid="enterprise-drawer"]'); return el && { state: el.getAttribute('data-state'), text: el.textContent?.slice(0, 120), skeleton: !!el.querySelector('[data-slot="skeleton"]'), close: !!el.querySelector('button[aria-label="关闭"]') }; })(),
      }))()`)
      bad(`企业列表 · 窄屏抽屉:详情请求挂起时没有可观察到带关闭按钮的加载态 ${JSON.stringify(state)}`)
      return
    }
    const loadingClose = await evaluate(cdp, sessionId, `(() => {
      const button = document.querySelector('[data-testid="enterprise-drawer"] button[aria-label="关闭"]');
      const rect = button?.getBoundingClientRect();
      const style = button ? getComputedStyle(button) : null;
      return !!button && !!rect && style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width >= 24 && rect.height >= 24 && rect.left >= 0 && rect.right <= innerWidth &&
        rect.top >= 0 && rect.bottom <= innerHeight;
    })()`)
    if (!loadingClose) bad('企业列表 · 窄屏抽屉:加载态关闭按钮不在 390px 视口内或不可见')
    else ok('企业列表 · 窄屏抽屉:390px 加载态关闭按钮完整可见')

    const loadingCloseResult = await closeEnterpriseDrawer(cdp, sessionId)
    const loadingCloseClicks = await evaluate(cdp, sessionId, 'window.__rl20DrawerCloseClicks')
    if (!loadingCloseResult.ready || !loadingCloseResult.closed || !loadingCloseResult.animationEnd || loadingCloseClicks < 1) {
      bad(`企业列表 · 窄屏抽屉:加载态关闭按钮未能完成关闭(${JSON.stringify(loadingCloseResult)},${loadingCloseClicks} 次点击)`)
    }
    else ok('企业列表 · 窄屏抽屉:详情加载未完成时可直接关闭')
    await finishFetchGate(cdp, sessionId)

    await evaluate(cdp, sessionId, 'window.__rl20DrawerOpenMotion = null')
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Network.setBlockedURLs', { urls: [`${BASE}/api/roster/enterprises/*`] }, sessionId)
    await clickElementContaining(cdp, sessionId, 'tbody tr button', names[1])
    const errorReady = await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return drawer?.getAttribute('data-state') === 'open' &&
        window.__rl20DrawerOpenMotion?.ended === true &&
        (drawer.querySelector('p.text-destructive')?.textContent ?? '').includes('未能加载') &&
        !!drawer.querySelector('button[aria-label="关闭"]');
    })()`)
    if (!errorReady) {
      const state = await evaluate(cdp, sessionId, `(() => {
        const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
        return {
          drawer: drawer && { state: drawer.getAttribute('data-state'), text: drawer.textContent?.slice(0, 160), close: !!drawer.querySelector('button[aria-label="关闭"]') },
          selected: [...document.querySelectorAll('tbody tr[aria-current="true"] button')].map((button) => button.textContent?.trim()),
        };
      })()`)
      bad(`企业列表 · 窄屏抽屉:详情失败后没有带关闭按钮的错误态 ${JSON.stringify(state)}`)
      return
    }
    await cdp.send('Network.setBlockedURLs', { urls: [] }, sessionId)
    const errorClose = await evaluate(cdp, sessionId, `(() => {
      const button = document.querySelector('[data-testid="enterprise-drawer"] button[aria-label="关闭"]');
      const rect = button?.getBoundingClientRect();
      const style = button ? getComputedStyle(button) : null;
      return !!button && !!rect && style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width >= 24 && rect.height >= 24 && rect.left >= 0 && rect.right <= innerWidth &&
        rect.top >= 0 && rect.bottom <= innerHeight;
    })()`)
    if (!errorClose) bad('企业列表 · 窄屏抽屉:错误态关闭按钮不在 390px 视口内或不可见')
    else ok('企业列表 · 窄屏抽屉:390px 错误态关闭按钮完整可见')

    const errorCloseResult = await closeEnterpriseDrawer(cdp, sessionId)
    const totalCloseClicks = await evaluate(cdp, sessionId, 'window.__rl20DrawerCloseClicks')
    if (!errorCloseResult.ready || !errorCloseResult.closed || !errorCloseResult.animationEnd || totalCloseClicks < 2) {
      bad(`企业列表 · 窄屏抽屉:错误态关闭按钮未能完成关闭(${JSON.stringify(errorCloseResult)},${totalCloseClicks} 次点击)`)
    }
    else ok('企业列表 · 窄屏抽屉:详情加载失败时可直接关闭')
  } finally {
    await finishFetchGate(cdp, sessionId).catch(() => {})
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function verifyMissingRecognitionYearAndEvidence(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0])
  const { targetId, sessionId } = page
  try {
    const target = await evaluate(cdp, sessionId, `fetch('/api/roster/enterprises/157').then((r) => r.json()).then((detail) => {
      const missing = detail.enterprise.titles.filter((code) => !detail.enterprise.firstRecognition.some((item) => item.titleCode === code));
      return { name: detail.enterprise.name, missing };
    })`)
    if (!target.name || !target.missing.length) {
      bad(`企业列表 · 称号与出处:企业 157 不再包含无认定年称号,无法核验年待核显示 ${JSON.stringify(target)}`)
      return
    }

    await setInputValue(cdp, sessionId, 'input[aria-label*="企业名称"]', target.name)
    const visible = await waitUntil(cdp, sessionId, `(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('button')?.textContent?.trim() === ${JSON.stringify(target.name)});
      return row?.querySelector('[data-testid="title-recognition-cell"]')?.textContent?.includes('年待核') ?? false;
    })()`)
    if (!visible) {
      bad(`企业列表 · 称号与出处:企业 ${JSON.stringify(target.name)} 的无认定年称号没有显示「年待核」`)
      return
    }
    ok(`企业列表 · 称号:企业 ${JSON.stringify(target.name)} 的无认定年称号保留并显示「年待核」`)

    await evaluate(cdp, sessionId, `(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('button')?.textContent?.trim() === ${JSON.stringify(target.name)});
      row?.querySelector('button')?.click();
    })()`)
    const drawerReady = await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return drawer?.getAttribute('data-state') === 'open' && !!drawer.querySelector('[data-testid="enterprise-evidence"]');
    })()`)
    if (!drawerReady) {
      bad('企业列表 · 出处:企业 157 抽屉未渲染出处区')
      return
    }
    await evaluate(cdp, sessionId, `document.querySelector('[data-testid="enterprise-evidence"] summary')?.click()`)
    const pageSlot = await evaluate(cdp, sessionId, `document.querySelector('[data-testid="enterprise-evidence"]')?.textContent?.includes('页码') ?? false`)
    if (!pageSlot) bad('企业列表 · 出处:出处条目没有保留页码字段')
    else ok('企业列表 · 出处:出处条目保留页码字段,RL-10 可接入页码跳转')
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function verifyCurrentNameAliasDisplay(cdp) {
  const samples = [
    { enterpriseId: 987, name: '宁波芯速联光电科技有限公司' },
    { enterpriseId: 1207, name: '宁波九纵智能科技有限公司' },
  ]

  for (const sample of samples) {
    const page = await openSession(
      cdp,
      `${BASE}/?q=${encodeURIComponent(sample.name)}`,
      VIEWPORTS[0],
    )
    const { targetId, sessionId } = page
    try {
      const rawAliasNames = await evaluate(cdp, sessionId, `fetch('/api/roster/enterprises/${sample.enterpriseId}')
        .then((response) => response.json())
        .then((detail) => detail.enterprise.aliasNames)`)
      if (!rawAliasNames.includes(sample.name)) {
        bad(`企业列表 · 曾用名:企业 ${sample.enterpriseId} 的真实接口数据不再包含与现名相同的 confirmed 别名 ${JSON.stringify(rawAliasNames)}`)
      } else {
        ok(`企业列表 · 曾用名:企业 ${sample.enterpriseId} 的接口仍保留原始 confirmed 别名`)
      }

      const listState = await evaluate(cdp, sessionId, `(() => {
        const row = [...document.querySelectorAll('tbody tr')]
          .find((item) => item.querySelector('td:nth-child(2) button')?.textContent?.trim() === ${JSON.stringify(sample.name)});
        return row ? {
          aliases: [...row.querySelectorAll('td:nth-child(2) [title^="曾用名:"]')]
            .map((item) => (item.textContent ?? '').trim()),
        } : null;
      })()`)
      if (!listState) {
        bad(`企业列表 · 曾用名:搜索不到企业 ${sample.enterpriseId} ${JSON.stringify(sample.name)}`)
        continue
      }
      if (listState.aliases.includes(`原 ${sample.name}`)) {
        bad(`企业列表 · 曾用名:列表把企业 ${sample.enterpriseId} 的现名显示成曾用名 ${JSON.stringify(listState.aliases)}`)
      } else {
        ok(`企业列表 · 曾用名:企业 ${sample.enterpriseId} 不把现名显示成曾用名`)
      }

      const detailReady = await waitUntil(cdp, sessionId, `(() => {
        const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
        return drawer?.getAttribute('data-state') === 'open' &&
          drawer.querySelector('h2')?.textContent?.trim() === ${JSON.stringify(sample.name)} &&
          !drawer.querySelector('[data-slot="skeleton"]');
      })()`)
      if (!detailReady) {
        const drawerState = await evaluate(cdp, sessionId, `(() => {
          const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
          return drawer && {
            state: drawer.getAttribute('data-state'),
            title: drawer.querySelector('h2')?.textContent?.trim(),
            skeletons: drawer.querySelectorAll('[data-slot="skeleton"]').length,
            error: drawer.querySelector('.text-destructive')?.textContent?.trim(),
          };
        })()`)
        bad(`企业列表 · 曾用名:企业 ${sample.enterpriseId} 的详情抽屉没有加载完成 ${JSON.stringify(drawerState)}`)
        continue
      }

      const drawerAliasText = await evaluate(cdp, sessionId, `(() => {
        const values = document.querySelector('[data-testid="enterprise-drawer"] dl')?.querySelectorAll('dd');
        return (values?.[1]?.textContent ?? '').trim();
      })()`)
      const drawerAliasNames = drawerAliasText === '—' ? [] : drawerAliasText.split('、')
      if (drawerAliasNames.includes(sample.name)) {
        bad(`企业列表 · 曾用名:抽屉把企业 ${sample.enterpriseId} 的现名显示成曾用名 ${JSON.stringify(drawerAliasNames)}`)
      } else {
        ok(`企业列表 · 曾用名:企业 ${sample.enterpriseId} 的抽屉不把现名显示成曾用名`)
      }
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    }
  }
}

async function verifyKaichengExample(cdp) {
  const name = '宁波开诚生态技术股份有限公司'
  const page = await openSession(
    cdp,
    `${BASE}/?q=${encodeURIComponent(name)}`,
    VIEWPORTS[0],
    `(() => {
      const status = document.querySelector('[data-testid="ledger-loading-status"]');
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return !(status?.textContent ?? '').includes('正在') &&
        drawer?.getAttribute('data-state') === 'open' && drawer.querySelector('h2')?.textContent?.trim() === ${JSON.stringify(name)};
    })()`,
  )
  const { targetId, sessionId } = page
  try {
    const example = await evaluate(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      const row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('button')?.textContent?.trim() === ${JSON.stringify(name)});
      const headings = [...drawer.querySelectorAll('h3')];
      const history = headings.find((el) => el.textContent?.trim() === '称号历史')?.nextElementSibling;
      const chain = drawer.querySelector('[data-testid="difference-reason-chain"]');
      const years = history ? [...history.querySelectorAll(':scope > li > span:first-child')].map((el) => el.textContent?.trim()).filter(Boolean) : [];
      const historyRows = history ? [...history.querySelectorAll(':scope > li')].map((li) =>
        [...li.children].at(-1)?.textContent?.replace(/\\s+/g, ' ').trim() ?? '') : [];
      const chainLayout = chain ? [...chain.querySelectorAll(':scope > li')].map((li) => {
        const [label, connector, value] = [...li.children];
        const dot = connector?.querySelector('span.rounded-full');
        const dotRect = dot?.getBoundingClientRect();
        return {
          labelLeft: label?.getBoundingClientRect().left ?? null,
          valueLeft: value?.getBoundingClientRect().left ?? null,
          connectorCenter: dotRect ? dotRect.left + dotRect.width / 2 : null,
        };
      }) : [];
      return {
        rowCount: [...document.querySelectorAll('tbody tr button')].length,
        selected: row?.getAttribute('aria-current'),
        uscc: drawer.querySelector('header p')?.textContent?.trim(),
        alias: drawer.textContent?.includes('宁波开诚生态技术有限公司') ?? false,
        years,
        historyRows,
        historyText: history?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        chainText: chain?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        chainSteps: chain?.querySelectorAll(':scope > li').length ?? 0,
        chainLayout,
      };
    })()`)
    const expectedEvents = [
      '专精特新中小企业认定',
      '创新型中小企业认定',
      '专精特新中小企业维持',
      '创新型中小企业维持',
      '专精特新“小巨人”认定',
      '专精特新“小巨人”维持',
    ]
    const valueStarts = example.chainLayout.map((item) => item.valueLeft)
    const connectorGaps = example.chainLayout.map((item) => item.valueLeft - item.connectorCenter)
    const chainAligned = valueStarts.length === 3 &&
      Math.max(...valueStarts) - Math.min(...valueStarts) <= 1 &&
      Math.min(...connectorGaps) >= 12
    const okExample = example.rowCount === 1 && example.selected === 'true' &&
      example.uscc === '9133021274738281XA' && example.alias &&
      ['2021', '2022', '2024'].every((year) => example.years.includes(year)) &&
      example.years.filter((year) => year === '2024').length === 1 &&
      example.historyRows.length === 6 && expectedEvents.every((event) => example.historyRows.some((line) => line.includes(event))) &&
      example.chainSteps === 3 && ['方向', '原因', '措施', '平台多出', '平台未更新', '标记平台快照'].every((value) => example.chainText.includes(value))
      && chainAligned
    if (!okExample) {
      bad(`企业列表 · 开诚示例:真实事件链、原因措施链或连接对齐未完整呈现 ${JSON.stringify(example)}`)
    } else {
      ok(`企业列表 · 开诚示例:六条真实事件、原因措施链与连接对齐通过(${JSON.stringify({ historyRows: example.historyRows.length, yearLabels: example.years, connectorGaps })})`)
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function verifyUnknownReviewOutcomeExample(cdp) {
  const name = '东毓(宁波)油压工业有限公司'
  const page = await openSession(
    cdp,
    `${BASE}/?q=${encodeURIComponent(name)}&expand=358`,
    VIEWPORTS[0],
    `(() => {
      const status = document.querySelector('[data-testid="ledger-loading-status"]');
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return !(status?.textContent ?? '').includes('正在') &&
        drawer?.getAttribute('data-state') === 'open' && drawer.querySelector('h2')?.textContent?.trim() === ${JSON.stringify(name)};
    })()`,
  )
  const { targetId, sessionId } = page
  try {
    const reviewLine = await evaluate(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      const history = [...drawer.querySelectorAll('h3')].find((el) => el.textContent?.trim() === '称号历史')?.nextElementSibling;
      return history ? [...history.querySelectorAll(':scope > li')].map((li) => li.textContent?.replace(/\\s+/g, ' ').trim() ?? '')
        .find((line) => line.includes('复核')) ?? null : null;
    })()`)
    if (!reviewLine?.includes('结论待核') || !reviewLine.includes('原认定 2025') || !reviewLine.includes('结论年份待核')) {
      bad(`企业列表 · 复核事件:真实未知结论或原认定年份未显示 ${JSON.stringify(reviewLine)}`)
    } else {
      ok(`企业列表 · 复核事件:真实未知结论、原认定年份与待核年份均可见(${JSON.stringify(reviewLine)})`)
    }
  } finally {
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
      if (loading) await verifyLoadingEasing(cdp, sessionId, '.ledger-progress', '企业列表 · 加载')
      const motion = await waitUntil(cdp, sessionId, 'window.__rl20Motion.control && window.__rl20Motion.table')
      if (!motion) bad('企业列表 · 排序:没有观察到控件反馈和表体位移动效事件')
      else ok('企业列表 · 控件与表体:transitionrun 事件均已观察')
      await finishFetchGate(cdp, sessionId)
      const idle = await waitUntil(cdp, sessionId, `(() => document.querySelector('tbody')?.dataset.loading !== 'true' && !(document.querySelector('[data-testid="ledger-loading-status"]')?.textContent ?? '').includes('正在'))()`)
      if (!idle) bad('企业列表 · 排序:释放请求后加载状态没有收敛')
    }

    // 翻页:同一张表应显示与筛选、排序相同的加载提示。
    // 右侧抽屉按方向卡覆盖表格,先收起它,否则分页按钮被面板覆盖会点到后面的详情链接。
    const drawerReadyForPaging = await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return drawer?.getAttribute('data-state') === 'open' && !!drawer.querySelector('button[aria-label="关闭"]');
    })()`)
    if (!drawerReadyForPaging) bad('企业列表 · 翻页:排序结果落定后没有可收起的侧边抽屉')
    const drawerClose = await closeEnterpriseDrawer(cdp, sessionId)
    if (!drawerClose.ready || !drawerClose.closed || !drawerClose.animationEnd) {
      bad(`企业列表 · 翻页:翻页前无法收起侧边抽屉并等到退出动画结束 ${JSON.stringify(drawerClose)}`)
      return
    }
    ok('企业列表 · 翻页:抽屉退出动画 animationend 后再触发分页')
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

    // 抽屉:只记录 data-state=open 的入场动画,并比较首尾位置,关闭动画不能冒充滑入。
    const drawerReadyForMotion = await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return drawer?.getAttribute('data-state') === 'open' && !!drawer.querySelector('button[aria-label="关闭"]');
    })()`)
    if (!drawerReadyForMotion) bad('企业列表 · 抽屉:翻页结果落定后没有抽屉可供关闭与重开')
    const drawerCloseAfterPaging = await closeEnterpriseDrawer(cdp, sessionId)
    if (!drawerCloseAfterPaging.ready || !drawerCloseAfterPaging.closed || !drawerCloseAfterPaging.animationEnd) {
      bad(`企业列表 · 抽屉:退出动画未完成 ${JSON.stringify(drawerCloseAfterPaging)}`)
    }
    else {
      await evaluate(cdp, sessionId, `(() => {
        window.__rl20Motion.drawer = false;
        window.__rl20DrawerOpenMotion = null;
        document.querySelector('tbody tr button')?.click();
      })()`)
      const drawerMotionEnded = await waitUntil(cdp, sessionId, 'window.__rl20DrawerOpenMotion?.ended === true')
      const drawerMotion = await evaluate(cdp, sessionId, 'window.__rl20DrawerOpenMotion')
      if (!drawerMotionEnded || drawerMotion?.state !== 'open' || !drawerMotion.animationName ||
        !Number.isFinite(drawerMotion.startLeft) || !Number.isFinite(drawerMotion.endLeft) ||
        drawerMotion.startLeft - drawerMotion.endLeft < 4 || drawerMotion.samples < 2) {
        bad(`企业列表 · 抽屉:未观察到打开态从右侧滑入的实际位移 ${JSON.stringify(drawerMotion)}`)
      } else {
        ok(`企业列表 · 抽屉:打开态动画 ${drawerMotion.animationName} 首尾位移 ${Math.round(drawerMotion.startLeft - drawerMotion.endLeft)}px,采样 ${drawerMotion.samples} 帧`)
      }
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
    await clickSelector(cdp, sessionId, '[data-testid="reconcile-status-trigger"]')
    const tooltipReady = await waitUntil(cdp, sessionId, `(() => {
      const tooltip = document.querySelector('[data-slot="tooltip-content"]');
      return !!tooltip && getComputedStyle(tooltip).visibility !== 'hidden' && tooltip.getBoundingClientRect().height > 0;
    })()`)
    if (!tooltipReady) {
      bad('两侧名录比对 · 原因字号:点击状态后没有打开原因浮层')
    } else {
      const typography = await evaluate(cdp, sessionId, `(() => {
        const tooltip = document.querySelector('[data-slot="tooltip-content"]');
        return {
          paragraphs: [...(tooltip?.querySelectorAll('p') ?? [])].map((paragraph) => ({
            text: (paragraph.textContent ?? '').trim(),
            fontSize: Number.parseFloat(getComputedStyle(paragraph).fontSize),
            lineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
          })),
        };
      })()`)
      const tooSmall = typography.paragraphs.filter((paragraph) => paragraph.fontSize < 13 || paragraph.lineHeight < 19)
      if (!typography.paragraphs.length || tooSmall.length) {
        bad(`两侧名录比对 · 原因字号:浮层正文应不小于 13px 且行高至少 19px ${JSON.stringify(typography)}`)
      } else {
        ok(`两侧名录比对 · 原因字号:${typography.paragraphs.length} 段浮层正文均为 ≥13px / ≥19px`)
      }
    }
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
    if (searchLoading) await verifyLoadingEasing(cdp, sessionId, '.comparison-progress', '两侧名录比对 · 加载')
    await finishFetchGate(cdp, sessionId)
    const searched = await waitUntil(cdp, sessionId, `(() => {
      const status = document.querySelector('[data-testid="comparison-loading-status"]');
      const rows = [...document.querySelectorAll('tbody tr a')].map((el) => (el.textContent ?? '').trim());
      return !(status?.textContent ?? '').includes('正在') && rows.some((row) => row === ${JSON.stringify(name)});
    })()`)
    if (!searched) bad(`两侧名录比对 · 搜索:输入「${name}」后没有返回匹配企业`)
    else ok(`两侧名录比对 · 搜索:名称筛选返回 ${JSON.stringify(name)}`)

    const emptyQuery = 'RL20空筛选验证-不存在'
    await setInputValue(cdp, sessionId, 'input[aria-label*="企业名称"]', emptyQuery)
    const emptyState = await waitUntil(cdp, sessionId, `(() => {
      const status = document.querySelector('[data-testid="comparison-loading-status"]');
      const rows = document.querySelectorAll('tbody tr');
      const title = document.querySelector('[data-slot="empty-title"]')?.textContent?.trim();
      const description = document.querySelector('[data-slot="empty-description"]')?.textContent?.trim();
      return !(status?.textContent ?? '').includes('正在') && rows.length === 0 &&
        title === '没有匹配的企业' && description === '当前筛选条件下没有匹配结果。';
    })()`)
    if (!emptyState) {
      const state = await evaluate(cdp, sessionId, `(() => ({
        status: document.querySelector('[data-testid="comparison-loading-status"]')?.textContent,
        rows: document.querySelectorAll('tbody tr').length,
        title: document.querySelector('[data-slot="empty-title"]')?.textContent?.trim(),
        description: document.querySelector('[data-slot="empty-description"]')?.textContent?.trim(),
      }))()`)
      bad(`两侧名录比对 · 空筛选:零匹配时的空状态不准确 ${JSON.stringify(state)}`)
    } else ok('两侧名录比对 · 空筛选:零匹配结果使用准确的空状态文案')

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
    const directionFilter = await evaluate(cdp, sessionId, `(() => {
      const wrapper = document.querySelector('[data-testid="comparison-direction-filter"]');
      const trigger = wrapper?.querySelector('[role="combobox"]');
      return { trigger: !!trigger, label: trigger?.textContent?.trim() ?? '' };
    })()`)
    if (!directionFilter.trigger || !directionFilter.label) {
      bad(`两侧名录比对 · 方向筛选:控件未使用项目 Select ${JSON.stringify(directionFilter)}`)
    } else {
      await clickSelector(cdp, sessionId, '[data-testid="comparison-direction-filter"] [role="combobox"]')
      const optionReady = await waitUntil(cdp, sessionId, `(() => [...document.querySelectorAll('[role="option"]')].some((el) => (el.textContent ?? '').includes('应出未出')))()`)
      if (!optionReady) bad('两侧名录比对 · 方向筛选:Select 中没有「应出未出」选项')
      await clickElementContaining(cdp, sessionId, '[role="option"]', '应出未出')
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

async function verifyCustomPageSizeInputShadow(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0])
  const { targetId, sessionId } = page
  try {
    await clickSelector(cdp, sessionId, '[role="combobox"][aria-label="每页条数"]')
    const customOption = await waitUntil(cdp, sessionId, `(() => [...document.querySelectorAll('[role="option"]')].some((el) => (el.textContent ?? '').includes('自定义')))()`)
    if (!customOption) {
      bad('企业列表 · 自定义每页:Select 中没有「自定义」选项')
      return
    }
    await clickElementContaining(cdp, sessionId, '[role="option"]', '自定义')
    const inputReady = await waitUntil(cdp, sessionId, `!!document.querySelector('[aria-label="自定义每页条数"]')`)
    if (!inputReady) {
      bad('企业列表 · 自定义每页:选择「自定义」后没有显示输入框')
      return
    }
    const measurement = await evaluate(cdp, sessionId, `(${MEASURE})`)
    const shadow = shadowViolation(measurement, '企业列表 · 自定义每页')
    if (shadow) bad(shadow)
    else ok('企业列表 · 自定义每页:显示的数字输入框无阴影')

    const broken = await evaluate(cdp, sessionId, `(() => {
      const input = document.querySelector('[aria-label="自定义每页条数"]');
      input?.style.setProperty('transition', 'none', 'important');
      input?.style.setProperty('box-shadow', 'rgba(0, 0, 0, 0.2) 0px 1px 2px 0px', 'important');
      if (input) void input.offsetWidth;
      return (${MEASURE});
    })()`)
    const selfCheck = shadowViolation(broken, '自定义每页阴影缺陷自检')
    if (!selfCheck) bad(`自定义每页阴影缺陷自检:重新注入阴影后断言仍未命中 ${JSON.stringify(broken)}`)
    else console.log(`✗ 自定义每页阴影缺陷自检按预期变红:${selfCheck}`)
    if (selfCheck) ok('自定义每页阴影缺陷自检:关闭临时 target 后缺陷已复原')
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function verifyFilesSearchLoading(cdp) {
  const ready = `(() => !document.querySelector('[data-slot="skeleton"]') && !!document.querySelector('table tbody tr td:nth-of-type(2)'))()`
  const page = await openSession(cdp, `${BASE}/files`, VIEWPORTS[0], ready)
  const { targetId, sessionId } = page
  try {
    await installMotionAndFetchGate(cdp, sessionId)
    const name = await evaluate(cdp, sessionId, `document.querySelector('table tbody tr td:nth-of-type(2)')?.textContent?.trim() ?? ''`)
    if (!name) {
      bad('文件管理 · 搜索:初始结果没有可搜索的文件名')
      return
    }
    await startFetchGate(cdp, sessionId, '/api/files?')
    await setInputValue(cdp, sessionId, 'input[placeholder="搜索文件名"]', name)
    const loading = await waitForLoadingEvidence(cdp, sessionId, 'files')
    if (!loading) bad('文件管理 · 搜索:请求期间没有可见加载状态')
    else ok('文件管理 · 搜索:请求期间显示加载状态,旧行保留')
    await finishFetchGate(cdp, sessionId)
    const idle = await waitUntil(cdp, sessionId, `(() => !(document.querySelector('[data-testid="files-loading-status"]')?.textContent ?? '').includes('正在') && [...document.querySelectorAll('table tbody tr')].some((tr) => (tr.textContent ?? '').includes(${JSON.stringify(name)})))()`)
    if (!idle) bad('文件管理 · 搜索:释放请求后匹配文件没有渲染')
    else ok(`文件管理 · 搜索:名称筛选返回 ${JSON.stringify(name)}`)
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
  const root = document.querySelector('.ledger-page, .comparison-page');
  const shadowTargets = [
    ...(root?.querySelectorAll('[data-slot="card"], [data-slot="button"], [data-slot="input"], [data-slot="textarea"], [data-slot="switch"], [data-slot="select-trigger"], [aria-label="自定义每页条数"]') ?? []),
    ...document.querySelectorAll('[data-testid="enterprise-drawer"], [data-slot="dialog-content"], [data-slot="select-content"], [data-slot="dropdown-menu-content"]'),
  ];
  const hasVisibleShadow = (el) => {
    const value = getComputedStyle(el).boxShadow;
    if (value === 'none') return false;
    const colors = [...value.matchAll(/(?:rgba?|hsla?)\(([^)]+)\)/gi)];
    if (!colors.length) return true;
    return colors.some(([, channels]) => {
      const parts = channels.split(/\s*[,/]\s*/);
      return parts.length < 4 || Number.parseFloat(parts.at(-1)) > 0;
    });
  };
  const shadowedTargets = shadowTargets
    .filter(hasVisibleShadow)
    .map((el) => ({ tag: el.tagName.toLowerCase(), slot: el.getAttribute('data-slot'), testId: el.getAttribute('data-testid'), shadow: getComputedStyle(el).boxShadow }));
  const nextButton = [...document.querySelectorAll('button')].find((el) => (el.textContent ?? '').includes('下一页'));
  const pagination = document.querySelector('[data-slot=pagination]') || nextButton?.parentElement?.parentElement;
  const rect = pagination ? pagination.getBoundingClientRect() : null;
  const enterpriseScroller = document.querySelector('.ledger-page [data-testid="enterprise-table-scroll"]');
  const enterpriseScrollerRect = enterpriseScroller?.getBoundingClientRect();
  const enterpriseRows = [...(enterpriseScroller?.querySelectorAll('tbody tr:not([data-loading="true"])') ?? [])];
  const enterpriseDesktopDensity = root?.classList.contains('ledger-page') && enterpriseScrollerRect && rect
    ? {
        scrollerTop: Math.round(enterpriseScrollerRect.top),
        scrollerBottom: Math.round(enterpriseScrollerRect.bottom),
        scrollerHeight: Math.round(enterpriseScrollerRect.height),
        scrollerScrollHeight: enterpriseScroller.scrollHeight,
        totalRows: enterpriseRows.length,
        visibleRows: enterpriseRows.filter((row) => {
          const rowRect = row.getBoundingClientRect();
          return rowRect.top >= enterpriseScrollerRect.top - 1 && rowRect.bottom <= enterpriseScrollerRect.bottom + 1;
        }).length,
        headerPosition: getComputedStyle(enterpriseScroller.querySelector('thead')).position,
        paginationTop: Math.round(rect.top),
        paginationBottom: Math.round(rect.bottom),
      }
    : null;
  const rail = document.querySelector('.ledger-page tbody tr:not([data-loading="true"]) td:first-child > span');
  const ledgerExport = document.querySelector('.ledger-page a[href^="/api/roster/export"]');
  const ledgerTable = document.querySelector('.ledger-page table');
  const control = root?.querySelector('[data-slot="select-trigger"]');
  const body = root?.querySelector('tbody');
  const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
  const comparisonDirection = document.querySelector('[data-testid="comparison-direction-filter"]');
  const comparisonDirectionTrigger = comparisonDirection?.querySelector('[role="combobox"]');
  const comparisonDirectionValue = comparisonDirectionTrigger?.querySelector('[data-slot="select-value"]');
  const comparisonFilters = document.querySelector('[data-testid="comparison-filters"]');
  const comparisonSearch = comparisonFilters?.querySelector('input[aria-label*="搜索企业名称"]');
  const cellMetrics = (el) => el ? {
    text: (el.textContent ?? '').trim(),
    display: getComputedStyle(el).display,
    whiteSpace: getComputedStyle(el).whiteSpace,
    textOverflow: getComputedStyle(el).textOverflow,
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  } : null;
  const enterpriseRow = root?.classList.contains('ledger-page')
    ? document.querySelector('.ledger-page tbody tr:not([data-loading="true"])')
    : null;
  const enterpriseName = enterpriseRow?.querySelector('td:nth-child(2) button');
  const enterpriseTitle = enterpriseRow?.querySelector('[data-testid="title-recognition-cell"]');
  const enterpriseDifference = enterpriseRow?.querySelector('[data-testid="enterprise-difference-cell"]');
  const comparisonRow = root?.classList.contains('comparison-page')
    ? document.querySelector('.comparison-page tbody tr:not([data-loading="true"])')
    : null;
  const comparisonScroller = root?.classList.contains('comparison-page')
    ? document.querySelector('.comparison-page [aria-label="比对结果表格(可横向滚动)"]')
    : null;
  const comparisonName = comparisonRow?.querySelector('[data-testid="comparison-enterprise-name"]');
  const comparisonDetails = comparisonRow?.querySelector('[data-testid="comparison-mobile-details"]');
  const firstRect = comparisonDetails?.getBoundingClientRect();
  const comparisonNames = [...(root?.querySelectorAll('[data-testid="comparison-enterprise-name"]') ?? [])].map((el) => ({
    text: (el.textContent ?? '').trim(),
    textOverflow: getComputedStyle(el).textOverflow,
    whiteSpace: getComputedStyle(el).whiteSpace,
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));
  const evidenceSummaries = [...(root?.querySelectorAll('[data-testid="platform-evidence-summary"]') ?? [])].map((el) => ({
    text: (el.textContent ?? '').trim(),
    textOverflow: getComputedStyle(el).textOverflow,
    whiteSpace: getComputedStyle(el).whiteSpace,
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
  return {
    title: document.title,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    innerWidth: window.innerWidth,
    tableCount: document.querySelectorAll('table').length,
    nativeSelectCount: document.querySelectorAll('select').length,
    shadowedTargets,
    searchInput: !!document.querySelector('input[aria-label*="企业名称"]'),
    loadingStatus: !!document.querySelector('[data-testid="ledger-loading-status"],[data-testid="comparison-loading-status"]'),
    drawerOpen: document.querySelector('[data-testid="enterprise-drawer"]')?.getAttribute('data-state') === 'open',
    comparisonDirection: comparisonDirection ? {
      trigger: !!comparisonDirection.querySelector('[role="combobox"]'),
      label: comparisonDirectionTrigger?.textContent?.trim() ?? '',
      value: cellMetrics(comparisonDirectionValue),
    } : null,
    comparisonFilters: comparisonFilters ? {
      clientWidth: comparisonFilters.clientWidth,
      scrollWidth: comparisonFilters.scrollWidth,
      searchWidth: Math.round(comparisonSearch?.getBoundingClientRect().width ?? 0),
      gridTemplateColumns: getComputedStyle(comparisonFilters).gridTemplateColumns,
      controls: [...comparisonFilters.querySelectorAll('input,[role="combobox"]')].map((el) => {
        const rect = el.getBoundingClientRect();
        return { label: el.getAttribute('aria-label') ?? '', left: Math.round(rect.left), right: Math.round(rect.right) };
      }),
    } : null,
    enterpriseMobileContent: enterpriseRow ? {
      tableWidth: Math.round(enterpriseRow.closest('table')?.getBoundingClientRect().width ?? 0),
      containerWidth: Math.round(enterpriseRow.closest('.overflow-auto')?.clientWidth ?? 0),
      name: cellMetrics(enterpriseName),
      title: cellMetrics(enterpriseTitle),
      difference: cellMetrics(enterpriseDifference),
    } : null,
    comparisonMobileContent: comparisonRow ? {
      tableWidth: Math.round(comparisonRow.closest('table')?.getBoundingClientRect().width ?? 0),
      containerWidth: comparisonScroller?.clientWidth ?? 0,
      name: cellMetrics(comparisonName),
      details: comparisonDetails ? {
        text: (comparisonDetails.textContent ?? '').trim(),
        display: getComputedStyle(comparisonDetails).display,
        whiteSpace: getComputedStyle(comparisonDetails).whiteSpace,
        height: Math.round(firstRect?.height ?? 0),
        hasStatus: !!comparisonDetails.querySelector('[data-testid="reconcile-status-trigger"]'),
      } : null,
    } : null,
    comparisonNames,
    evidenceSummaries,
    statusRailWidth: rail ? Math.round(rail.getBoundingClientRect().width) : null,
    ledgerExportTableGap: ledgerExport && ledgerTable
      ? Math.round(ledgerTable.getBoundingClientRect().top - ledgerExport.getBoundingClientRect().bottom)
      : null,
    motionCurves: {
      control: control ? getComputedStyle(control).transitionTimingFunction : null,
      table: body ? getComputedStyle(body).transitionTimingFunction : null,
      drawer: drawer ? getComputedStyle(drawer).animationTimingFunction : null,
    },
    pagination: rect ? { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width) } : null,
    innerHeight: window.innerHeight,
    enterpriseDesktopDensity,
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
        const shadow = shadowViolation(m, label)
        if (shadow) bad(shadow)
        else ok(`${label}:卡片、按钮、输入框、开关、Select触发器与下拉层、抽屉均无阴影`)
        if (!m.searchInput) bad(`${label}:没有搜索入口`)
        else ok(`${label}:搜索入口已渲染`)
        if (!m.loadingStatus) bad(`${label}:没有常驻加载状态容器`)
        else ok(`${label}:加载状态容器已渲染`)
        if (page.query === '/' && m.nativeSelectCount !== 0) bad(`${label}:仍有 ${m.nativeSelectCount} 个原生 select`)
        if (page.query === '/' && !m.drawerOpen) bad(`${label}:企业侧边抽屉未打开`)
        if (page.query === '/' && viewport.width === 390) {
          if (m.ledgerExportTableGap == null || m.ledgerExportTableGap > 60) {
            bad(`${label}:导出控件到表格之间留白仍偏大 ${JSON.stringify(m.ledgerExportTableGap)}px`)
          } else ok(`${label}:导出控件到表格间距已收紧(${m.ledgerExportTableGap}px)`)
        }
        if (page.query === '/comparison') {
          if (!m.comparisonDirection?.trigger || !m.comparisonDirection.label) {
            bad(`${label}:比对方向应使用项目 Select 过滤器 ${JSON.stringify(m.comparisonDirection)}`)
          } else ok(`${label}:比对方向使用项目 Select(${m.comparisonDirection.label})`)
          if (viewport.width <= 420) {
            const directionValue = comparisonDirectionValueViolation(m, label)
            if (directionValue) bad(directionValue)
            else ok(`${label}:当前比对方向完整可读`)
          }
          const filters = comparisonFiltersViolation(m, label)
          if (filters) bad(filters)
          else ok(`${label}:比对搜索与筛选控件均在视口内`)
          if (!m.comparisonNames.length || m.comparisonNames.some((name) => !name.text || name.textOverflow === 'ellipsis' || name.whiteSpace === 'nowrap' || name.scrollWidth > name.clientWidth)) {
            bad(`${label}:企业名称在表格列内仍被截断 ${JSON.stringify(m.comparisonNames.slice(0, 2))}`)
          } else {
            const narrowNameWidth = Math.min(...m.comparisonNames.map((name) => name.clientWidth))
            ok(`${label}:企业名称可换行完整识别(${m.comparisonNames.length} 行,最窄 ${narrowNameWidth}px)`)
          }
          if (m.evidenceSummaries.some((summary) => !summary.text || summary.textOverflow === 'ellipsis' || summary.whiteSpace === 'nowrap' || summary.scrollWidth > summary.clientWidth || summary.scrollHeight > summary.clientHeight + 1)) {
            bad(`${label}:平台证据摘要仍有截断 ${JSON.stringify(m.evidenceSummaries.slice(0, 2))}`)
          } else {
            ok(`${label}:平台证据摘要完整显示(${m.evidenceSummaries.length} 条)`)
          }
        }
        if (page.query === '/') {
          const rail = statusRailViolation(m, label)
          if (rail) bad(rail)
          else ok(`${label}:最左状态条实测 6px`)
        }
        if (viewport.width === 390) {
          const mobileContent = mobileCoreContentViolation(m, label)
          if (mobileContent) bad(mobileContent)
          else ok(`${label}:窄屏首行可见企业名称、业务字段及状态,表格不需横向滚动`)
        }
        const motionCurve = motionCurveViolation(m, label)
        if (motionCurve) bad(motionCurve)
        else ok(`${label}:控件、表体${page.query === '/' ? '与抽屉' : ''}使用同一缓动曲线`)

        if (m.pagination) {
          if (m.pagination.right > m.innerWidth) {
            bad(`${label}:分页条越界,right=${m.pagination.right} > innerWidth=${m.innerWidth}`)
          } else {
            ok(`${label}:分页条在视口内(right ${m.pagination.right} ≤ ${m.innerWidth},宽 ${m.pagination.width},占 ${m.paginationRows} 行)`)
          }
        } else {
          bad(`${label}:没量到分页控制 —— 这一页有结果就必须可翻页,量不到说明断言被跳过了`)
        }
        if (page.query === '/' && viewport.width >= 1024 && viewport.height >= 800) {
          const density = enterpriseDesktopDensityViolation(m, label)
          if (density) bad(density)
          else ok(`${label}:首屏可读 ${m.enterpriseDesktopDensity.visibleRows} 行，分页底部 ${m.enterpriseDesktopDensity.paginationBottom}px ≤ ${m.innerHeight}px，表头 ${m.enterpriseDesktopDensity.headerPosition}`)
        }
        if (!m.title || !m.title.includes(page.hint)) {
          bad(`${label}:document.title = ${JSON.stringify(m.title)},看不出是${page.hint}`)
        } else {
          ok(`${label}:document.title = ${JSON.stringify(m.title)}`)
        }
      }
    }

    // Respect the project-wide reduced-motion control feedback policy on every list/comparison Select.
    for (const page of PAGES) {
      const result = await openAndMeasure(
        cdp,
        `${BASE}${page.query}`,
        `(() => {
          const triggers = [...document.querySelectorAll('[data-slot="select-trigger"]')];
          return {
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            triggers: triggers.map((el) => ({
              label: el.getAttribute('aria-label') ?? '',
              classes: el.className,
              transitionProperty: getComputedStyle(el).transitionProperty,
            })),
          };
        })()`,
        READY,
        VIEWPORTS[0],
        [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      )
      const label = `${page.name} · 减少动态效果`
      if (!result.reducedMotion) bad(`${label}:Chrome 未应用 prefers-reduced-motion: reduce`)
      else ok(`${label}:Chrome 已应用 prefers-reduced-motion: reduce`)
      if (result.triggers.length !== 3) bad(`${label}:预期 3 个 Select 触发器,实测 ${result.triggers.length}`)
      const missing = result.triggers.filter((trigger) =>
        !trigger.classes.includes('motion-reduce:transition-none') ||
        !trigger.classes.includes('motion-reduce:active:scale-100') ||
        trigger.transitionProperty !== 'none',
      )
      if (missing.length) bad(`${label}:Select 按压反馈未遵循减少动态效果策略 ${JSON.stringify(missing)}`)
      else ok(`${label}:3 个 Select 均禁用过渡并取消按压缩放`)
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

    const tabletFiltersBroken = await openAndMeasure(
      cdp,
      `${BASE}/comparison`,
      `(() => { const filters = document.querySelector('[data-testid="comparison-filters"]'); filters?.style.setProperty('grid-template-columns', 'repeat(12, minmax(200px, 1fr))', 'important'); return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[2],
    )
    const tabletFiltersSelfCheck = comparisonFiltersViolation(tabletFiltersBroken, '720px筛选栏缺陷自检')
    if (!tabletFiltersSelfCheck) bad('720px筛选栏缺陷自检:临时撑宽筛选栏后,控件越界断言仍未命中')
    else console.log(`✗ 720px筛选栏缺陷自检按预期变红:${tabletFiltersSelfCheck}`)
    if (tabletFiltersSelfCheck) ok('720px筛选栏缺陷自检:关闭临时 target 后缺陷已复原')

    const mobileDirectionBroken = await openAndMeasure(
      cdp,
      `${BASE}/comparison`,
      `(() => {
        const value = document.querySelector('[data-testid="comparison-direction-filter"] [data-slot="select-value"]');
        value?.style.setProperty('max-width', '1px', 'important');
        value?.style.setProperty('overflow', 'hidden', 'important');
        return (${MEASURE});
      })()`,
      READY,
      VIEWPORTS[1],
    )
    const mobileDirectionSelfCheck = comparisonDirectionValueViolation(mobileDirectionBroken, '窄屏方向显示缺陷自检')
    if (!mobileDirectionSelfCheck) bad('窄屏方向显示缺陷自检:临时裁窄方向文字后,裁切断言仍未命中')
    else console.log(`✗ 窄屏方向显示缺陷自检按预期变红:${mobileDirectionSelfCheck}`)
    if (mobileDirectionSelfCheck) ok('窄屏方向显示缺陷自检:关闭临时 target 后缺陷已复原')

    const desktopDensityBroken = await openAndMeasure(
      cdp,
      `${BASE}/`,
      `(() => { document.querySelector('[data-testid="enterprise-table-scroll"]')?.style.setProperty('max-height', 'none', 'important'); return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[0],
    )
    const desktopDensitySelfCheck = enterpriseDesktopDensityViolation(desktopDensityBroken, '桌面分页布局缺陷自检')
    if (!desktopDensitySelfCheck) bad('桌面分页布局缺陷自检:移除表格滚动区高度限制后,首屏密度断言仍未命中')
    else console.log(`✗ 桌面分页布局缺陷自检按预期变红:${desktopDensitySelfCheck}`)
    if (desktopDensitySelfCheck) ok('桌面分页布局缺陷自检:关闭临时 target 后缺陷已复原')

    const mobileBroken = await openAndMeasure(
      cdp,
      `${BASE}/`,
      `(() => { document.querySelector('.ledger-page [data-testid="title-recognition-cell"]')?.style.setProperty('display', 'none', 'important'); return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[1],
    )
    const mobileSelfCheck = mobileCoreContentViolation(mobileBroken, '窄屏内容缺陷自检')
    if (!mobileSelfCheck) bad('窄屏内容缺陷自检:临时隐藏称号列后,首屏关键字段断言仍未命中')
    else console.log(`✗ 窄屏内容缺陷自检按预期变红:${mobileSelfCheck}`)
    if (mobileSelfCheck) ok('窄屏内容缺陷自检:关闭临时 target 后缺陷已复原')

    const railBroken = await openAndMeasure(
      cdp,
      `${BASE}/`,
      `(() => { const rail = document.querySelector('.ledger-page tbody tr:not([data-loading="true"]) td:first-child > span'); rail?.style.setProperty('width', '3px', 'important'); return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[0],
    )
    const railSelfCheck = statusRailViolation(railBroken, '状态条宽度缺陷自检')
    if (!railSelfCheck) bad('状态条宽度缺陷自检:临时恢复 3px 状态条后断言仍未命中')
    else console.log(`✗ 状态条宽度缺陷自检按预期变红:${railSelfCheck}`)
    if (railSelfCheck) ok('状态条宽度缺陷自检:关闭临时 target 后缺陷已复原')

    const shadowBroken = await openAndMeasure(
      cdp,
      `${BASE}/comparison`,
      `(() => {
        const input = document.querySelector('.comparison-page input[aria-label*="企业名称"]');
        if (input) input.style.setProperty('transition', 'none', 'important');
        if (input) input.style.setProperty('box-shadow', 'rgba(0, 0, 0, 0.2) 0px 1px 2px 0px', 'important');
        if (input) void input.offsetWidth;
        return { measurement: (${MEASURE}), foundInput: !!input, classes: input?.className, inlineShadow: input?.style.boxShadow, priority: input?.style.getPropertyPriority('box-shadow'), customShadow: input && getComputedStyle(input).getPropertyValue('--tw-shadow'), computedShadow: input && getComputedStyle(input).boxShadow, root: document.querySelector('.comparison-page')?.className };
      })()`,
      READY,
      VIEWPORTS[0],
    )
    const shadowSelfCheck = shadowViolation(shadowBroken.measurement, '阴影缺陷自检')
    if (!shadowSelfCheck) bad(`阴影缺陷自检:临时恢复搜索框阴影后,阴影断言仍未命中 ${JSON.stringify(shadowBroken)}`)
    else console.log(`✗ 阴影缺陷自检按预期变红:${shadowSelfCheck};注入=${JSON.stringify({ foundInput: shadowBroken.foundInput, computedShadow: shadowBroken.computedShadow })}`)
    if (shadowSelfCheck) ok('阴影缺陷自检:关闭临时 target 后缺陷已复原')

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
    await verifyLedgerMobileLoadingOverflow(cdp)
    await verifyLedgerDrawerAsyncClose(cdp)
    await verifyMissingRecognitionYearAndEvidence(cdp)
    await verifyCurrentNameAliasDisplay(cdp)
    await verifyKaichengExample(cdp)
    await verifyUnknownReviewOutcomeExample(cdp)
    await verifyLedgerLoadingAndDrawer(cdp)
    await verifyComparisonSearchAndMotion(cdp)
    await verifyCustomPageSizeInputShadow(cdp)
    await verifyFilesSearchLoading(cdp)

    // 页面减法:行内徽章自身就是状态,图例和横向滚动操作说明不再常驻占高。
    const comparisonCopy = await openAndMeasure(
      cdp,
      `${BASE}/comparison`,
      `(() => ({
        headers: [...document.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim()),
        legend: !!document.querySelector('[data-testid="platform-legend"]'),
        scrollHint: !!document.querySelector('[data-testid="scroll-hint"]'),
        note: document.body.innerText.includes('徽章只表示取值本身') || document.body.innerText.includes('表格较宽,可左右滑动'),
      }))()`,
      `(() => !document.querySelector('[data-slot=skeleton]') && document.querySelectorAll('thead th').length > 0)()`,
    )
    if (!comparisonCopy.headers.includes('平台解释') || !comparisonCopy.headers.includes('平台证据')) {
      bad(`/comparison:平台解释 / 平台证据列头缺失 ${JSON.stringify(comparisonCopy.headers)}`)
    } else {
      ok('/comparison:平台解释与平台证据列头保留')
    }
    if (comparisonCopy.legend || comparisonCopy.scrollHint || comparisonCopy.note) {
      bad(`/comparison:仍渲染常驻图例或横向滚动说明 ${JSON.stringify(comparisonCopy)}`)
    } else {
      ok('/comparison:已移除重复图例与滚动说明')
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
    console.log(`\n结果:${passed} 项通过,${problems.length} 项失败`)
    process.exit(1)
  }
  console.log(`\n结果:${passed} 项通过,0 项失败`)
  console.log('✓ 企业列表与比对页已覆盖桌面/390px/720px、表格唯一性、搜索与加载、分页、排序、抽屉动效及 /roster 查询串重定向')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
