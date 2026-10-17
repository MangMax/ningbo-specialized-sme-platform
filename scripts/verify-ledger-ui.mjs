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
 * 用法:`node scripts/verify-ledger-ui.mjs [--port 3491] [--skip-build] [--focus-only]`
 * 退出码 0 = 全部通过;非 0 = 有一条不符合预期(并打印实测数字)。
 * `--focus-only` 只跑抽屉 Esc / 关闭按钮 / 外部点击后的焦点回归,适合快速诊断。
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
const FOCUS_ONLY = args.includes('--focus-only')
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
    // Before any scripted interaction, the list must start with a closed drawer.
    if (new URL(url).pathname === '/' && !new URL(url).searchParams.has('expand')) {
      const initial = await evaluate(cdp, sessionId, `({ drawer: !!document.querySelector('[data-testid="enterprise-drawer"]'), selected: !!document.querySelector('tbody [aria-current="true"]'), gap: document.querySelector('[data-testid="ledger-loading-status"]')?.getBoundingClientRect().height })`)
      if (initial.drawer || initial.selected || initial.gap !== 0) throw new Error(`企业列表初始状态不符: ${JSON.stringify(initial)}`)
    }
    // Layout/drawer checks explicitly open a row; the application itself starts closed.
    if (new URL(url).pathname === '/' && !new URL(url).searchParams.has('expand')) {
      await evaluate(cdp, sessionId, `document.querySelector('[data-testid="enterprise-name-trigger"]')?.click()`)
      await waitUntil(cdp, sessionId, `!!document.querySelector('[data-testid="enterprise-drawer"] h2') && !document.querySelector('[data-testid="enterprise-drawer"] [data-slot="skeleton"]')`)
    }
    return await evaluate(cdp, sessionId, expression)
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function openSession(cdp, url, viewport, readyExpression = READY, options = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId)
  if (options.mediaFeatures?.length) {
    await cdp.send('Emulation.setEmulatedMedia', { features: options.mediaFeatures }, sessionId)
  }
  await cdp.send('Page.enable', {}, sessionId)
  if (options.beforeLoadScript) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: options.beforeLoadScript }, sessionId)
  }
  await cdp.send('Page.navigate', { url }, sessionId)
  // Explicit interaction precedes drawer-specific readiness; the product starts closed.
  if (new URL(url).pathname === '/' && !new URL(url).searchParams.has('expand') && options.openDrawer !== false) {
    if (!(await waitUntil(cdp, sessionId, READY))) throw new Error(`${url}:列表数据未就绪`);
    await evaluate(cdp, sessionId, `document.querySelector('[data-testid="enterprise-name-trigger"]')?.click()`);
  }

  if (!(await waitUntil(cdp, sessionId, readyExpression))) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    throw new Error(`${url} 在 30s 内没有渲染出表格数据`)
  }
  return { targetId, sessionId }
}

