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
 * ── RL-08 追加(2026-10-16)──────────────────────────────────────────────
 * 同一个脚本再守两件事,判据都对着**接口给的真实数**,不是「页面上有几个字」:
 *  - ⑦ **首次认定筛选**能深链(`?firstYear=…` / `?firstStatus=pending`),页面上
 *    「共 N 家企业」必须等于同一筛选下 `/api/roster/enterprises` 的 `counts.total`,
 *    且窄屏(390)不产生页面级横向溢出;
 *  - ⑧ **改筛选时显示加载状态**。加载态只存在几百毫秒,不拖慢就量不到,而「量不到」
 *    与「没有」在这类断言里长得一样 —— 所以先用 CDP 把网络延迟拖到 1.2s,再走页面自己的
 *    搜索框(不换 URL ⇒ 不走首屏加载路径),在 4s 窗口里轮询那个标记。
 *
 * ⚠️ 数据不在位时(没给 `NUXT_DB_PATH`、库里没有首次认定)断言**判失败**,不静默跳过:
 * 一个「检查自己把自己跳过去」的验收比没有验收更坏。
 *
 * ⚠️ 真库里 `pending`(待确认)是 **0 家**(9946 条认定一条都不缺年份、不缺出处),
 * 所以「待确认」那一档要靠 `node scripts/make-rl08-pending-db.mjs` 造的库跑第二轮 ——
 * 否则那几条断言只是 0 == 0 的空跑。
 *
 * 用法:`NUXT_DB_PATH=<真库> node scripts/verify-ledger-ui.mjs [--port 3491] [--skip-build]`
 * 退出码 0 = 全部通过;非 0 = 有一条不符合预期(并打印实测数字)。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
/** `--shots <目录>`:把两个关键视图各存一张 PNG,供人**用眼睛**再看一遍(自动化断言之外的补充)。 */
const SHOTS_DIR = flag('shots', '')
const BASE = `http://127.0.0.1:${PORT}`

/** 窄屏。与盲测一致:iPhone 12/13 的逻辑宽度。 */
const VIEWPORT = { width: 390, height: 844 }

/**
 * 桌面。**桌面与窄屏都要量**(票面要求),而且两张宽度抓的不是同一类毛病:
 * 窄屏抓溢出,桌面抓「列宽不够导致的裁字」—— 首次认定那一列是按实测宽度切过的
 * (`components/RosterEnterpriseTable.vue` 顶部那段),多一个标记就可能把它挤断。
 */
const DESKTOP = { width: 1440, height: 900 }

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
async function openAndMeasure(cdp, url, expression, readyExpression, viewport = VIEWPORT) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, sessionId)
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

/**
 * 打开页面并**在页面里跑一段交互**(不重新导航),用来量「不换 URL 的筛选」——
 * 那种情况不会触发首屏加载,正好量到「改了筛选、结果还在路上」的那一段。
 */
