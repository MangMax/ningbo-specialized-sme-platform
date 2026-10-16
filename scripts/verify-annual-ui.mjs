#!/usr/bin/env node
/**
 * RL-07 的**真实浏览器**验收:`nuxt build` → 起 `.output/server/index.mjs`(指向一个**临时库**)
 * → 真 Chrome 打开 `/annual-update` → 按 390×844 与 1440×900 两种视口**量像素与数字**。
 *
 * ── 为什么必须真浏览器 ──────────────────────────────────────────────────
 * 这一页要验的两件事都只有在**真排版 + 真后端**下才成立:
 *  1. **窄屏不撑破页面**:`documentElement.scrollWidth ≤ clientWidth`(宽表必须**在卡片内部
 *     横向滚动**,而不是把整页拉宽)。vitest 跑在裸 node 下(`environment: 'node'`),
 *     没有排版引擎,jsdom 的 `scrollWidth` 永远是 0 —— 量不出真东西;
 *  2. **页面上写出来的数字 = 后端算出来的数字**:预览的三栏计数、逐项冲突文案、以及
 *     「应用」之后批次流水里真的多出一条 —— 这些要打真接口。
 *
 * ── 零依赖 ──────────────────────────────────────────────────────────────
 * 与 `scripts/verify-ledger-ui.mjs` 同一分法:Chrome 走 CDP,连接用 Node 内置 `WebSocket`。
 * 那份脚本的 CDP 管道**没有**抽成公共模块(它是 RL-17 的交付物,本票不去动别人的领地),
 * 故这里按同一写法各留一份 —— 两处都只用到 `Target.createTarget` / `Runtime.evaluate`。
 *
 * ── 自带库与种子 ────────────────────────────────────────────────────────
 * worktree 里 `data/roster.db` 是空的,所以脚本自己造一个**临时库**,并用**公开写入 API**
 * (`POST /api/roster/import/commit`,带 token)种进「去年末」的状态 —— 不直写 SQL,
 * 与页面用的是同一套身份规则。
 *
 * 用法:`node scripts/verify-annual-ui.mjs [--port 3493] [--skip-build] [--headful]`
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
const PORT = Number(flag('port', '3493'))
const DEBUG_PORT = PORT + 1
const SKIP_BUILD = args.includes('--skip-build')
const HEADFUL = args.includes('--headful')
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'rl07-annual-ui-token'

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
// 极简 CDP 客户端(只用到 createTarget / evaluate)
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

async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? JSON.stringify(res.exceptionDetails))
  return res.result.value
}

/** 轮询到条件成立;**等不到就判失败**,绝不静默跳过(与 ledger 脚本同一条纪律)。 */
async function waitUntil(cdp, sessionId, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, expression)) return true
    await sleep(300)
  }
  return false
}

/**
 * 打开一页、等就绪、执行一段脚本。**每次新建 target**:同一 target 反复 navigate 会带上
 * 上一页的滚动位置与 `documentElement` 状态,量出来的宽度偶尔是上一页的。
 */
async function withPage(cdp, viewport, fn) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: `${BASE}/annual-update` }, sessionId)
    const ready = await waitUntil(
      cdp,
      sessionId,
      `(() => !!document.querySelector('[data-testid=annual-payload]') && !document.querySelector('[data-slot=skeleton]'))()`,
    )
    if (!ready) throw new Error('/annual-update 在 30s 内没有渲染出载荷输入框 —— 量不出东西,按失败算')
    return await fn(sessionId)
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// 页面里的操作(全部走真实 DOM 事件,不调内部函数)
// ---------------------------------------------------------------------------

/** 把载荷写进 textarea 并触发 `input`(Vue 的 `v-model` 才认)。 */
const setPayload = (bundle) => `(() => {
  const el = document.querySelector('[data-testid=annual-payload]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(JSON.stringify(bundle))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`

const clickByText = (text) => `(() => {
  const button = [...document.querySelectorAll('button')].find((el) => (el.textContent ?? '').includes(${JSON.stringify(text)}));
  if (!button) return false;
  if (button.disabled) return 'disabled';
  button.click();
  return true;
})()`