async function verifyPlatformRecordTables(cdp) {
  for (const viewport of VIEWPORTS.slice(0, 2)) {
    for (const kind of ['ledger', 'comparison']) {
      const path = kind === 'ledger' ? '/?q=宁波开诚' : '/comparison';
      const { targetId, sessionId } = await openSession(cdp, BASE + encodeURI(path), viewport);
      try {
        if (kind === 'comparison') {
          const sample = await evaluate(cdp,sessionId,`document.querySelector('tbody a[href^="/enterprises/"]')?.textContent.trim()`);
          await installMotionAndFetchGate(cdp,sessionId);
          await startFetchGate(cdp,sessionId,'/api/comparison');
          await setInputValue(cdp, sessionId, 'input[aria-label*="搜索企业名称"]', sample);
          const searching = await waitForLoadingEvidence(cdp,sessionId,'comparison');
          if (!searching) bad('平台记录表:打开前未观察到真实搜索请求');
          await finishFetchGate(cdp,sessionId);
          await waitUntil(cdp, sessionId, `document.querySelector('tbody a[href^="/enterprises/"]')?.textContent.trim() === ${JSON.stringify(sample)} && !document.querySelector('[data-testid="comparison-loading-status"]')?.textContent.includes('正在')`);
          const point = await evaluate(cdp, sessionId, `(() => { const button = [...document.querySelectorAll('[data-testid="platform-evidence-details-toggle"]')].find(el => el.getBoundingClientRect().width > 0); const r = button?.getBoundingClientRect(); return r && {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
          await clickPoint(cdp, sessionId, point, '查看平台记录');
        }
        const selector = kind === 'ledger' ? '[data-testid="drawer-platform-records"]' : '[data-testid="platform-records-dialog"]';
        const ready = await waitUntil(cdp, sessionId, `!!document.querySelector('${selector} [data-testid="platform-relation"]')`);
        const state = await evaluate(cdp, sessionId, `(() => {
          const root = document.querySelector('${selector}');
          const rect = root?.getBoundingClientRect();
          return { text:root?.textContent, rows:root?.querySelectorAll('[data-testid="platform-relation"]').length, groups:root?.querySelectorAll('[data-testid="platform-title-group"]').length, numbering:[...root.querySelectorAll('tbody[data-record-title]')].map(group=>[...group.querySelectorAll('[data-testid="platform-relation"] td:first-child')].map(cell=>cell.textContent.trim())), tabs:root?.querySelectorAll('[role="tab"]').length, headers:[...root.querySelectorAll('table:first-of-type thead th')].map(el=>el.textContent.trim()), rowHeights:[...root.querySelectorAll('[data-testid="platform-relation"]')].map(el=>el.getBoundingClientRect().height), tables:root?.querySelectorAll('table').length, width:rect?.width, viewport:innerWidth, overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth, original:document.body.textContent.includes('原始说明') };
        })()`);
        if (!ready || state.tables !== 2 || !state.rows || state.tabs < 2 || !['信用代码','省份','申报时间','维护批次'].every(label=>state.headers.includes(label)) || ['区域','认定批次','年份','核实状态','匹配依据','平台编号'].some(label=>state.headers.includes(label)) || !state.groups || state.numbering.some(numbers=>numbers.some((number,index)=>Number(number) !== index+1)) || Math.max(...state.rowHeights) > 40 || (state.text ?? '').includes('查询企业') || /business_list|apply_list|businessList|applyList|rdjb|tyshxydm/.test(state.text ?? '') || state.overflow > 1 || (kind === 'comparison' && state.width > state.viewport) || state.original) bad(`平台记录表 · ${kind} ${viewport.name}:记录表不可读 ${JSON.stringify(state)}`);
        else ok(`平台记录表 · ${kind} ${viewport.name}:${state.tabs} 个称号Tab/${state.rows} 条原始记录以两张表显示，最大行高 ${Math.max(...state.rowHeights)}px，页面无溢出`);
        const groupToggle = `${selector} [data-testid="platform-title-group"] button`;
        const groupRows = await evaluate(cdp,sessionId,`document.querySelector('${groupToggle}')?.closest('tbody')?.querySelectorAll('[data-testid="platform-relation"]').length`);
        await clickSelector(cdp,sessionId,`${groupToggle} svg`);
        const collapsed = await waitUntil(cdp,sessionId,`document.querySelector('${groupToggle}')?.getAttribute('aria-expanded') === 'false' && document.querySelectorAll('${selector} [data-testid="platform-relation"]').length === ${state.rows - groupRows}`);
        await clickSelector(cdp,sessionId,`${groupToggle} svg`);
        const expanded = await waitUntil(cdp,sessionId,`document.querySelector('${groupToggle}')?.getAttribute('aria-expanded') === 'true' && document.querySelectorAll('${selector} [data-testid="platform-relation"]').length === ${state.rows}`);
        if (!collapsed || !expanded) bad(`平台记录表 · ${kind}:称号树分组无法折叠或展开`);
        else ok(`平台记录表 · ${kind}:全部Tab按称号树形分组，折叠/展开不丢行，每组序号从1开始`);
        const titleSelector = `${selector} [role="tab"][data-title-value="2"]`;
        const hasTitle = await evaluate(cdp,sessionId,`!!document.querySelector('${titleSelector}')`);
        if (hasTitle) {
          await clickSelector(cdp,sessionId,titleSelector);
          const switched = await waitUntil(cdp,sessionId,`document.querySelector('${titleSelector}')?.getAttribute('aria-selected') === 'true' && document.querySelectorAll('${selector} table').length === 2 && !document.querySelector('${selector} [data-testid="platform-title-group"]') && [...document.querySelectorAll('${selector} tbody[data-record-title]')].every(group=>[...group.querySelectorAll('[data-testid="platform-relation"] td:first-child')].every((cell,index)=>Number(cell.textContent.trim()) === index+1))`);
          if (!switched) bad(`平台记录表 · ${kind}:称号Tab未切换`);
          else ok(`平台记录表 · ${kind}:称号Tab切换后仍为关联/申报两张表`);
          await clickSelector(cdp,sessionId,`${selector} [role="tab"][data-title-value="all"]`);
          const restoredRows = await waitUntil(cdp,sessionId,`document.querySelectorAll('${selector} [data-testid="platform-relation"]').length === ${state.rows}`);
          if (!restoredRows) bad(`平台记录表 · ${kind}:返回全部后丢失原始行`);
          else ok(`平台记录表 · ${kind}:返回全部保留 ${state.rows} 条原始记录`);
        } else bad(`平台记录表 · ${kind}:缺少当前对比称号Tab`);
        if (kind === 'comparison') {
          await clickSelector(cdp,sessionId,'[data-testid="platform-records-dialog"] [data-slot="dialog-close"]');
          const restored = await waitUntil(cdp,sessionId,`!document.querySelector('[data-testid="platform-records-dialog"]') && document.activeElement?.getAttribute('data-testid') === 'platform-evidence-details-toggle'`);
          if (!restored) bad('平台记录表:关闭后焦点未回到查看平台记录按钮');
          else ok('平台记录表:关闭后焦点返回原按钮');
        }
        if (kind === 'ledger') {
          const expected = await evaluate(cdp,sessionId,`fetch('/api/roster/enterprises/3449').then(r=>r.json()).then(d=>d.platform.relations.length)`);
          if (state.rows !== expected) bad(`平台记录表:抽屉漏记录 ${state.rows}/${expected}`);
          else ok(`平台记录表:抽屉原始明细与详情接口逐条数量一致(${expected})`);
        }
      } finally { await cdp.send('Target.closeTarget', { targetId }).catch(() => {}); }
    }
  }
}

async function verifyLedgerCompactSummaries(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0], READY, {
    openDrawer: false,
    beforeLoadScript: `(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (!String(args[0]).includes('/api/roster/enterprises?')) return response;
        const data = await response.clone().json();
        if (data.rows?.length) data.rows[0].aliasNames = ['历史名称甲', '历史名称乙', '历史名称丙'];
        return new Response(JSON.stringify(data), {status: response.status, headers: response.headers});
      };
    })()`,
  });
  const {targetId, sessionId} = page;
  try {
    const initial = await evaluate(cdp, sessionId, `({
      drawer: !!document.querySelector('[data-testid="enterprise-drawer"]'),
      rails: document.querySelectorAll('[data-rail-kind]').length,
      gap: document.querySelector('[data-testid="ledger-loading-status"]').getBoundingClientRect().height,
      reason: document.querySelector('[data-testid="enterprise-difference-cell"]').textContent.trim(),
      alias: document.querySelector('[data-testid="alias-summary"]').textContent.trim(),
      title: document.querySelector('[data-testid="title-recognition-list"]').textContent.trim(),
    })`);
    if (initial.drawer || initial.rails || initial.gap !== 0 || initial.reason.includes('已确认原因')) bad(`企业列表反馈回归:初始状态错误 ${JSON.stringify(initial)}`);
    else ok('企业列表反馈回归:首次进入抽屉关闭、无行前状态块、无加载空白占位、原因直接显示');
    if (!initial.alias.includes('+2') || initial.alias.includes('历史名称乙')) bad(`企业列表反馈回归:多曾用名折叠错误 ${JSON.stringify(initial)}`);
    else ok('企业列表反馈回归:三个曾用名只显示首项与 +2（浏览器响应夹具，不写库）');
    for (const [trigger, content, label] of [
      ['[data-testid="alias-summary"]', '[data-testid="all-enterprise-aliases"]', '曾用名'],
      ['[data-testid="title-recognition-list"]', '[data-testid="all-title-awards"]', '称号年份批次'],
    ]) {
      const point = await evaluate(cdp, sessionId, `(() => {const r = document.querySelector(${JSON.stringify(trigger)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
      await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...point}, sessionId);
      const visible = await waitUntil(cdp, sessionId, `!!document.querySelector(${JSON.stringify(content)})`);
      const text = visible && await evaluate(cdp, sessionId, `document.querySelector(${JSON.stringify(content)}).textContent.trim()`);
      if (!visible || (label === '曾用名' && !['历史名称甲','历史名称乙','历史名称丙'].every((name) => text.includes(name)))) bad(`企业列表反馈回归:${label}悬浮卡片未完整展示 ${text}`);
      else ok(`企业列表反馈回归:${label}悬停后完整卡片可见`);
      await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:1,y:1},sessionId);
      await waitUntil(cdp,sessionId,`!document.querySelector(${JSON.stringify(content)})`);
    }
    const drawer = await evaluate(cdp,sessionId,`!!document.querySelector('[data-testid="enterprise-drawer"]')`);
    if (drawer) bad('企业列表反馈回归:悬浮摘要误开详情抽屉');
    else ok('企业列表反馈回归:悬浮摘要不会触发详情抽屉');
  } finally { await cdp.send('Target.closeTarget', {targetId}).catch(() => {}); }
}

async function verifyLightThemeDefault(cdp) {
  const page = await openSession(
    cdp,
    `${BASE}/`,
    VIEWPORTS[0],
    READY,
    {
      mediaFeatures: [{ name: 'prefers-color-scheme', value: 'dark' }],
      beforeLoadScript: `localStorage.setItem('vueuse-color-scheme', 'auto')`,
    },
  )
  const { targetId, sessionId } = page
  try {
    const initial = await evaluate(cdp, sessionId, `({
      dark: document.documentElement.classList.contains('dark'),
      savedMode: localStorage.getItem('vueuse-color-scheme'),
    })`)
    if (!initial.dark || initial.savedMode !== 'auto') {
      bad(`主题偏好:显式保存的 auto 应继续跟随深色系统偏好,实测 ${JSON.stringify(initial)}`)
    } else {
      ok('主题偏好:显式保存的 auto 仍跟随深色系统偏好')
    }
    const lightToggle = await evaluate(cdp, sessionId, `document.querySelector('button[aria-label="切换到浅色模式"]') != null`)
    if (!lightToggle) bad('主题偏好:深色模式下没有浅色切换入口')
    else ok('主题偏好:深色模式下有浅色切换入口')
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }

  const freshPage = await openSession(
    cdp,
    `${BASE}/`,
    VIEWPORTS[0],
    READY,
    {
      mediaFeatures: [{ name: 'prefers-color-scheme', value: 'dark' }],
      beforeLoadScript: `localStorage.removeItem('vueuse-color-scheme')`,
    },
  )
  try {
    const freshLight = await evaluate(cdp, freshPage.sessionId, `({
      dark: document.documentElement.classList.contains('dark'),
      savedMode: localStorage.getItem('vueuse-color-scheme'),
    })`)
    if (freshLight.dark) bad(`主题默认值:新会话在深色系统偏好下应从浅色开始,实测 ${JSON.stringify(freshLight)}`)
    else ok(`主题默认值:新会话初始为浅色(${JSON.stringify(freshLight)})`)
  } finally {
    await cdp.send('Target.closeTarget', { targetId: freshPage.targetId }).catch(() => {})
  }

  const darkPage = await openSession(
    cdp,
    `${BASE}/`,
    VIEWPORTS[0],
    READY,
    {
      mediaFeatures: [{ name: 'prefers-color-scheme', value: 'light' }],
      beforeLoadScript: `localStorage.setItem('vueuse-color-scheme', 'dark')`,
    },
  )
  try {
    const explicitDark = await waitUntil(cdp, darkPage.sessionId, `document.documentElement.classList.contains('dark') && localStorage.getItem('vueuse-color-scheme') === 'dark'`)
    if (!explicitDark) bad('主题偏好:用户显式保存的深色主题被默认值覆盖')
    else ok('主题偏好:保留用户显式保存的深色选择')
  } finally {
    await cdp.send('Target.closeTarget', { targetId: darkPage.targetId }).catch(() => {})
  }
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

  const closePoint = await evaluate(cdp, sessionId, `(() => {
    const button = document.querySelector('[data-testid="enterprise-drawer"] button[aria-label="关闭"]');
    const rect = button?.getBoundingClientRect();
    if (!rect) return null;
    window.__rl20DrawerCloseFinished = false;
    window.__rl20DrawerCloseRequested = true;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  if (!closePoint) return { ready, closed: false, animationEnd: false }
  await clickPoint(cdp, sessionId, closePoint, '抽屉关闭按钮')
  const closed = await waitUntil(cdp, sessionId, `(() => {
    const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
    return !drawer || drawer.getAttribute('data-state') === 'closed';
  })()`)
  if (!closed) return { ready, closed: false, animationEnd: false }
  const exitObserved = await waitUntil(cdp, sessionId, `window.__rl20DrawerCloseFinished || !document.querySelector('[data-testid="enterprise-drawer"]')`, 3_000)
  const unmounted = exitObserved && await waitUntil(cdp, sessionId, `!document.querySelector('[data-testid="enterprise-drawer"]')`, 3_000)
  const animationEnd = exitObserved && unmounted
  const motionState = animationEnd ? null : await evaluate(cdp, sessionId, `(() => {
    const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
    const style = drawer && getComputedStyle(drawer);
    return {
      present: !!drawer,
      state: drawer?.getAttribute('data-state'),
      url: location.href,
      animationName: style?.animationName,
      animationDuration: style?.animationDuration,
      animation: style?.animation,
      transform: style?.transform,
      rect: drawer ? { left: drawer.getBoundingClientRect().left, right: drawer.getBoundingClientRect().right } : null,
      animationPlayState: style?.animationPlayState,
      animations: drawer?.getAnimations().map((animation) => ({ playState: animation.playState, currentTime: animation.currentTime, id: animation.id })) ?? [],
      closeRequested: window.__rl20DrawerCloseRequested,
      closeFinished: window.__rl20DrawerCloseFinished,
    };
  })()`)
  return { ready, closed, animationEnd, ...(motionState ? { motionState } : {}) }
}

async function waitForDrawerAnimationsSettled(cdp, sessionId) {
  return waitUntil(cdp, sessionId, `(() => {
    const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
    return !drawer || [...drawer.getAnimations()].every((animation) =>
      animation.playState === 'finished' || animation.playState === 'idle'
    );
  })()`)
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

function ledgerExportLabelViolation(m, label) {
  const text = m.ledgerExportLabel?.trim() ?? ''
  return !text || !text.includes('企业')
    ? `${label}:导出控件没有可见的企业列表文字 ${JSON.stringify(text)}`
    : null
}

function enterpriseDifferenceColorViolation(statuses, label) {
  const byLabel = Object.fromEntries((statuses ?? []).map((item) => [item.text, item]))
  const required = ['未查询', '无记录', '已确认原因']
  const missing = required.filter((text) => !byLabel[text]?.color)
  if (missing.length) return `${label}:真实抽屉状态缺少可计算文字色 ${JSON.stringify(missing)}`
  if (byLabel['未查询'].color !== byLabel['无记录'].color) {
    return `${label}:同属未确认类的状态计算文字色不一致 ${JSON.stringify({ notQueried: byLabel['未查询'].color, noRecord: byLabel['无记录'].color })}`
  }
  if (byLabel['已确认原因'].color === byLabel['未查询'].color) {
    return `${label}:已确认原因与未确认状态没有可见文字色差异 ${JSON.stringify({ confirmed: byLabel['已确认原因'].color, unconfirmed: byLabel['未查询'].color })}`
  }
  return null
}

function shadowViolation(m, label) {
  return m.shadowedTargets.length
    ? `${label}:内容区仍有阴影 ${JSON.stringify(m.shadowedTargets)}`
    : null
}

function statusRailViolation(m, label) {
  return m.statusRailHierarchy?.some((rail) => rail.kind !== 'none')
    ? `${label}:仍存在已移除的行前状态块`
    : null
}

function titleRecognitionPairsViolation(m, label) {
  const content = m.enterpriseMobileContent
  if (!content) return null
  if (content.title?.text === '—') return null
  const pairs = content.titlePairs ?? []
  if (!pairs.length) return `${label}:称号单元格没有按称号与认定年成组`
  const broken = pairs.filter((pair) =>
    !['inline-flex', 'flex'].includes(pair.display) || pair.whiteSpace !== 'nowrap' ||
    pair.width > content.title.width + 1 || pair.scrollWidth > pair.clientWidth + 1,
  )
  return broken.length
    ? `${label}:称号与认定年未保持在同一可读组内 ${JSON.stringify(broken.slice(0, 3))}`
    : null
}

function timelineYearViolation(m, label) {
  const years = m.enterpriseTimelineYears ?? []
  const missing = years.filter((item) => !item.text)
  return missing.length
    ? `${label}:称号历史事件缺少明确的年份或待核标记 ${JSON.stringify(missing.slice(0, 3))}`
    : null
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
  const clippedValues = (filters.values ?? []).filter(({ value }) =>
    !value || value.display === 'none' || value.clientWidth < 1 ||
    value.scrollWidth > value.clientWidth + 1 || value.textOverflow === 'ellipsis',
  )
  if (filters.scrollWidth > filters.clientWidth + 1 || outside.length || searchTooNarrow || clippedValues.length) {
    return `${label}:对比页筛选控件越界、当前值被截断或窄屏搜索框未铺满 ${JSON.stringify({ filters, outside, searchTooNarrow, clippedValues })}`
  }
  return null
}

function comparisonRecordHierarchyViolation(m, label) {
  const separators = m.comparisonMobileContent?.recordSeparators
  if (!separators) return `${label}:找不到手机对比记录分隔线`
  if (separators.recordBorderWidth < 2 || separators.innerBorderWidth >= separators.recordBorderWidth) {
    return `${label}:手机对比记录边界没有强于内部细线 ${JSON.stringify(separators)}`
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

function enterpriseDrawerReadingViolation(m, label) {
  const reading = m.enterpriseDrawerReading
  if (!reading?.open) return `${label}:桌面企业抽屉未打开,无法核对表格连续阅读`
  if (reading.drawerLeft < -1 || reading.drawerRight > reading.viewport + 1 || reading.drawerWidth < 960 || !reading.closeVisible || !reading.headingVisible) {
    return `${label}:宽抽屉、企业标题或关闭入口越出视口 ${JSON.stringify(reading)}`
  }
  return null
}

function comparisonTableFlowViolation(m, label) {
  const flow = m.comparisonTableFlow
  if (!flow || flow.rows < 1) return `${label}:没有可检查的对比结果表格行`
  if (flow.scrollHeight > flow.clientHeight + 1 || flow.tableBottom > flow.scrollerBottom + 1) {
    return `${label}:对比结果被截在内部滚动区,分页先于完整表格 ${JSON.stringify(flow)}`
  }
  if (flow.paginationTop < flow.tableBottom - 1) {
    return `${label}:对比页分页条出现在当前结果行读完之前 ${JSON.stringify(flow)}`
  }
  if (flow.rows >= 20 && flow.documentScrollHeight <= m.innerHeight) {
    return `${label}:对比页长表没有可见的页面级继续滚动路径 ${JSON.stringify(flow)}`
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
    const message = [...(status?.querySelectorAll('*') ?? [])].find((el) => !el.children.length && el.textContent.includes('正在')) ?? status;
    const rect = message?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1 || rect.top < 0 || rect.bottom > innerHeight || getComputedStyle(message).visibility === 'hidden') return false;
    for (let parent = message.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (Number.parseFloat(style.opacity) === 0) return false;
      if (/(hidden|clip|auto|scroll)/.test(style.overflow + style.overflowY + style.overflowX)) {
        const bounds = parent.getBoundingClientRect();
        if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1 || rect.left < bounds.left - 1 || rect.right > bounds.right + 1) return false;
      }
    }
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
      const names = [...document.querySelectorAll('[data-testid=enterprise-name-trigger]')].map((el) => (el.textContent ?? '').trim()).filter(Boolean);
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
        !match.getAttribute('aria-current') && !drawer;
    })()`)
    if (!searchIdle) {
      const state = await evaluate(cdp, sessionId, `(() => ({
        input: document.querySelector('input[aria-label*="企业名称"]')?.value,
        status: document.querySelector('[data-testid="ledger-loading-status"]')?.textContent,
        rows: [...document.querySelectorAll('tbody tr')].map((tr) => ({ name: tr.querySelector('button')?.textContent?.trim(), selected: tr.getAttribute('aria-current') })),
        drawer: (() => { const el = document.querySelector('[data-testid="enterprise-drawer"]'); return el && { state: el.getAttribute('data-state'), title: el.querySelector('h2')?.textContent?.trim() }; })(),
        url: location.href,
      }))()`)
      bad(`企业列表 · 搜索:搜索结果落定后抽屉不应自动打开 ${JSON.stringify(state)}`)
    }
    else ok(`企业列表 · 搜索:搜索结果落定后抽屉保持关闭: ${JSON.stringify(name)}`)

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
    const name = await evaluate(cdp, sessionId, `document.querySelector('[data-testid=enterprise-name-trigger]')?.textContent?.trim() ?? ''`)
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
    if (!measurement.loading || measurement.skeletonCells.length !== 5) {
      bad(`企业列表 · 窄屏加载:没有量到五格加载行 ${JSON.stringify(measurement)}`)
    }
    if (measurement.scrollWidth > measurement.clientWidth + 1) {
      bad(`企业列表 · 窄屏加载:表格容器仍可横向滚动(${measurement.scrollWidth}px / ${measurement.clientWidth}px) ${JSON.stringify(measurement)}`)
    } else {
      ok(`企业列表 · 窄屏加载:表格与骨架不横向溢出(${measurement.scrollWidth}px ≤ ${measurement.clientWidth}px)`)
    }
    // EnterpriseListTable order is company, title/year, USCC, district, difference.
    // Keep this assertion semantic after moving the title/year column beside the company name.
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
      ...new Set([...document.querySelectorAll('tbody tr:not([aria-current="true"]) [data-testid="enterprise-name-trigger"]')]
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
    await clickElementContaining(cdp, sessionId, '[data-testid=enterprise-name-trigger]', names[0])
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
    await clickElementContaining(cdp, sessionId, '[data-testid=enterprise-name-trigger]', names[1])
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
          selected: [...document.querySelectorAll('tbody tr[aria-current="true"] [data-testid="enterprise-name-trigger"]')].map((button) => button.textContent?.trim()),
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

async function verifyLedgerDrawerFocus(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0])
  const { targetId, sessionId } = page
  try {
    await installMotionAndFetchGate(cdp, sessionId)
    await waitForDrawerAnimationsSettled(cdp, sessionId)
    const initialClose = await closeEnterpriseDrawer(cdp, sessionId)
    if (!initialClose.ready || !initialClose.closed || !initialClose.animationEnd) {
      bad(`企业列表 · 抽屉焦点:测试前无法收起默认抽屉 ${JSON.stringify(initialClose)}`)
      return
    }

    const openPoint = await evaluate(cdp, sessionId, `(() => {
      const button = document.querySelector('[data-testid=enterprise-name-trigger]');
      if (!button) return null;
      window.__rl20DrawerOpenMotion = null;
      window.__rl20FocusReturnTarget = button;
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)
    if (openPoint) await clickPoint(cdp, sessionId, openPoint, '企业列表触发按钮')
    const opened = !!openPoint && await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return drawer?.getAttribute('data-state') === 'open' &&
        !!window.__rl20FocusReturnTarget?.isConnected;
    })()`)
    if (!opened) {
      bad('企业列表 · 抽屉焦点:无法从企业按钮打开抽屉')
      return
    }
    await waitForDrawerAnimationsSettled(cdp, sessionId)
    const openedMotionEnded = await waitUntil(cdp, sessionId, 'window.__rl20DrawerOpenMotion?.ended === true', 3_000)
    if (!openedMotionEnded) {
      bad('企业列表 · 抽屉焦点:关闭按钮场景没有完整的抽屉入场动画')
      return
    }
    const buttonClose = await closeEnterpriseDrawer(cdp, sessionId)
    const buttonRestoredFocus = buttonClose.closed && buttonClose.animationEnd && await waitUntil(cdp, sessionId, `(() =>
      !document.querySelector('[data-testid="enterprise-drawer"]') &&
      document.activeElement === window.__rl20FocusReturnTarget
    )()`)
    if (!buttonRestoredFocus) {
      bad(`企业列表 · 抽屉焦点:关闭按钮后没有返回触发企业按钮 ${JSON.stringify(buttonClose)}`)
      return
    } else {
      ok('企业列表 · 抽屉焦点:关闭按钮后焦点返回触发企业按钮')
    }

    const outsideOpenPoint = await evaluate(cdp, sessionId, `(() => {
      window.__rl20DrawerOpenMotion = null;
      const rect = window.__rl20FocusReturnTarget?.getBoundingClientRect();
      return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)
    if (outsideOpenPoint) await clickPoint(cdp, sessionId, outsideOpenPoint, '重开企业详情后点击外部')
    const reopenedForOutside = await waitUntil(cdp, sessionId, `document.querySelector('[data-testid="enterprise-drawer"]')?.getAttribute('data-state') === 'open'`)
    if (!reopenedForOutside) {
      bad('企业列表 · 抽屉焦点:无法重开抽屉检查外部点击')
      return
    }
    await waitForDrawerAnimationsSettled(cdp, sessionId)
    const outsideOpenMotionEnded = await waitUntil(cdp, sessionId, 'window.__rl20DrawerOpenMotion?.ended === true', 3_000)
    if (!outsideOpenMotionEnded) {
      bad('企业列表 · 抽屉焦点:外部点击场景没有完整的抽屉入场动画')
      return
    }
    const outsideLink = await evaluate(cdp, sessionId, `(() => {
      const link = [...document.querySelectorAll('a[href="/"]')]
        .find((item) => (item.textContent ?? '').includes('企业列表'));
      if (!link) return null;
      window.__rl20OutsideFocusTarget = link;
      window.__rl20DrawerCloseFinished = false;
      window.__rl20DrawerCloseRequested = true;
      link.addEventListener('click', (event) => event.preventDefault(), { once: true });
      const rect = link.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)
    if (!outsideLink) {
      bad('企业列表 · 抽屉焦点:找不到可作为外部目标的侧边栏「企业列表」入口')
      return
    }
    await clickPoint(cdp, sessionId, outsideLink, '侧边栏企业列表入口')
    const outsideFocusPreserved = await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      return !drawer && document.activeElement === window.__rl20OutsideFocusTarget;
    })()`)
    if (!outsideFocusPreserved) {
      const state = await evaluate(cdp, sessionId, `(() => ({
        drawer: (() => {
          const el = document.querySelector('[data-testid="enterprise-drawer"]');
          if (!el) return null;
          const style = getComputedStyle(el);
          return {
            state: el.getAttribute('data-state'),
            display: style.display,
            animationName: style.animationName,
            animationDuration: style.animationDuration,
            animations: el.getAnimations().map((animation) => ({ playState: animation.playState, currentTime: animation.currentTime })),
          };
        })(),
        closeAnimationEnd: window.__rl20DrawerCloseFinished,
        activeTag: document.activeElement?.tagName,
        outsideTargetConnected: window.__rl20OutsideFocusTarget?.isConnected,
        outsideTargetFocused: document.activeElement === window.__rl20OutsideFocusTarget,
      }))()`)
      bad(`企业列表 · 抽屉焦点:外部点击关闭后没有保留外部焦点 ${JSON.stringify(state)}`)
    } else {
      ok('企业列表 · 抽屉焦点:外部点击关闭后保留侧边栏链接焦点')
    }
  } finally {
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
    await waitUntil(cdp, sessionId, `document.querySelector('[data-testid="enterprise-name-trigger"]')?.textContent.trim() === ${JSON.stringify(target.name)}`)
    await clickSelector(cdp, sessionId, '[data-testid="title-recognition-list"]')
    const visible = await waitUntil(cdp, sessionId, `document.querySelector('[data-testid="all-title-awards"]')?.textContent.includes('年待核')`)
    if (!visible) {
      bad(`企业列表 · 称号与出处:企业 ${JSON.stringify(target.name)} 的无认定年称号没有显示「年待核」`)
      return
    }
    ok(`企业列表 · 称号:企业 ${JSON.stringify(target.name)} 的无认定年称号在完整卡片中保留并显示「年待核」`)

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
    { enterpriseId: 3832, name: '中化(浙江)膜产业发展有限公司', alias: '中化（浙江）膜产业发展有限公司' },
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
      const expectedAlias = sample.alias ?? sample.name
      if (!rawAliasNames.includes(expectedAlias)) {
        bad(`企业列表 · 曾用名:企业 ${sample.enterpriseId} 的真实接口数据不再包含与现名相同的 confirmed 别名 ${JSON.stringify(rawAliasNames)}`)
      } else {
        ok(`企业列表 · 曾用名:企业 ${sample.enterpriseId} 的接口仍保留原始 confirmed 别名`)
      }

      const listState = await evaluate(cdp, sessionId, `(() => {
        const row = [...document.querySelectorAll('tbody tr')]
          .find((item) => item.querySelector('td:first-child button')?.textContent?.trim() === ${JSON.stringify(sample.name)});
        return row ? {
          aliases: [...row.querySelectorAll('td:first-child [data-testid="alias-summary"]')]
            .map((item) => (item.textContent ?? '').trim()),
        } : null;
      })()`)
      if (!listState) {
        bad(`企业列表 · 曾用名:搜索不到企业 ${sample.enterpriseId} ${JSON.stringify(sample.name)}`)
        continue
      }
      if (listState.aliases.includes(`原 ${expectedAlias}`)) {
        bad(`企业列表 · 曾用名:列表把企业 ${sample.enterpriseId} 的现名显示成曾用名 ${JSON.stringify(listState.aliases)}`)
      } else {
        ok(`企业列表 · 曾用名:企业 ${sample.enterpriseId} 不把现名显示成曾用名`)
      }

      await evaluate(cdp, sessionId, `document.querySelector('[data-testid=enterprise-name-trigger]')?.click()`)
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
      if (drawerAliasNames.includes(expectedAlias)) {
        bad(`企业列表 · 曾用名:抽屉把企业 ${sample.enterpriseId} 的现名显示成曾用名 ${JSON.stringify(drawerAliasNames)}`)
      } else {
        ok(`企业列表 · 曾用名:企业 ${sample.enterpriseId} 的抽屉不把现名显示成曾用名`)
      }
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    }
  }
}

async function verifyComparisonCurrentNameAliasDisplay(cdp) {
  const samples = [
    { enterpriseId: 987, name: '宁波芯速联光电科技有限公司' },
    { enterpriseId: 1207, name: '宁波九纵智能科技有限公司' },
    { enterpriseId: 3832, name: '中化(浙江)膜产业发展有限公司', alias: '中化（浙江）膜产业发展有限公司', titleLabel: '创新型中小企业' },
  ]

  for (const sample of samples) {
    const targetHref = JSON.stringify(`/enterprises/${sample.enterpriseId}`)
    const page = await openSession(
      cdp,
      `${BASE}/comparison`,
      VIEWPORTS[0],
    )
    const { targetId, sessionId } = page
    try {
      const expectedAlias = sample.alias ?? sample.name
      if (sample.titleLabel) {
        await clickSelector(cdp, sessionId, '[aria-label="按称号筛选"]')
        await clickElementContaining(cdp, sessionId, '[role="option"]', sample.titleLabel)
      }
      await setInputValue(cdp, sessionId, 'input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]', sample.name)
      const rowReady = await waitUntil(cdp, sessionId, `(() => [...document.querySelectorAll('tbody a[href^="/enterprises/"]')]
        .some((link) => link.getAttribute('href') === ${targetHref}))()`)
      if (!rowReady) {
        bad(`两侧名录比对 · 曾用名:按真实名称搜索后没有找到企业 ${sample.enterpriseId}`)
        continue
      }

      const currentNameDisplay = await evaluate(cdp, sessionId, `(() => {
        const link = [...document.querySelectorAll('tbody a[href^="/enterprises/"]')]
          .find((item) => item.getAttribute('href') === ${targetHref});
        const row = link?.closest('tr');
        const rowAliasText = row?.querySelector('[data-testid="comparison-aliases"]')?.textContent ?? '';
        const evidence = row?.querySelector('[data-testid="comparison-platform-evidence"]');
        const toggle = evidence?.querySelector('[data-testid="platform-evidence-details-toggle"]');
        toggle?.click();
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
          rowAliasText,
          evidenceAliasText: [...(document.querySelector('[data-testid="platform-records-dialog"]')?.querySelectorAll('[data-testid="platform-confirmed-aliases"], [data-testid="platform-pending-aliases"]') ?? [])]
            .map((item) => item.textContent ?? '').join(' '),
          expanded: toggle?.getAttribute('aria-expanded') ?? null,
          hasEvidence: !!evidence,
        }))));
      })()`)

      if (currentNameDisplay.rowAliasText.includes(expectedAlias)) {
        bad(`两侧名录比对 · 曾用名:企业 ${sample.enterpriseId} 把现名显示成行内曾用名 ${JSON.stringify(currentNameDisplay)}`)
      } else if (currentNameDisplay.evidenceAliasText.includes(expectedAlias)) {
        bad(`两侧名录比对 · 曾用名:企业 ${sample.enterpriseId} 把现名显示成展开证据中的曾用名 ${JSON.stringify(currentNameDisplay)}`)
      } else if (currentNameDisplay.hasEvidence && currentNameDisplay.expanded !== 'true') {
        bad(`两侧名录比对 · 曾用名:企业 ${sample.enterpriseId} 的平台证据不能展开 ${JSON.stringify(currentNameDisplay)}`)
      } else {
        ok(`两侧名录比对 · 曾用名:企业 ${sample.enterpriseId} 的行与证据展开均隐藏现名`)
      }
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    }
  }
}

async function verifyComparisonExportFilters(cdp) {
  const page = await openSession(cdp, `${BASE}/comparison`, VIEWPORTS[0])
  const { targetId, sessionId } = page
  try {
    await setInputValue(cdp, sessionId, 'input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]', '宁波开诚')
    await clickSelector(cdp, sessionId, '[aria-label="按区县筛选"]')
    await clickElementContaining(cdp, sessionId, '[role="option"]', '鄞州区')
    const exportState = await waitUntil(cdp, sessionId, `(() => {
      const link = document.querySelector('a[href^="/api/export?"]');
      if (!link) return false;
      const url = new URL(link.href);
      const params = url.searchParams;
      return params.get('q') === '宁波开诚' &&
        params.get('district') === '鄞州区' &&
        params.get('showCurated') === 'false' &&
        params.get('title') === 'specialized_sme' &&
        params.get('direction') === 'missing_in_miit';
    })()`)
    if (!exportState) {
      const href = await evaluate(cdp, sessionId, `document.querySelector('a[href^="/api/export?"]')?.href ?? null`)
      bad(`两侧名录比对 · 导出:搜索、区县与当前比对条件没有进入导出地址 ${JSON.stringify(href)}`)
    } else {
      ok('两侧名录比对 · 导出:搜索、区县、称号、方向与已核实开关进入导出地址')
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function verifyNextReviewFlagBinding(cdp) {
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0])
  const { targetId, sessionId } = page
  try {
    const detail = await evaluate(cdp, sessionId, `fetch('/api/roster/enterprises/312')
      .then((response) => response.json())`)
    if (!detail?.enterprise?.name || detail.enterprise.nextReviewYear == null) {
      bad(`企业列表 · 下次复核待核:企业 312 无法提供真实复核样本 ${JSON.stringify(detail?.enterprise)}`)
      return
    }
    const expectedNeedsReview = detail.records.some((record) =>
      record.lifecycle?.dueYear === detail.enterprise.nextReviewYear && record.lifecycle?.needsReview,
    )
    await setInputValue(cdp, sessionId, 'input[aria-label*="企业名称"]', detail.enterprise.name)
    await waitUntil(cdp, sessionId, `document.querySelector('[data-testid="enterprise-name-trigger"]')?.textContent.trim() === ${JSON.stringify(detail.enterprise.name)}`)
    await clickSelector(cdp, sessionId, '[data-testid="enterprise-name-trigger"]')
    const rendered = await waitUntil(cdp, sessionId, `(() => {
      const drawer = document.querySelector('[data-testid="enterprise-drawer"]');
      const year = drawer?.querySelector('[data-testid="next-review-value"]');
      return drawer?.getAttribute('data-state') === 'open' &&
        year?.textContent?.includes(${JSON.stringify(String(detail.enterprise.nextReviewYear))});
    })()`)
    if (!rendered) {
      bad('企业列表 · 下次复核待核:企业 312 的复核年份没有渲染')
      return
    }
    const marked = await evaluate(cdp, sessionId, `[...document.querySelectorAll('[data-testid="next-review-year"][data-review-year="${detail.enterprise.nextReviewYear}"]')].some(element => element.textContent.includes('待核'))`)
    if (marked !== expectedNeedsReview) {
      bad(`企业列表 · 下次复核待核:标记没有绑定到产生该年份的称号 ${JSON.stringify({ year: detail.enterprise.nextReviewYear, expectedNeedsReview, marked })}`)
    } else {
      ok(`企业列表 · 下次复核待核:企业 312 的 ${detail.enterprise.nextReviewYear} 年标记与对应称号锚点一致`)
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

function nextReviewDetailViolation(items) {
  const expected = [
    ['specialized_sme','专精特新中小企业',2024,'原认定：2021年 · 批次待核',true],
    ['innovative_sme','创新型中小企业',2025,'原认定：2022年 · 批次待核',true],
    ['little_giant','专精特新“小巨人”',2027,'原认定：2024年 · 第6批',false],
  ]
  if (items.length !== expected.length) return '未逐称号列出三个复核安排'
  return expected.some(([title,label,year,cohort,pending],index) => {
    const item=items[index];
    return item.title !== title || !item.text.includes(label) || !item.year.includes(`${year}年复核`) || item.year.includes('待核') !== pending || item.cohort !== cohort || item.scrollWidth > item.clientWidth+1;
  }) ? '称号、复核年、认定年批次或待核状态不匹配/越界' : null
}

async function verifyNextReviewDetails(cdp) {
  const measure = `(() => [...document.querySelectorAll('[data-testid="next-review-item"]')].map(element=>({
    title:element.dataset.titleCode,text:element.textContent,year:element.querySelector('[data-testid="next-review-year"]')?.textContent.trim() ?? '',cohort:element.querySelector('[data-testid="next-review-cohort"]')?.textContent.trim() ?? '',clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,
  })))()`;
  for (const viewport of VIEWPORTS.slice(0,2)) {
    const {targetId,sessionId}=await openSession(cdp,`${BASE}/?q=${encodeURIComponent('宁波开诚')}&expand=3449`,viewport,`document.querySelectorAll('[data-testid="next-review-item"]').length === 3`);
    try {
      const items=await evaluate(cdp,sessionId,measure);
      const violation=nextReviewDetailViolation(items);
      if (violation) bad(`下次复核详情 · ${viewport.name}:${violation} ${JSON.stringify(items)}`);
      else ok(`下次复核详情 · ${viewport.name}:三个称号分别显示复核年/原认定年批次，缺批次待核，无越界`);
      await evaluate(cdp,sessionId,`document.querySelector('[data-testid="next-review-value"]').textContent='2024 待核'`);
      if (!nextReviewDetailViolation(await evaluate(cdp,sessionId,measure))) bad(`下次复核详情 · ${viewport.name}:恢复仅有年份后断言未变红`);
      else ok(`下次复核详情 · ${viewport.name}:恢复仅有年份后按预期变红`);
    } finally {await cdp.send('Target.closeTarget',{targetId}).catch(()=>{});}
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
        rowCount: [...document.querySelectorAll('[data-testid=enterprise-name-trigger]')].length,
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
      '专精特新中小企业复核',
      '创新型中小企业复核',
      '专精特新“小巨人”认定',
      '专精特新“小巨人”复核',
    ]
    const valueStarts = example.chainLayout.map((item) => item.valueLeft)
    const connectorGaps = example.chainLayout.map((item) => item.valueLeft - item.connectorCenter)
    const chainAligned = valueStarts.length === 3 &&
      Math.max(...valueStarts) - Math.min(...valueStarts) <= 1 &&
      Math.min(...connectorGaps) >= 12
    const okExample = example.rowCount === 1 && example.selected === 'true' &&
      example.uscc === '9133021274738281XA' && example.alias &&
      JSON.stringify(example.years) === JSON.stringify(['2021', '2022', '2024', '2024', '2024', '2024']) &&
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

function timelineConnectionViolation(rows) {
  if (rows.length < 2 || rows.some(row => !row.line || !row.node)) return '缺少可测量的节点或连接线'
  if (Math.abs(rows[0].line.top - rows[0].node.centerY) > 1 || Math.abs(rows.at(-1).line.bottom - rows.at(-1).node.centerY) > 1) return '首尾连接线未止于圆点中心'
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (Math.abs(row.line.centerX - row.node.centerX) > 1 || row.line.top > row.node.centerY + 1 || row.line.bottom < row.node.centerY - 1) return '连接线未穿过圆点中心'
    if (index && Math.abs(rows[index - 1].line.bottom - row.line.top) > 1) return '相邻连接线存在断口'
  }
  return null
}

async function verifyTimelineConnections(cdp) {
  const measure = `(() => [...document.querySelectorAll('[data-testid="timeline-event"]')].map(row => {
    const rect = element => { const r=element?.getBoundingClientRect();return r ? {top:r.top,bottom:r.bottom,centerX:r.left+r.width/2,centerY:r.top+r.height/2} : null; };
    return {text:row.textContent.trim(),line:rect(row.querySelector('[data-testid="timeline-connector"]')),node:rect(row.querySelector('[data-testid="timeline-node"]'))};
  }))()`;
  for (const viewport of VIEWPORTS.slice(0, 2)) {
    const {targetId, sessionId} = await openSession(cdp, `${BASE}/?q=${encodeURIComponent('宁波开诚')}&expand=3449`, viewport, `document.querySelectorAll('[data-testid="timeline-event"]').length === 6`);
    try {
      const rows = await evaluate(cdp,sessionId,measure);
      const violation = timelineConnectionViolation(rows);
      if (violation || rows.some(row => row.text.includes('维持'))) bad(`称号时间线 · ${viewport.name}:${violation ?? '仍显示维持'} ${JSON.stringify(rows)}`);
      else ok(`称号时间线 · ${viewport.name}:6个节点连线连续，首尾止于圆心，maintain显示复核`);
      await evaluate(cdp,sessionId,`(() => {const line=[...document.querySelectorAll('[data-testid="timeline-connector"]')].at(-1);line.style.setProperty('top','9px','important');line.style.setProperty('height','12px','important');})()`);
      const broken = timelineConnectionViolation(await evaluate(cdp,sessionId,measure));
      if (!broken) bad(`称号时间线 · ${viewport.name}:恢复末端断口后断言未变红`);
      else ok(`称号时间线 · ${viewport.name}:恢复末端断口后按预期变红(${broken})`);
    } finally { await cdp.send('Target.closeTarget',{targetId}).catch(()=>{}); }
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

async function verifyLedgerReasonFilter(cdp) {
  for (const viewport of [VIEWPORTS[0], VIEWPORTS.find(view => view.width === 390)]) {
    const page = await openSession(cdp, `${BASE}/`, viewport, READY, { openDrawer: false })
    const { targetId, sessionId } = page
    const label = `企业列表 · ${viewport.width}px其他筛选`
    try {
      await clickElementContaining(cdp, sessionId, 'button', '全部差异状态')
      const optionReady = await waitUntil(cdp, sessionId, `(() => [...document.querySelectorAll('[role="menuitemcheckbox"]')].some(el => el.textContent.trim() === '其他'))()`)
      if (!optionReady) { bad(`${label}:菜单缺少其他`); continue }
      ok(`${label}:菜单提供其他`)
      // 恢复缺陷：移除菜单里的其他，确认同一个断言能命中，再重新打开真实菜单。
      const missingDetected = await evaluate(cdp, sessionId, `(() => {
        [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(el => el.textContent.trim() === '其他')?.remove();
        return ![...document.querySelectorAll('[role="menuitemcheckbox"]')].some(el => el.textContent.trim() === '其他');
      })()`)
      if (!missingDetected) bad(`${label}:移除选项后断言未命中`)
      else ok(`${label}:菜单缺项自检按预期变红`)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId)
      await waitUntil(cdp, sessionId, `!document.querySelector('[role="menu"]')`)
      await clickElementContaining(cdp, sessionId, 'button', '全部差异状态')
      const restored = await waitUntil(cdp, sessionId, `(() => [...document.querySelectorAll('[role="menuitemcheckbox"]')].some(el => el.textContent.trim() === '其他'))()`)
      if (!restored) { bad(`${label}:重新打开菜单后其他未恢复`); continue }
      await installMotionAndFetchGate(cdp, sessionId)
      await startFetchGate(cdp, sessionId, '/api/roster/enterprises?')
      await clickElementContaining(cdp, sessionId, '[role="menuitemcheckbox"]', '其他')
      const loading = await waitForLoadingEvidence(cdp, sessionId, 'ledger')
      if (!loading) bad(`${label}:勾选后请求期间无加载提示`)
      else ok(`${label}:勾选后请求期间有加载提示`)
      await finishFetchGate(cdp, sessionId)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId)
      const settled = await waitUntil(cdp, sessionId, `(() => {
        const cells = [...document.querySelectorAll('[data-testid="enterprise-difference-cell"]')];
        return new URL(location.href).searchParams.get('diffStatus') === 'other' &&
          !document.querySelector('[data-slot="skeleton"]') && cells.length > 0 &&
          cells.every(el => el.textContent.trim() === '其他') &&
          document.querySelector('tbody')?.dataset.loading !== 'true';
      })()`)
      if (!settled) bad(`${label}:URL或可见结果不匹配其他`)
      else ok(`${label}:URL已更新且全部可见行均为其他`)
      const state = await evaluate(cdp, sessionId, `(() => ({
        chip: document.body.textContent.includes('差异状态 · 其他'),
        exportReason: new URL(document.querySelector('a[href^="/api/roster/export"]').href).searchParams.get('diffStatus'),
        overflow: document.documentElement.scrollWidth - innerWidth,
      }))()`)
      if (!state.chip || state.exportReason !== 'other' || state.overflow > 1) bad(`${label}:筛选chip、导出或页面溢出错误 ${JSON.stringify(state)}`)
      else ok(`${label}:中文chip、导出参数一致，页面溢出${state.overflow}px`)
      await cdp.send('Page.reload', {}, sessionId)
      const reloaded = await waitUntil(cdp, sessionId, `(() => {
        const cells = [...document.querySelectorAll('[data-testid="enterprise-difference-cell"]')];
        return !document.querySelector('[data-slot="skeleton"]') && cells.length > 0 && cells.every(el => el.textContent.trim() === '其他') && document.body.textContent.includes('差异状态 · 其他');
      })()`)
      if (!reloaded) bad(`${label}:刷新后未保留筛选结果`)
      else ok(`${label}:刷新保留其他筛选与结果`)
    } finally {
      await finishFetchGate(cdp, sessionId).catch(() => {})
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    }
  }
}

async function verifyLedgerLoadingAndDrawer(cdp) {
  // 加宽后的抽屉覆盖筛选区域；按真实操作先在关闭状态验证排序。
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0], READY, { openDrawer: false })
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
    await evaluate(cdp, sessionId, `document.querySelector('[data-testid=enterprise-name-trigger]')?.click()`);
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
    await evaluate(cdp, sessionId, `document.querySelector('[data-testid=enterprise-name-trigger]')?.click()`);
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
        document.querySelector('[data-testid=enterprise-name-trigger]')?.click();
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
  const page = await openSession(cdp, `${BASE}/`, VIEWPORTS[0], READY, { openDrawer: false })
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

function reducedMotionViolation(result, label) {
  if (!result.reducedMotion) return `${label}:Chrome 未应用 prefers-reduced-motion: reduce`
  if (result.triggers.length !== 3) return `${label}:预期 3 个 Select 触发器,实测 ${result.triggers.length}`
  const violations = result.triggers.filter((trigger) => {
    const durations = String(trigger.pressed.transitionDuration ?? '')
      .split(',')
      .map((value) => value.trim())
      .map((value) => value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000)
    const transitionDisabled = trigger.pressed.transitionProperty === 'none' ||
      (durations.length > 0 && durations.every((duration) => Number.isFinite(duration) && duration <= 0))
    const changedSize = Math.abs(trigger.pressed.width - trigger.before.width) > 0.5 ||
      Math.abs(trigger.pressed.height - trigger.before.height) > 0.5
    return !transitionDisabled || changedSize
  })
  return violations.length
    ? `${label}:Select 实际按压仍有过渡或缩放 ${JSON.stringify(violations.map(({ label: control, before, pressed }) => ({ control, before, pressed })))}`
    : null
}

async function measureReducedMotionSelects(cdp, page, injectScale = false) {
  const { targetId, sessionId } = await openSession(
    cdp,
    `${BASE}${page.query}`,
    VIEWPORTS[0],
    READY,
    { mediaFeatures: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
  )
  try {
    if (injectScale) {
      await evaluate(cdp, sessionId, `(() => {
        const style = document.createElement('style');
        style.textContent = '[data-slot="select-trigger"]:active { scale: .98 !important; }';
        document.head.append(style);
      })()`)
    }

    const labels = await evaluate(cdp, sessionId, `(() => [...document.querySelectorAll('[data-slot="select-trigger"]')]
      .map((el) => el.getAttribute('aria-label') || el.textContent.trim()))()`)
    const triggers = []
    for (let index = 0; index < labels.length; index++) {
      const elementState = async (phase) => evaluate(cdp, sessionId, `new Promise((resolve) => requestAnimationFrame(() => {
        const el = [...document.querySelectorAll('[data-slot="select-trigger"]')][${index}];
        if (!el) { resolve(null); return; }
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        resolve({
          phase: ${JSON.stringify(phase)},
          width: rect.width,
          height: rect.height,
          scale: style.scale,
          transform: style.transform,
          transitionProperty: style.transitionProperty,
          transitionDuration: style.transitionDuration,
        });
      }))`)
      const before = await evaluate(cdp, sessionId, `(() => {
        const el = [...document.querySelectorAll('[data-slot="select-trigger"]')][${index}];
        el?.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = el?.getBoundingClientRect();
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      })()`)
      if (!before) {
        triggers.push({ label: labels[index], before: null, pressed: null })
        continue
      }

      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y, button: 'none', buttons: 0 }, sessionId)
      const idle = await elementState('hover')
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
      let pressed
      try {
        pressed = await elementState('pressed')
      } finally {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x, y: before.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
      }
      triggers.push({ label: labels[index], before: idle, pressed })

      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId)
      await waitUntil(cdp, sessionId, `(() => !document.querySelector('[data-slot="select-content"]'))()`)
    }
    return {
      reducedMotion: await evaluate(cdp, sessionId, `matchMedia('(prefers-reduced-motion: reduce)').matches`),
      triggers,
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

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
  const comparisonFilterValues = ['按称号筛选', '按区县筛选'].map((label) => {
    const trigger = [...(comparisonFilters?.querySelectorAll('[role="combobox"]') ?? [])]
      .find((el) => el.getAttribute('aria-label') === label);
    return { label, value: cellMetrics(trigger?.querySelector('[data-slot="select-value"]')) };
  });
  const enterpriseRow = root?.classList.contains('ledger-page')
    ? document.querySelector('.ledger-page tbody tr:not([data-loading="true"])')
    : null;
  const enterpriseName = enterpriseRow?.querySelector('td:first-child button');
  const enterpriseTitle = enterpriseRow?.querySelector('[data-testid="title-recognition-cell"]');
  const enterpriseTitlePairs = [...(enterpriseTitle?.querySelectorAll('[data-testid="title-recognition-pair"]') ?? [])].map((el) => ({
    ...cellMetrics(el),
    width: Math.round(el.getBoundingClientRect().width),
  }));
  const enterpriseDifference = enterpriseRow?.querySelector('[data-testid="enterprise-difference-cell"]');
  const enterpriseSearch = root?.classList.contains('ledger-page')
    ? root.querySelector('input[aria-label*="企业名称"]')
    : null;
  const enterpriseDrawer = root?.classList.contains('ledger-page')
    ? document.querySelector('[data-testid="enterprise-drawer"]')
    : null;
  const enterpriseDifferenceStatuses = [...(enterpriseDrawer?.querySelectorAll('[data-testid="enterprise-difference-status"]') ?? [])].map((el) => ({
    text: (el.textContent ?? '').trim(),
    color: getComputedStyle(el).color,
  }));
  const enterpriseDrawerRect = enterpriseDrawer?.getBoundingClientRect();
  const enterpriseTimelineYears = [...(enterpriseDrawer?.querySelectorAll('[data-testid="timeline-event-year"]') ?? [])].map((el) => ({
    text: (el.textContent ?? '').trim(),
    label: el.getAttribute('aria-label') ?? '',
  }));
  const elementVisibility = (el) => {
    const elementRect = el?.getBoundingClientRect();
    return elementRect && enterpriseDrawerRect ? {
      left: Math.round(elementRect.left),
      right: Math.round(elementRect.right),
      width: Math.round(elementRect.width),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      fitsBeforeDrawer: elementRect.left >= -1 && elementRect.right <= enterpriseDrawerRect.left + 1,
    } : null;
  };
  const comparisonRow = root?.classList.contains('comparison-page')
    ? document.querySelector('.comparison-page tbody tr:not([data-loading="true"])')
    : null;
  const comparisonScroller = root?.classList.contains('comparison-page')
    ? document.querySelector('.comparison-page [aria-label="比对结果表格(可横向滚动)"]')
    : null;
  const comparisonTable = comparisonScroller?.querySelector('table');
  const comparisonLastRow = comparisonScroller?.querySelector('tbody tr:not([data-loading="true"]):last-child');
  const comparisonPagination = root?.classList.contains('comparison-page')
    ? document.querySelector('[data-testid="comparison-pagination"]')
    : null;
  const comparisonTableRect = comparisonTable?.getBoundingClientRect();
  const comparisonScrollerRect = comparisonScroller?.getBoundingClientRect();
  const comparisonPaginationRect = comparisonPagination?.getBoundingClientRect();
  const comparisonLastRowRect = comparisonLastRow?.getBoundingClientRect();
  const comparisonName = comparisonRow?.querySelector('[data-testid="comparison-enterprise-name"]');
  const comparisonDetails = comparisonRow?.querySelector('[data-testid="comparison-mobile-details"]');
  const firstRect = comparisonDetails?.getBoundingClientRect();
  const comparisonRecord = comparisonRow?.querySelector('[data-testid="comparison-record-row"]') ?? comparisonRow;
  const comparisonInnerDivider = comparisonDetails?.querySelector('[data-testid="comparison-mobile-status-divider"]');
  const comparisonRecordSeparators = comparisonRecord && comparisonInnerDivider ? {
    recordBorderWidth: Number.parseFloat(getComputedStyle(comparisonRecord).borderBottomWidth),
    innerBorderWidth: Number.parseFloat(getComputedStyle(comparisonInnerDivider).borderBottomWidth),
  } : null;
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
    tableCount: [...document.querySelectorAll('.ledger-page table, .comparison-page table')].filter(table => !table.closest('[data-testid="enterprise-drawer"],[data-testid="platform-records-dialog"]')).length,
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
      values: comparisonFilterValues,
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
      titlePairs: enterpriseTitlePairs,
      difference: cellMetrics(enterpriseDifference),
    } : null,
    enterpriseTimelineYears,
    enterpriseDifferenceStatuses,
    statusRailHierarchy: [...document.querySelectorAll('.ledger-page tbody [data-rail-kind]')].map((rail) => ({kind: rail.getAttribute('data-rail-kind')})),
    enterpriseDrawerReading: enterpriseRow && enterpriseDrawer ? {
      open: enterpriseDrawer.getAttribute('data-state') === 'open',
      drawerLeft: Math.round(enterpriseDrawerRect?.left ?? 0),
      drawerRight: Math.round(enterpriseDrawerRect?.right ?? 0),
      drawerWidth: Math.round(enterpriseDrawerRect?.width ?? 0),
      viewport: innerWidth,
      closeVisible: (() => { const r=enterpriseDrawer.querySelector('button[aria-label="关闭"]')?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })(),
      headingVisible: (() => { const r=enterpriseDrawer.querySelector('h2')?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })(),
      search: elementVisibility(enterpriseSearch),
      name: elementVisibility(enterpriseName),
      title: elementVisibility(enterpriseTitle),
    } : null,
    comparisonTableFlow: comparisonScroller && comparisonTableRect && comparisonScrollerRect && comparisonPaginationRect ? {
      rows: comparisonScroller.querySelectorAll('tbody tr:not([data-loading="true"])').length,
      clientHeight: comparisonScroller.clientHeight,
      scrollHeight: comparisonScroller.scrollHeight,
      scrollerBottom: Math.round(comparisonScrollerRect.bottom),
      tableBottom: Math.round(comparisonLastRowRect?.bottom ?? comparisonTableRect.bottom),
      paginationTop: Math.round(comparisonPaginationRect.top),
      documentScrollHeight: document.documentElement.scrollHeight,
      overflowY: getComputedStyle(comparisonScroller).overflowY,
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
      recordSeparators: comparisonRecordSeparators,
    } : null,
    comparisonNames,
    evidenceSummaries,
    ledgerExportTableGap: ledgerExport && ledgerTable
      ? Math.round(ledgerTable.getBoundingClientRect().top - ledgerExport.getBoundingClientRect().bottom)
      : null,
    ledgerExportLabel: ledgerExport ? (ledgerExport.innerText ?? ledgerExport.textContent ?? '').trim() : '',
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

async function readEnterpriseDifferenceStatus(cdp, enterpriseId, enterpriseName, injectMutedColor = false) {
  const ready = `(() => (${READY}) && !!document.querySelector('[data-testid="enterprise-difference-status"]'))()`
  const expression = injectMutedColor
    ? `(() => {
        const style = document.createElement('style');
        style.textContent = '[data-testid="enterprise-difference-status"] { color: var(--muted-foreground) !important; }';
        document.head.append(style);
        return (${MEASURE});
      })()`
    : `(${MEASURE})`
  const url = `${BASE}/?q=${encodeURIComponent(enterpriseName)}&expand=${enterpriseId}`
  const result = await openAndMeasure(cdp, url, expression, ready, VIEWPORTS[0])
  return result.enterpriseDifferenceStatuses
}

async function verifyEnterpriseDifferenceColors(cdp) {
  const samples = [
    { enterpriseId: 148, name: '宁波锦辉指针有限公司', label: '未查询' },
    { enterpriseId: 284, name: '锦浪科技股份有限公司', label: '无记录' },
    { enterpriseId: 27, name: '宁波博汇化工科技股份有限公司', label: '已确认原因' },
  ]
  const current = []
  for (const sample of samples) {
    const statuses = await readEnterpriseDifferenceStatus(cdp, sample.enterpriseId, sample.name)
    const status = statuses.find((item) => item.text === sample.label)
    if (!status) {
      bad(`企业列表 · 状态文字色:真实企业 ${sample.enterpriseId} 未渲染「${sample.label}」 ${JSON.stringify(statuses)}`)
    } else {
      current.push(status)
    }
  }

  const label = '企业列表 · 状态文字色'
  const colorIssue = enterpriseDifferenceColorViolation(current, label)
  if (colorIssue) bad(colorIssue)
  else ok(`真实抽屉计算文字色可区分确认状态(${current.map((item) => `${item.text}=${item.color}`).join('；')})`)

  const injected = await readEnterpriseDifferenceStatus(cdp, 27, '宁波博汇化工科技股份有限公司', true)
  const injectedConfirmed = injected.find((item) => item.text === '已确认原因')
  const broken = enterpriseDifferenceColorViolation(
    [...current.filter((item) => item.text !== '已确认原因'), ...(injectedConfirmed ? [injectedConfirmed] : [])],
    '状态文字色缺陷自检',
  )
  if (!broken) bad('状态文字色缺陷自检:临时抹平确认状态文字色后,计算样式断言仍未命中')
  else console.log(`✗ 状态文字色缺陷自检按预期变红:${broken}`)

  const restored = await readEnterpriseDifferenceStatus(cdp, 27, '宁波博汇化工科技股份有限公司')
  const restoredConfirmed = restored.find((item) => item.text === '已确认原因')
  const restoredIssue = enterpriseDifferenceColorViolation(
    [...current.filter((item) => item.text !== '已确认原因'), ...(restoredConfirmed ? [restoredConfirmed] : [])],
    '状态文字色恢复验证',
  )
  if (restoredIssue) bad(restoredIssue)
  else ok('状态文字色缺陷自检:关闭注入 target 后真实计算样式恢复')
}

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

    if (FOCUS_ONLY) await verifyLedgerDrawerFocus(cdp)
    if (!FOCUS_ONLY) {
    await verifyLightThemeDefault(cdp)
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
        if (page.query === '/') {
          const exportLabel = ledgerExportLabelViolation(m, label)
          if (exportLabel) bad(exportLabel)
          else ok(`${label}:导出控件可见文字为 ${JSON.stringify(m.ledgerExportLabel)}`)
        }
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
          else ok(`${label}:搜索框与筛选当前值完整可读并在视口内`)
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
          else ok(`${label}:行前没有状态块`)
          const timelineYears = timelineYearViolation(m, label)
          if (timelineYears) bad(timelineYears)
          else if (m.enterpriseTimelineYears.length) ok(`${label}:抽屉每条称号历史事件均标有年份或待核`)
          if (viewport.width >= 1024) {
            const reading = enterpriseDrawerReadingViolation(m, label)
            if (reading) bad(reading)
            else ok(`${label}:宽抽屉、企业标题与关闭入口均在视口内`)
          }
        }
        if (page.query === '/comparison') {
          const flow = comparisonTableFlowViolation(m, label)
          if (flow) bad(flow)
          else ok(`${label}:本页全部 ${m.comparisonTableFlow.rows} 行在分页前完整展开，可继续滚动页面阅读`)
        }
        if (viewport.width === 390) {
          const mobileContent = mobileCoreContentViolation(m, label)
          if (mobileContent) bad(mobileContent)
          else ok(`${label}:窄屏首行可见企业名称、业务字段及状态,表格不需横向滚动`)
          if (page.query === '/') {
            const titlePairs = titleRecognitionPairsViolation(m, label)
            if (titlePairs) bad(titlePairs)
            else ok(`${label}:每个称号与认定年保持在同一组内`)
          }
          if (page.query === '/comparison') {
            const hierarchy = comparisonRecordHierarchyViolation(m, label)
            if (hierarchy) bad(hierarchy)
            else ok(`${label}:对比记录边界强于内部细线`)
          }
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

    await verifyEnterpriseDifferenceColors(cdp)

    // 用 CDP 鼠标真实按下每个 Select,测量边界框是否缩放以及计算样式是否停用过渡。
    for (const page of PAGES) {
      const result = await measureReducedMotionSelects(cdp, page)
      const label = `${page.name} · 减少动态效果`
      const violation = reducedMotionViolation(result, label)
      if (violation) bad(violation)
      else ok(`${label}:CDP 实际按压 ${result.triggers.length} 个 Select,边界框未缩放且过渡已停用`)
    }

    const reducedMotionBroken = await measureReducedMotionSelects(cdp, PAGES[0], true)
    const reducedMotionSelfCheck = reducedMotionViolation(reducedMotionBroken, '减少动态效果缺陷自检')
    if (!reducedMotionSelfCheck) bad('减少动态效果缺陷自检:临时恢复按压缩放后行为断言仍未命中')
    else console.log(`✗ 减少动态效果缺陷自检按预期变红:${reducedMotionSelfCheck}`)
    const reducedMotionRestored = await measureReducedMotionSelects(cdp, PAGES[0])
    const restoredMotionIssue = reducedMotionViolation(reducedMotionRestored, '减少动态效果恢复验证')
    if (restoredMotionIssue) bad(restoredMotionIssue)
    else ok('减少动态效果缺陷自检:关闭注入 target 后实际按压行为恢复')

    const exportLabelBroken = await openAndMeasure(
      cdp,
      `${BASE}/`,
      `(() => { const link = document.querySelector('.ledger-page a[href^="/api/roster/export"]'); if (link) link.textContent = '导出当前筛选'; return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[0],
    )
    const exportLabelSelfCheck = ledgerExportLabelViolation(exportLabelBroken, '导出控件文字缺陷自检')
    if (!exportLabelSelfCheck) bad('导出控件文字缺陷自检:移除「企业」后页面断言仍未命中')
    else console.log(`✗ 导出控件文字缺陷自检按预期变红:${exportLabelSelfCheck}`)
    const exportLabelRestored = await openAndMeasure(cdp, `${BASE}/`, MEASURE, READY, VIEWPORTS[0])
    const restoredExportLabel = ledgerExportLabelViolation(exportLabelRestored, '导出控件文字恢复验证')
    if (restoredExportLabel) bad(restoredExportLabel)
    else ok('导出控件文字缺陷自检:关闭注入 target 后实际标签恢复')

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

    const mobileFilterValueBroken = await openAndMeasure(
      cdp,
      `${BASE}/comparison`,
      `(() => {
        const value = document.querySelector('[aria-label="按称号筛选"] [data-slot="select-value"]');
        value?.style.setProperty('width', '24px', 'important');
        value?.style.setProperty('max-width', '24px', 'important');
        value?.style.setProperty('overflow', 'hidden', 'important');
        value?.style.setProperty('text-overflow', 'ellipsis', 'important');
        return (${MEASURE});
      })()`,
      READY,
      VIEWPORTS[1],
    )
    const mobileFilterValueSelfCheck = comparisonFiltersViolation(mobileFilterValueBroken, '窄屏筛选当前值缺陷自检')
    if (!mobileFilterValueSelfCheck) bad('窄屏筛选当前值缺陷自检:临时裁切称号筛选值后,裁切断言仍未命中')
    else console.log(`✗ 窄屏筛选当前值缺陷自检按预期变红:${mobileFilterValueSelfCheck}`)
    if (mobileFilterValueSelfCheck) ok('窄屏筛选当前值缺陷自检:关闭临时 target 后缺陷已复原')

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

    const drawerReadingBroken = await openAndMeasure(
      cdp,
      `${BASE}/`,
      `(() => { document.querySelector('[data-testid="enterprise-drawer"]')?.style.setProperty('transition', 'none', 'important'); document.querySelector('[data-testid="enterprise-drawer"]')?.style.setProperty('animation', 'none', 'important'); document.querySelector('[data-testid="enterprise-drawer"]')?.style.setProperty('max-width', 'none', 'important'); document.querySelector('[data-testid="enterprise-drawer"]')?.style.setProperty('width', 'calc(100vw + 100px)', 'important'); return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[0],
    )
    const drawerReadingSelfCheck = enterpriseDrawerReadingViolation(drawerReadingBroken, '宽抽屉边界缺陷自检')
    if (!drawerReadingSelfCheck) bad('宽抽屉边界缺陷自检:临时扩大抽屉到视口之外后,边界断言仍未命中')
    else console.log(`✗ 宽抽屉边界缺陷自检按预期变红:${drawerReadingSelfCheck}`)
    if (drawerReadingSelfCheck) ok('宽抽屉边界缺陷自检:关闭临时 target 后缺陷已复原')

    const comparisonFlowBroken = await openAndMeasure(
      cdp,
      `${BASE}/comparison`,
      `(() => { const scroller = document.querySelector('[data-testid="comparison-table-scroll"]'); scroller?.style.setProperty('height', '320px', 'important'); scroller?.style.setProperty('max-height', '320px', 'important'); scroller?.style.setProperty('overflow-y', 'auto', 'important'); return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[1],
    )
    const comparisonFlowSelfCheck = comparisonTableFlowViolation(comparisonFlowBroken, '对比表分页前截断缺陷自检')
    if (!comparisonFlowSelfCheck) bad('对比表分页前截断缺陷自检:临时恢复内部滚动截断后,表格连续阅读断言仍未命中')
    else console.log(`✗ 对比表分页前截断缺陷自检按预期变红:${comparisonFlowSelfCheck}`)
    if (comparisonFlowSelfCheck) ok('对比表分页前截断缺陷自检:关闭临时 target 后缺陷已复原')

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

    const titlePairBroken = await openAndMeasure(
      cdp,
      `${BASE}/`,
      `(() => {
        const pair = document.querySelector('.ledger-page [data-testid="title-recognition-pair"]');
        pair?.style.setProperty('width', '24px', 'important');
        pair?.style.setProperty('max-width', '24px', 'important');
        pair?.style.setProperty('overflow', 'hidden', 'important');
        return (${MEASURE});
      })()`,
      READY,
      VIEWPORTS[1],
    )
    const titlePairSelfCheck = titleRecognitionPairsViolation(titlePairBroken, '称号与认定年分组缺陷自检')
    if (!titlePairSelfCheck) bad('称号与认定年分组缺陷自检:临时裁切称号年份组后,分组断言仍未命中')
    else console.log(`✗ 称号与认定年分组缺陷自检按预期变红:${titlePairSelfCheck}`)
    if (titlePairSelfCheck) ok('称号与认定年分组缺陷自检:关闭临时 target 后缺陷已复原')

    const timelineYearBroken = await openAndMeasure(
      cdp,
      `${BASE}/`,
      `(() => { const year = document.querySelector('[data-testid="enterprise-drawer"] [data-testid="timeline-event-year"]'); if (year) year.textContent = ''; return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[0],
    )
    const timelineYearSelfCheck = timelineYearViolation(timelineYearBroken, '抽屉事件年份缺陷自检')
    if (!timelineYearSelfCheck) bad('抽屉事件年份缺陷自检:临时清空一个事件年份后,年份断言仍未命中')
    else console.log(`✗ 抽屉事件年份缺陷自检按预期变红:${timelineYearSelfCheck}`)
    if (timelineYearSelfCheck) ok('抽屉事件年份缺陷自检:关闭临时 target 后缺陷已复原')

    const railBroken = await openAndMeasure(cdp, `${BASE}/`, `(() => {
      const marker = document.createElement('span');
      marker.dataset.railKind = 'confirmed';
      document.querySelector('.ledger-page tbody tr td')?.prepend(marker);
      return (${MEASURE});
    })()`, READY, VIEWPORTS[0]);
    const railSelfCheck = statusRailViolation(railBroken, '行前状态块缺陷自检');
    if (!railSelfCheck) bad('行前状态块缺陷自检:恢复状态块后断言未命中');
    else ok('行前状态块缺陷自检:恢复状态块后按预期失败');

    const comparisonRecordBroken = await openAndMeasure(
      cdp,
      `${BASE}/comparison`,
      `(() => { document.querySelector('[data-testid="comparison-record-row"]')?.style.setProperty('border-bottom-width', '1px', 'important'); return (${MEASURE}); })()`,
      READY,
      VIEWPORTS[1],
    )
    const comparisonRecordSelfCheck = comparisonRecordHierarchyViolation(comparisonRecordBroken, '手机对比记录边界缺陷自检')
    if (!comparisonRecordSelfCheck) bad('手机对比记录边界缺陷自检:临时减弱记录边界后,层级断言仍未命中')
    else console.log(`✗ 手机对比记录边界缺陷自检按预期变红:${comparisonRecordSelfCheck}`)
    if (comparisonRecordSelfCheck) ok('手机对比记录边界缺陷自检:关闭临时 target 后缺陷已复原')

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

    await verifyPlatformRecordTables(cdp)
    await verifyLedgerCompactSummaries(cdp)
    await verifyLedgerSearchLoading(cdp)
    await verifyLedgerMobileLoadingOverflow(cdp)
    await verifyLedgerDrawerAsyncClose(cdp)
    await verifyLedgerDrawerFocus(cdp)
    await verifyMissingRecognitionYearAndEvidence(cdp)
    await verifyCurrentNameAliasDisplay(cdp)
    await verifyComparisonCurrentNameAliasDisplay(cdp)
    await verifyComparisonExportFilters(cdp)
    await verifyNextReviewFlagBinding(cdp)
    await verifyNextReviewDetails(cdp)
    await verifyKaichengExample(cdp)
    await verifyTimelineConnections(cdp)
    await verifyUnknownReviewOutcomeExample(cdp)
    await verifyLedgerReasonFilter(cdp)
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
    if (!comparisonCopy.headers.includes('平台解释') || !comparisonCopy.headers.includes('平台记录')) {
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
  if (FOCUS_ONLY) console.log('✓ 抽屉焦点回归已覆盖关闭按钮与外部点击')
  else console.log('✓ 企业列表与比对页已覆盖桌面/390px/720px、表格唯一性、搜索与加载、分页、排序、抽屉动效及 /roster 查询串重定向')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