async function openAndRun(cdp, url, readyExpression, viewport = VIEWPORT) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)
  const ready = await waitUntil(cdp, sessionId, readyExpression)
  if (!ready) throw new Error(`${url} 在 30s 内没有渲染出数据行 —— 量不出东西,按失败算`)
  return { sessionId, targetId }
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
  !!document.querySelector('[data-slot=pagination]')
))()`

/**
 * 展开面板里那枚「首次认定」标记的抓手。**按 `data-testid` 认,不按文案认**:
 * 文案随状态变(已确立 ⇒「首次认定」,待确认 ⇒「已知最早的认定(待确认)」),
 * 靠文案选就会在待确认那一屏上静默选不到 —— 而「选不到」正是这一条要抓的东西。
 */
const FIRST_MARK = '[data-testid=first-recognition-mark]'

/**
 * 就绪判据(筛不中任何东西时用):**没有骨架屏**、且**计数行已经写出「共 N 家」**。
 *
 * 不能只判「没有骨架屏」—— 那个条件在取数之前就成立了,量到的会是空字符串,
 * 而空字符串与「这一筛真的没有结果」在这类断言里长得一样。
 */
const READY_COUNTS = `(() => (
  !document.querySelector('[data-slot=skeleton]') &&
  /共\\s*[\\d,]+\\s*家/.test(document.querySelector('[data-testid=ledger-counts]')?.textContent ?? '')
))()`

/**
 * 存一张 PNG(只在给了 `--shots` 时)。**不是断言**,是给人眼看的补充:
 * 断言守的是「有没有、对不对」,布局好不好看只有人看得出来。
 */
async function shot(cdp, sessionId, name) {
  if (!SHOTS_DIR) return
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)
    mkdirSync(SHOTS_DIR, { recursive: true })
    const file = `${SHOTS_DIR}/${name}.png`
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`▤ 截图 ${file}`)
  } catch (err) {
    console.log(`▤ 截图失败(${name}):${err.message}`)
  }
}

/** 从计数行里取「共 N 家企业」的那个 N(页面用 zh-CN 千分位,去掉逗号再比)。 */
function shownEnterpriseTotal(text) {
  const m = /共\s*([\d,]+)\s*家/.exec(text ?? '')
  return m ? Number(m[1].replace(/,/g, '')) : NaN
}

// ---------------------------------------------------------------------------
// 要验的三个视图
// ---------------------------------------------------------------------------

const VIEWS = [
  { name: '按企业(默认)', query: '' },
  { name: '按企业×称号', query: '?view=title' },
  { name: '差异与原因', query: '?view=difference' },
]

/** 在页面里量:页面级横向溢出、分页条是否越界、标题。 */
const MEASURE = `(() => {
  const de = document.documentElement;
  const pagination = document.querySelector('[data-slot=pagination]');
  const rect = pagination ? pagination.getBoundingClientRect() : null;
  return {
    title: document.title,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    innerWidth: window.innerWidth,
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

    for (const view of VIEWS) {
      const url = `${BASE}/${view.query}`
      const m = await openAndMeasure(cdp, url, MEASURE, READY)
      const label = `${view.name}(${view.query || '/'})`

      // ① 窄屏页面级横向溢出
      if (m.scrollWidth > m.clientWidth) {
        bad(`${label}:页面级横向溢出 ${m.scrollWidth - m.clientWidth}px(scrollWidth ${m.scrollWidth} / clientWidth ${m.clientWidth})`)
      } else {
        ok(`${label}:无页面级横向溢出(scrollWidth ${m.scrollWidth} ≤ clientWidth ${m.clientWidth})`)
      }

      // ② 分页条自己不许越界(它就是上次溢出的元凶)
      if (m.pagination) {
        if (m.pagination.right > m.innerWidth) {
          bad(`${label}:分页条越界,right=${m.pagination.right} > innerWidth=${m.innerWidth}`)
        } else {
          ok(
            `${label}:分页条在视口内(right ${m.pagination.right} ≤ ${m.innerWidth},宽 ${m.pagination.width},占 ${m.paginationRows} 行)`,
          )
        }
      } else {
        bad(`${label}:没量到分页条 —— 这一页有数据就必须有分页条,量不到说明断言被跳过了`)
      }

      // ③ 标题(盲测报三个视图都是空字符串)
      if (!m.title || !m.title.trim()) {
        bad(`${label}:document.title 是空字符串`)
      } else {
        ok(`${label}:document.title = ${JSON.stringify(m.title)}`)
      }
    }

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

    // ── ⑦ 首次认定筛选(RL-08):深链生效、计数与接口一致、窄屏不溢出 ────────
    //
    // 判据取**接口给的真实数**:页面上的「共 N 家企业」必须等于同一筛选下
    // `/api/roster/enterprises` 的 `counts.total`。这样断言的是「URL → 筛选 → 取数 → 渲染」
    // 整条链,而不是「页面上有几个字」。
    const json = async (path) => {
      const res = await fetch(`${BASE}${path}`)
      if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
      return res.json()
    }

    const recognitions = await json('/api/roster/recognitions?pageSize=200')
    if (!recognitions.rows.length) {
      bad('首次认定清单是空的 —— 数据没就位(要用 NUXT_DB_PATH 指向真库),量不到东西不算通过')
    } else {
      const sample = recognitions.rows.find((r) => r.status === 'confirmed' && r.firstYear != null)
      if (!sample) {
        bad('首次认定清单里没有一条 confirmed(带年份与出处)的样例 —— 这条验收退化了')
      } else {
        const year = String(sample.firstYear)
        // 对照组:不筛时有多少家。**筛选必须真的筛掉东西** —— 只比「页面 = 接口」的话,
        // 万一 `firstYear` 整条链被丢掉(参数没解析、判据没接上),两边会一起错成同一个数,
        // 断言照样全绿。那正是本脚本开头警告的「假的安心」。
        const unfiltered = await json('/api/roster/enterprises?pageSize=1')
        const expected = await json(`/api/roster/enterprises?firstYear=${year}&pageSize=1`)
        if (!(expected.counts.total < unfiltered.counts.total)) {
          bad(
            `首次认定筛选没有真的筛掉东西(firstYear=${year} → ${expected.counts.total} 家,不筛 → ${unfiltered.counts.total} 家)`,
          )
        } else {
          ok(
            `首次认定筛选确实生效:firstYear=${year} → ${expected.counts.total} 家,不筛 → ${unfiltered.counts.total} 家`,
          )
        }
        const m = await openAndMeasure(
          cdp,
          `${BASE}/?firstYear=${year}`,
          `(() => {
            const de = document.documentElement;
            return {
              search: location.search,
              scrollWidth: de.scrollWidth,
              clientWidth: de.clientWidth,
              counts: document.querySelector('[data-testid=ledger-counts]')?.textContent ?? '',
              chips: [...document.querySelectorAll('[data-testid=filter-chip]')].map((el) => el.textContent?.trim() ?? ''),
            };
          })()`,
          READY_COUNTS,
        )
        const shownTotal = shownEnterpriseTotal(m.counts)
        if (shownTotal !== expected.counts.total) {
          bad(
            `首次认定筛选:页面显示的企业数与接口不一致(接口 counts.total=${expected.counts.total},页面读到 ${shownTotal}「${m.counts.trim()}」)`,
          )
        } else {
          ok(`首次认定筛选 firstYear=${year}:页面「共 ${expected.counts.total} 家企业」= 接口计数`)
        }
        if (!m.search.includes(`firstYear=${year}`)) {
          bad(`首次认定筛选没进地址栏(location.search=${m.search})`)
        } else if (!m.chips.some((t) => t.includes(year))) {
          bad(`地址栏有 firstYear 但页面上看不到这一条筛选(chips=${JSON.stringify(m.chips)})`)
        } else {
          ok(`首次认定筛选可深链:address=${m.search},页面有 chip「${m.chips.find((t) => t.includes(year))}」`)
        }
        if (m.scrollWidth > m.clientWidth) {
          bad(`首次认定筛选:窄屏页面级横向溢出 ${m.scrollWidth - m.clientWidth}px`)
        } else {
          ok(`首次认定筛选:窄屏无横向溢出(${m.scrollWidth} ≤ ${m.clientWidth})`)
        }
      }

      const pending = await json('/api/roster/enterprises?firstStatus=pending&pageSize=1')
      const p = await openAndMeasure(
        cdp,
        `${BASE}/?firstStatus=pending`,
        `(() => ({
          search: location.search,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          counts: document.querySelector('[data-testid=ledger-counts]')?.textContent ?? '',
          chips: [...document.querySelectorAll('[data-testid=filter-chip]')].map((el) => el.textContent?.trim() ?? ''),
          rows: [...document.querySelectorAll('tbody tr')].map((tr) => tr.textContent ?? ''),
        }))()`,
        // 待确认为 0 家时表格是空的(没有分页条)⇒ 就绪判据看计数行,不看分页条。
        READY_COUNTS,
      )
      const shownPending = shownEnterpriseTotal(p.counts)
      if (shownPending !== pending.counts.total) {
        bad(`首次认定状态筛选:页面读到 ${shownPending} 与接口 counts.total=${pending.counts.total} 不一致`)
      } else if (!p.chips.some((t) => t.includes('待确认'))) {
        bad(`首次认定状态筛选:地址栏有 firstStatus 但页面上看不到这一条筛选(chips=${JSON.stringify(p.chips)})`)
      } else if (pending.counts.total > 0) {
        // 「标注」这一条只有在真有待确认行时才验得到;没有行就是没有标可看,如实说出来,
        // **不静默跳过**(合成库那一轮就是专门让这个数非 0 的)。
        const marked = p.rows.filter((t) => t.includes('待确认')).length
        if (marked === 0) {
          bad(`首次认定状态筛选:${pending.counts.total} 家待确认,但表格里一个「待确认」标记都没有`)
        } else {
          ok(`首次认定状态筛选 firstStatus=pending:共 ${pending.counts.total} 家,其中 ${marked} 行标了「待确认」`)
        }
      } else {
        ok(
          '首次认定状态筛选:计数与 chip 都对;本库 0 家待确认 ⇒ 标注这一条本轮无从渲染,' +
            '改用 `node scripts/make-rl08-pending-db.mjs` 造的库再跑一轮(脚本已随票提交,可复现)',
        )
      }
      if (p.scrollWidth > p.clientWidth) {
        bad(`首次认定状态筛选:窄屏页面级横向溢出 ${p.scrollWidth - p.clientWidth}px`)
      } else {
        ok(`首次认定状态筛选:窄屏无横向溢出(${p.scrollWidth} ≤ ${p.clientWidth})`)
      }
    }

    // ── ⑨b 面板里的「首次认定」标记必须**与时态一致** ─────────────────────────
    //
    // 抓的是这一条:待确认的首次认定**不能被说成结论**。`firstEventId` 只是「已知最早那条」,
    // 存在更早但定不了年的认定时,那一年并不成立 —— 面板若照旧挂一句「首次认定就是这一条」,
    // 就把待确认的结论说成了结论,与本契约 §7.5 的「照给,但不声称它是首次」自相矛盾。
    // 这一段**不受 `--shots` 控制**:它是断言,截图才是可选的。
    if (recognitions.rows.length) {
      const pending = await json('/api/roster/enterprises?firstStatus=pending&pageSize=1')
      if (pending.counts.total === 0) {
        ok(
          '面板首次认定标记的时态一致性:本库 0 家待确认 ⇒ 这一条本轮无从渲染,' +
            '改用 `node scripts/make-rl08-pending-db.mjs` 造的库再跑一轮(脚本已随票提交,可复现)',
        )
      } else {
        const { sessionId, targetId } = await openAndRun(cdp, `${BASE}/?firstStatus=pending`, READY_COUNTS, DESKTOP)
        try {
          await evaluate(
            cdp,
            sessionId,
            `(() => {
              const btn = [...document.querySelectorAll('tbody button')].find((b) => (b.textContent ?? '').includes('展开'));
              btn?.click();
              return !!btn;
            })()`,
          )
          const landed = await waitUntil(cdp, sessionId, `!!document.querySelector('${FIRST_MARK}')`, 20000)
          const mark = await evaluate(
            cdp,
            sessionId,
            `(() => {
              const el = document.querySelector('${FIRST_MARK}');
              return { text: el?.textContent?.trim() ?? '', title: el?.getAttribute('title') ?? '' };
            })()`,
          )
          if (!landed) bad('待确认那一屏:面板里没有标出「已知最早的那条认定」')
          else if (!mark.text.includes('待确认') || !mark.title.includes('待确认')) {
            bad(
              `待确认的首次认定在面板里被说成了结论(badge=「${mark.text}」,title=「${mark.title.slice(0, 50)}」)`,
            )
          } else {
            ok(`待确认的首次认定在面板里如实标注「${mark.text}」,并写明为什么不能算首次`)
          }
        } finally {
          await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
        }
      }
    }

    // ── ⑨c 截图(可选,`--shots <目录>`):给人眼再看一遍,不是断言 ─────────────
    if (SHOTS_DIR) {
      const s1 = await openAndRun(cdp, `${BASE}/?firstStatus=pending`, READY_COUNTS, DESKTOP)
      await evaluate(
        cdp,
        s1.sessionId,
        `(() => {
          const btn = [...document.querySelectorAll('tbody button')].find((b) => (b.textContent ?? '').includes('展开'));
          btn?.click();
          return !!btn;
        })()`,
      )
      await waitUntil(cdp, s1.sessionId, `!!document.querySelector('${FIRST_MARK}')`, 20000)
      await shot(cdp, s1.sessionId, 'desktop-pending')
      await cdp.send('Target.closeTarget', { targetId: s1.targetId }).catch(() => {})
      const s2 = await openAndRun(cdp, `${BASE}/?firstYear=2024`, READY, DESKTOP)
      await evaluate(
        cdp,
        s2.sessionId,
        `(() => {
          const btn = [...document.querySelectorAll('tbody button')].find((b) => (b.textContent ?? '').includes('展开'));
          btn?.click();
          return !!btn;
        })()`,
      )
      await waitUntil(cdp, s2.sessionId, `!!document.querySelector('${FIRST_MARK}')`, 20000)
      await shot(cdp, s2.sessionId, 'desktop-panel')
      await cdp.send('Target.closeTarget', { targetId: s2.targetId }).catch(() => {})
    }

    // ── ⑨ 桌面(1440):标注与出处看得见,展开面板标出**哪一条**算首次认定 ──────
    //
    // 这一条抓的是「列宽不够把标记裁掉」——`RosterEnterpriseTable.vue` 顶部那段实测过
    // 三样东西各自要多少宽度,刚好够;多一个「待确认」标记就可能把尾巴挤掉。
    // 所以判据是**单元格里真的读得到**那个年份与标记,不是「DOM 里有这个字符串」。
    if (recognitions.rows.length) {
      const sample = recognitions.rows.find((r) => r.status === 'confirmed' && r.firstYear != null)
      const year = sample ? String(sample.firstYear) : ''
      const { sessionId, targetId } = await openAndRun(
        cdp,
        `${BASE}/?firstYear=${year}`,
        READY,
        DESKTOP,
      )
      try {
        const desktop = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const de = document.documentElement;
            // 「首次认定 · 下次复核」那一列是第 3 列(移动端不换结构,列序一样)。
            const cell = document.querySelector('tbody tr td:nth-child(3)');
            const text = cell?.textContent?.trim() ?? '';
            const box = cell?.getBoundingClientRect();
            const inner = cell?.firstElementChild?.getBoundingClientRect();
            return {
              scrollWidth: de.scrollWidth,
              clientWidth: de.clientWidth,
              text,
              title: cell?.querySelector('[title]')?.getAttribute('title') ?? '',
              clipped: box && inner ? inner.height > box.height + 1 : false,
            };
          })()`,
        )
        if (desktop.scrollWidth > desktop.clientWidth) {
          bad(`桌面 1440:页面级横向溢出 ${desktop.scrollWidth - desktop.clientWidth}px`)
        } else if (!desktop.text.includes('首次')) {
          bad(`桌面 1440:首次认定列的文本读不到(${JSON.stringify(desktop.text)})`)
        } else if (desktop.clipped) {
          bad(`桌面 1440:首次认定列被裁(内容高度超过单元格)`)
        } else {
          ok(`桌面 1440:首次认定列读得到「${desktop.text}」,未被裁`)
        }
        // 「来源证据」在这张表里的落点是悬停说明:必须指得到文件 / 附件 / 序号。
        if (!/出处/.test(desktop.title) || !/序号|第 \d+ 页|\.pdf|\.xlsx|\.docx/.test(desktop.title)) {
          bad(`桌面 1440:首次认定的来源证据读不到(悬停说明=${JSON.stringify(desktop.title)})`)
        } else {
          ok(`桌面 1440:首次认定悬停说明带出处「${desktop.title.split('\\n')[0].slice(0, 60)}…」`)
        }

        // 点开第一行:展开面板必须标出**哪一条事件**算首次认定,并摆出处。
        //
        // 判据选的是那枚徽章的 `title`(而不是扫正文里的「首次认定」四个字):
        // 正文里到处都可能出现这四个字,**认字**认不出「标在了哪一条事件上」;
        // 而「哪一条算首次」正是这张票要回答的问题。
        const clicked = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const btn = [...document.querySelectorAll('tbody button')].find((b) => (b.textContent ?? '').includes('展开'));
            btn?.click();
            return !!btn;
          })()`,
        )
        const panelReady = clicked && (await waitUntil(cdp, sessionId, `!!document.querySelector('${FIRST_MARK}')`, 20000))
        if (!panelReady) {
          bad('桌面 1440:展开面板里没有把「哪一条事件算首次认定」标出来')
        } else {
          const panel = await evaluate(
            cdp,
            sessionId,
            `(() => {
              const badge = document.querySelector('${FIRST_MARK}');
              const row = badge?.closest('li');
              return {
                // 那一行**第一个**徽章是事件标签(EventChip):必须是「认定」,
                // 不是复核 / 维护 / 培育。取 firstElementChild 是因为「首次认定」这四个字
                // 就带「认定」,扫整行文本等于没判。
                chip: row?.firstElementChild?.textContent?.trim() ?? '',
                // 已确立的那一屏:徽章必须**敢**说「首次认定」。
                markText: badge?.textContent?.trim() ?? '',
                // 出处:同一称号块里那句「出处 …」。
                hasWhere: /出处\\s*\\S/.test(document.body.textContent ?? ''),
                overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              };
            })()`,
          )
          if (!panel.chip.startsWith('认定')) bad(`桌面 1440:「首次认定」标在了非认定事件上(${JSON.stringify(panel.chip)})`)
          else if (panel.markText !== '首次认定') bad(`桌面 1440:已确立的首次认定没被标成「首次认定」(${JSON.stringify(panel.markText)})`)
          else if (!panel.hasWhere) bad('桌面 1440:展开面板里没有首次认定的出处')
          else if (panel.overflow) bad('桌面 1440:展开面板撑出横向溢出')
          else ok('桌面 1440:展开面板把「首次认定」标在认定事件那一行,并给出出处,无横向溢出')
        }
      } finally {
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
      }

      // 窄屏也点开一次:面板里的长文件路径最容易把窄屏撑破。
      const narrow = await openAndRun(cdp, `${BASE}/?firstYear=${year}`, READY, VIEWPORT)
      try {
        await evaluate(
          cdp,
          narrow.sessionId,
          `(() => {
            const btn = [...document.querySelectorAll('tbody button')].find((b) => (b.textContent ?? '').includes('展开'));
            btn?.click();
            return !!btn;
          })()`,
        )
        const opened = await waitUntil(
          cdp,
          narrow.sessionId,
          `(document.body.textContent ?? '').includes('称号历史与出处')`,
          15000,
        )
        const ov = await evaluate(
          cdp,
          narrow.sessionId,
          `(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }))()`,
        )
        if (!opened) bad('窄屏 390:展开面板没有渲染出来')
        else if (ov.scrollWidth > ov.clientWidth) {
          bad(`窄屏 390:展开面板后页面级横向溢出 ${ov.scrollWidth - ov.clientWidth}px`)
        } else {
          ok(`窄屏 390:展开面板(含首次认定出处)无页面级横向溢出(${ov.scrollWidth} ≤ ${ov.clientWidth})`)
        }
      } finally {
        await cdp.send('Target.closeTarget', { targetId: narrow.targetId }).catch(() => {})
      }
    }

    // ── ⑧ 改筛选时**显示加载状态**(不能让人照着旧条件的数字下判断)────────────
    //
    // 为什么要把网络拖慢再量:加载态只存在几百毫秒,不拖慢就**量不到**,而「量不到」
    // 和「没有」在这类断言里长得一样 —— 那正是这个脚本开头写的「假的安心」。拖到 1.2s 延迟,
    // 就有足够窗口轮询到那个标记。
    {
      const { sessionId, targetId } = await openAndRun(cdp, `${BASE}/`, READY)
      try {
        // 网络域要挂在**页面会话**上(浏览器级会话没有 Network 域),所以先开页再限速。
        await cdp.send('Network.enable', {}, sessionId)
        await cdp.send(
          'Network.emulateNetworkConditions',
          { offline: false, latency: 1200, downloadThroughput: -1, uploadThroughput: -1 },
          sessionId,
        )
        // 走页面自己的搜索框(不换 URL ⇒ 不会走首屏加载路径)。
        await evaluate(
          cdp,
          sessionId,
          `(() => {
            const input = document.querySelector('input[aria-label*="统一社会信用代码"]');
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, '宁波');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()`,
        )
        const seen = await waitUntil(
          cdp,
          sessionId,
          `!!document.querySelector('[data-testid=ledger-loading]')`,
          // 300ms 防抖 + 1.2s 网络延迟,给 4s 的窗口。
          4000,
        )
        if (!seen) {
          bad('改筛选时没有看到加载状态([data-testid=ledger-loading] 从未出现)')
        } else {
          ok('改筛选时显示加载状态(搜索 300ms 防抖 + 1.2s 延迟下量到)')
        }
      } finally {
        await cdp
          .send(
            'Network.emulateNetworkConditions',
            { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
            sessionId,
          )
          .catch(() => {})
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
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
    console.log(`\n✗ ${problems.length} 条不符合预期`)
    process.exit(1)
  }
  console.log(
    '\n✓ 窄屏无横向溢出、分页条在视口内、五个页面都有标题、图例列名对得上、旧入口重定向带查询串、' +
      '首次认定筛选可深链且计数与接口一致、改筛选时有加载状态',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