/** 量:页面级溢出、三栏计数、计数格子、冲突文案、应用按钮是否可用。 */
const MEASURE = `(() => {
  const de = document.documentElement;
  const cells = [...document.querySelectorAll('[data-count-cell]')].map((el) => {
    const spans = [...el.querySelectorAll('span')];
    return { label: (spans[0]?.textContent ?? '').trim(), value: Number((spans[1]?.textContent ?? '0').trim()) };
  });
  const buckets = {};
  for (const card of document.querySelectorAll('[data-bucket]')) {
    const badge = card.querySelector('[data-slot=badge]');
    buckets[card.getAttribute('data-bucket')] = Number((badge?.textContent ?? '0').trim());
  }
  const scrollers = [...document.querySelectorAll('.overflow-auto, .overflow-x-auto')];
  const conflictText = [...document.querySelectorAll('td')]
    .map((td) => (td.textContent ?? '').trim())
    .filter((t) => t.includes('evidence_query_failed'));
  const applyButton = [...document.querySelectorAll('button')].find((el) => (el.textContent ?? '').includes('确认应用'));
  // 溢出时**点名到元素**:只说「溢出 20px」等于把定位工作丢给下一个人。
  const offenders = [...document.querySelectorAll('body *')]
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => rect.right > de.clientWidth + 0.5 || rect.left < -0.5)
    .slice(0, 6)
    .map(({ el, rect }) => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute('class') ?? '').slice(0, 90),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    }));
  return {
    title: document.title,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    innerWidth: window.innerWidth,
    offenders,
    cells, buckets,
    bucketRows: document.querySelectorAll('[data-bucket] tbody tr').length,
    itemRows: itemTableRowCount(),
    conflictText,
    blockedWarning: (document.querySelector('[data-testid=annual-blocked-warning]')?.textContent ?? '').replace(/\s+/g, '').trim(),
    bucketLabels: [...document.querySelectorAll('[data-bucket]')].map((card) =>
      (card.querySelector('h3, [data-slot=card-title]')?.textContent ?? '').replace(/\s+/g, ' ').trim()),

    applyDisabled: applyButton ? applyButton.disabled : null,
    horizontalScrollingContainers: scrollers.filter((el) => el.scrollWidth > el.clientWidth).length,
  };
  function itemTableRowCount() {
    const tables = [...document.querySelectorAll('table')];
    const table = tables.find((t) => [...t.querySelectorAll('thead th')].some((th) => (th.textContent ?? '').includes('分类')));
    return table ? table.querySelectorAll('tbody tr').length : -1;
  }
})()`

// ---------------------------------------------------------------------------
// 夹具:去年的库状态 + 今年这一批
// ---------------------------------------------------------------------------

const U = {
  platformOnly: '91330200000000001A',
  announced: '91330200000000002B',
  renewal: '91330200000000003C',
}
const NAME = {
  platformOnly: '宁波仅平台企业有限公司',
  announced: '宁波有公布历史企业有限公司',
  renewal: '宁波年度新认定企业有限公司',
}

function seedRequests() {
  return [
    {
      idempotencyKey: 'ui-seed/miit',
      sourceKind: 'announcement',
      sourceIdentity: 'miit/seed/platform-only',
      payload: {
        announcement: {
          sourceDocument: { source: 'miit', title: '平台侧导入(验收夹具)', docNumber: null },
          records: [
            { enterprise: { name: NAME.platformOnly, uscc: U.platformOnly }, titleCode: 'specialized_sme' },
            { enterprise: { name: NAME.announced, uscc: U.announced }, titleCode: 'specialized_sme' },
          ],
        },
      },
    },
    {
      idempotencyKey: 'ui-seed/export/2025',
      sourceKind: 'platform_export',
      sourceIdentity: 'miit/export/2025/specialized_sme.xlsx',
      payload: {
        exportSnapshot: {
          titleCode: 'specialized_sme',
          year: 2025,
          collectedOn: '2025-12-31',
          originalFilename: 'specialized_sme-2025.xlsx',
          sha256: 'ui-seed-2025',
          rows: [
            { sourceRowNo: 1, usccRaw: U.platformOnly, nameRaw: NAME.platformOnly },
            { sourceRowNo: 2, usccRaw: U.announced, nameRaw: NAME.announced },
          ],
        },
      },
    },
    {
      idempotencyKey: 'ui-seed/jxj/2022',
      sourceKind: 'announcement',
      sourceIdentity: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf',
      payload: {
        announcement: {
          sourceDocument: { source: 'jxj', title: '2022 年度认定(验收夹具)', docNumber: '甬经信中小〔2022〕145号' },
          records: [
            {
              enterprise: { name: NAME.announced, uscc: U.announced },
              titleCode: 'specialized_sme',
              events: [
                {
                  eventType: 'award',
                  year: 2022,
                  batchSeq: 1,
                  evidence: [{ sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf', attachment: '附件1', listNo: 1, page: 3 }],
                },
              ],
            },
          ],
        },
      },
    },
  ]
}

/** 今年这一批:新认定一家 + 一张 2026 导出表(去年两家都不在里面)。 */
function annualBundle() {
  return {
    year: 2026,
    entries: [
      {
        idempotencyKey: 'ui-annual/jxj/2026/192号',
        sourceKind: 'announcement',
        sourceIdentity: 'jxj/announcement/2026/甬经信中小〔2026〕192号.pdf',
        payload: {
          announcement: {
            sourceDocument: { source: 'jxj', title: '2026 年度认定(验收夹具)', docNumber: '甬经信中小〔2026〕192号' },
            records: [
              {
                enterprise: { name: NAME.renewal, uscc: U.renewal },
                titleCode: 'specialized_sme',
                events: [
                  {
                    eventType: 'award',
                    year: 2026,
                    batchSeq: 1,
                    evidence: [{ sourceFile: 'jxj/announcement/2026/甬经信中小〔2026〕192号.pdf', attachment: '附件1', listNo: 1, page: 5 }],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        idempotencyKey: 'ui-annual/export/2026',
        sourceKind: 'platform_export',
        sourceIdentity: 'miit/export/2026/specialized_sme.xlsx',
        payload: {
          exportSnapshot: {
            titleCode: 'specialized_sme',
            year: 2026,
            collectedOn: '2026-10-01',
            originalFilename: 'specialized_sme-2026.xlsx',
            sha256: 'ui-annual-2026',
            rows: [{ sourceRowNo: 1, usccRaw: U.renewal, nameRaw: NAME.renewal }],
          },
        },
      },
    ],
  }
}

/** 同一批,但把「仅平台」那家的重查记成**失败**,并据此写一条已确认原因。 */
function conflictedBundle() {
  const bundle = annualBundle()
  bundle.entries[0].payload.platformQueries = [
    {
      interface: 'business_list',
      queryKey: U.platformOnly,
      rdjb: '2',
      queriedAt: '2026-10-01T02:00:00.000Z',
      status: 'failed',
      failureReason: '登录超时',
    },
  ]
  bundle.entries[0].payload.differences = [
    {
      uscc: U.platformOnly,
      titleCode: 'specialized_sme',
      direction: 'extra_in_miit',
      status: 'confirmed_reason',
      reasonCode: 'moved_out',
      measureCode: 'mark_moved_out',
      verificationStatus: 'confirmed',
      recordedAt: '2026-10-01T03:00:00.000Z',
      evidenceQueryRef: { interface: 'business_list', queryKey: U.platformOnly, rdjb: '2' },
    },
  ]
  return bundle
}

/** 同一批,但重查**成功且返回 0 条** ⇒ 这是 no_record 口径,写 query_failed 就不对。 */
function failedQueryOnlyBundle() {
  const bundle = annualBundle()
  bundle.entries[0].payload.platformQueries = [
    {
      interface: 'business_list',
      queryKey: U.platformOnly,
      rdjb: '2',
      queriedAt: '2026-10-01T02:00:00.000Z',
      status: 'failed',
      failureReason: '登录超时',
    },
  ]
  return bundle
}

async function commitViaApi(request) {
  const response = await fetch(`${BASE}/api/roster/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-token': TOKEN },
    body: JSON.stringify(request),
  })
  const body = await response.json()
  if (response.status !== 200 || body.status !== 'committed') {
    throw new Error(`种库失败(${response.status}):${JSON.stringify(body)}`)
  }
  return body
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const EXPECTED_COUNTS = { 新增: 2, 更新: 0, 归并: 0, 无变化: 0, 待核实: 0, 冲突: 0 }
const EXPECTED_BUCKETS = { removed: 1, blocked: 0, keptByAnnouncement: 1 }

async function main() {
  if (!SKIP_BUILD) {
    console.log('▶ pnpm build')
    await run('pnpm', ['build'])
  }
  if (!existsSync('.output/server/index.mjs')) {
    throw new Error('没有 .output/server/index.mjs —— 先 pnpm build,或去掉 --skip-build')
  }

  const workDir = mkdtempSync(join(tmpdir(), 'rl07-annual-ui-'))
  const dbPath = join(workDir, 'roster.db')
  const userDataDir = mkdtempSync(join(tmpdir(), 'rl07-chrome-'))
  console.log(`▶ 起生产产物:PORT=${PORT} NUXT_DB_PATH=${dbPath}`)
  const server = spawn('node', ['.output/server/index.mjs'], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: TOKEN },
  })
  let chrome
  let cdp
  try {
    await waitForHttp(`${BASE}/api/health`)

    console.log('▶ 用公开写入 API 种进「去年末」的状态')
    for (const request of seedRequests()) await commitViaApi(request)

    const chromeBin =
      process.env.CHROME_BIN ??
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => existsSync(p))
    if (!chromeBin) throw new Error('找不到 Chrome(可用 CHROME_BIN 指定)')
    console.log(`▶ 起 Chrome 调试端口 ${DEBUG_PORT}`)
    chrome = spawn(
      chromeBin,
      [
        ...(HEADFUL ? [] : ['--headless=new']),
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

    // ---- ① 窄屏:预览渲染 + 数字 + 不撑破页面 ---------------------------
    for (const viewport of [
      { name: '窄屏 390×844', width: 390, height: 844 },
      { name: '桌面 1440×900', width: 1440, height: 900 },
    ]) {
      await withPage(cdp, viewport, async (sessionId) => {
        const label = viewport.name
        if (!(await evaluate(cdp, sessionId, setPayload(annualBundle())))) throw new Error(`${label}:注入载荷失败`)
        const clicked = await evaluate(cdp, sessionId, clickByText('运行预览'))
        if (clicked !== true) throw new Error(`${label}:点不到「运行预览」(${clicked})`)
        const ready = await waitUntil(cdp, sessionId, `(() => document.querySelectorAll('[data-count-cell]').length === 6)()`)
        if (!ready) throw new Error(`${label}:预览没有渲染出来 —— 量不出东西,按失败算`)
        const m = await evaluate(cdp, sessionId, MEASURE)

        if (m.scrollWidth > m.clientWidth) {
          bad(
            `${label}:页面级横向溢出 ${m.scrollWidth - m.clientWidth}px(scrollWidth ${m.scrollWidth} / clientWidth ${m.clientWidth})\n    越界元素:${JSON.stringify(m.offenders, null, 0)}`,
          )
        } else {
          ok(`${label}:无页面级横向溢出(scrollWidth ${m.scrollWidth} ≤ clientWidth ${m.clientWidth})`)
        }
        for (const [name, value] of Object.entries(EXPECTED_COUNTS)) {
          const cell = m.cells.find((c) => c.label === name)
          if (!cell) bad(`${label}:没有「${name}」这一格`)
          else if (cell.value !== value) bad(`${label}:「${name}」= ${cell.value},预期 ${value}`)
          else ok(`${label}:「${name}」= ${value}`)
        }
        for (const [key, value] of Object.entries(EXPECTED_BUCKETS)) {
          if (m.buckets[key] !== value) bad(`${label}:总表增减「${key}」= ${m.buckets[key]},预期 ${value}`)
          else ok(`${label}:总表增减「${key}」= ${value}(共 ${m.bucketRows} 行可查看)`)
        }
        if (m.itemRows !== 2) bad(`${label}:逐项明细行数 = ${m.itemRows},预期 2`)
        else ok(`${label}:逐项明细 ${m.itemRows} 行`)
        // 窄屏下宽表必须**在卡片内部**横向滚动,而不是把整页拉宽。
        if (m.horizontalScrollingContainers < 1) {
          bad(`${label}:没有量到任何「内部横向滚动」的容器 —— 窄屏下宽表会撑破页面`)
        } else {
          ok(`${label}:有 ${m.horizontalScrollingContainers} 个容器在内部横向滚动(宽表没有撑破页面)`)
        }
        if (m.applyDisabled) bad(`${label}:「确认应用」在可应用时是禁用的`)
        else ok(`${label}:「确认应用」可用`)
        if (!m.title || !m.title.trim()) bad(`${label}:document.title 是空字符串`)
        else ok(`${label}:document.title = ${JSON.stringify(m.title)}`)
      })
    }

    // ---- ② 冲突:失败查询不得下结论；按钮必须禁用 ------------------------
    await withPage(cdp, { width: 390, height: 844 }, async (sessionId) => {
      await evaluate(cdp, sessionId, setPayload(conflictedBundle()))
      await evaluate(cdp, sessionId, clickByText('运行预览'))
      const ready = await waitUntil(cdp, sessionId, `(() => document.querySelectorAll('[data-count-cell]').length === 6)()`)
      if (!ready) throw new Error('冲突用例:预览没有渲染出来')
      const m = await evaluate(cdp, sessionId, MEASURE)
      if (!m.conflictText.some((text) => text.includes('evidence_query_failed'))) {
        bad('冲突用例:逐项明细里没有出现 `evidence_query_failed`')
      } else {
        ok(`冲突用例:逐项明细点名了证据查询失败(${m.conflictText.length} 行)`)
      }
      if (m.applyDisabled !== true) bad(`冲突用例:「确认应用」应当禁用,实测 disabled=${m.applyDisabled}`)
      else ok('冲突用例:「确认应用」已禁用(整批不会落任何业务数据)')
      const conflicts = m.cells.find((c) => c.label === '冲突')
      if (conflicts?.value !== 1) bad(`冲突用例:冲突计数 = ${conflicts?.value},预期 1`)
      else ok('冲突用例:冲突计数 = 1')
    })

    // ---- ③ 接口失败 ⇒ 那家企业进「待核」,不列入「将移出」 ---------------
    await withPage(cdp, { width: 390, height: 844 }, async (sessionId) => {
      await evaluate(cdp, sessionId, setPayload(failedQueryOnlyBundle()))
      await evaluate(cdp, sessionId, clickByText('运行预览'))
      const ready = await waitUntil(cdp, sessionId, `(() => document.querySelectorAll('[data-count-cell]').length === 6)()`)
      if (!ready) throw new Error('接口失效用例:预览没有渲染出来')
      const m = await evaluate(cdp, sessionId, MEASURE)
      if (m.buckets.removed !== 0 || m.buckets.blocked !== 1) {
        bad(`接口失效用例:removed=${m.buckets.removed} / blocked=${m.buckets.blocked},预期 0 / 1`)
      } else {
        ok('接口失效用例:重查失败的企业进「不得据此写原因」这一栏,不计入「将移出」')
      }
      // 页面上**必须**把「移出照样发生、被挡住的是原因」这句话说出来(独立审查点出的口径)。
      if (!m.blockedWarning.includes('重查失败')) {
        bad(`接口失效用例:没有看到「重查失败」的告警条(实测 ${JSON.stringify(m.blockedWarning.slice(0, 40))})`)
      } else if (!m.blockedWarning.includes('原因不会被写下来')) {
        bad('接口失效用例:告警条没有说清「被挡住的是原因」')
      } else {
        ok('接口失效用例:应用之前就说清了 —— 移出照样发生,被挡住的是原因')
      }
      if (m.bucketLabels.some((label) => label.includes('不得据此删除'))) {
        bad(`接口失效用例:第三栏仍写着「不得据此删除」这种做不到的话:${JSON.stringify(m.bucketLabels)}`)
      } else {
        ok(`接口失效用例:三栏标题用的是能做到的说法 ${JSON.stringify(m.bucketLabels)}`)
      }
    })

    // ---- ④ 应用:预览说会怎样,应用之后批次流水里真的多出来 --------------
    await withPage(cdp, { width: 1440, height: 900 }, async (sessionId) => {
      await evaluate(cdp, sessionId, setPayload(annualBundle()))
      await evaluate(cdp, sessionId, clickByText('运行预览'))
      const ready = await waitUntil(cdp, sessionId, `(() => document.querySelectorAll('[data-count-cell]').length === 6)()`)
      if (!ready) throw new Error('应用用例:预览没有渲染出来')
      const typed = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const input = document.querySelector('#annual-token');
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(TOKEN)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`,
      )
      if (typed !== true) throw new Error('应用用例:没找到 token 输入框')
      if ((await evaluate(cdp, sessionId, clickByText('确认应用'))) !== true) {
        throw new Error('应用用例:点不到「确认应用」')
      }
      if (!(await waitUntil(cdp, sessionId, `(() => !!document.querySelector('[data-slot=dialog-content]'))()`))) {
        throw new Error('应用用例:确认对话框没有打开')
      }
      // 对话框里那个「确认应用」是最后一个同名按钮。
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const buttons = [...document.querySelectorAll('[data-slot=dialog-content] button')].filter((el) => (el.textContent ?? '').includes('确认应用'));
          const button = buttons[buttons.length - 1];
          if (!button) return false;
          button.click();
          return true;
        })()`,
      )
      const done = await waitUntil(
        cdp,
        sessionId,
        `(() => (document.querySelector('[data-testid=annual-apply-results]')?.textContent ?? '').includes('写入'))()`,
      )
      if (!done) {
        bad('应用用例:应用之后页面上没有出现逐项结果')
      } else {
        const text = await evaluate(cdp, sessionId, `document.querySelector('[data-testid=annual-apply-results]').textContent`)
        ok(`应用用例:页面回报了逐项结果 —— ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
      }
      // 批次流水里应当多出刚刚那两批(种库 3 批 + 应用 2 批 = 5 批)。
      const batches = await evaluate(
        cdp,
        sessionId,
        `(() => [...document.querySelectorAll('tbody tr')].filter((tr) => (tr.textContent ?? '').includes('ui-annual')).length)()`,
      )
      if (batches !== 2) bad(`应用用例:批次流水里 ui-annual 批次 = ${batches},预期 2`)
      else ok('应用用例:批次流水里能看到刚应用的 2 条批次(可追溯)')
    })

    // ---- ⑤ 幂等:「应用」之后同一个包再预览 ⇒ 如实报零 --------------------
    await withPage(cdp, { width: 1440, height: 900 }, async (sessionId) => {
      await evaluate(cdp, sessionId, setPayload(annualBundle()))
      await evaluate(cdp, sessionId, clickByText('运行预览'))
      const ready = await waitUntil(cdp, sessionId, `(() => document.querySelectorAll('[data-count-cell]').length === 6)()`)
      if (!ready) throw new Error('幂等用例:预览没有渲染出来')
      const m = await evaluate(cdp, sessionId, MEASURE)
      const nonZero = m.cells.filter((c) => c.value !== 0)
      if (nonZero.length) bad(`幂等用例:已提交的键应当**如实报零**,实测 ${JSON.stringify(nonZero)}`)
      else ok('幂等用例:已提交的键如实报零(同键再提交一行都不会写)')
      if (m.applyDisabled !== true) bad(`幂等用例:「确认应用」应当禁用(没有什么会写)`)
      else ok('幂等用例:「确认应用」已禁用')
    })
  } finally {
    cdp?.ws?.close?.()
    chrome?.kill()
    server.kill()
    // Chrome 被 kill 之后还会往 user-data-dir 里写一小会儿 ⇒ 立刻 `rmSync` 会 ENOTEMPTY。
    // 临时目录清不掉不该把验收判成失败,所以等一下再尽力删。
    await sleep(500)
    for (const dir of [workDir, userDataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 留在 tmp 里无妨 */
      }
    }
  }

  console.log('')
  if (problems.length) {
    console.log(`✗ ${problems.length} 条不符合预期`)
    process.exit(1)
  }
  console.log('✓ 全部通过')
}

await main()
