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

/** 窄屏。与盲测一致:iPhone 12/13 的逻辑宽度。 */
const VIEWPORT = { width: 390, height: 844 }

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
async function openAndMeasure(cdp, url, expression, readyExpression) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, sessionId)
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

    // ④ 深链重定向带走查询串(顺手守一条已知回归)
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
  console.log('\n✓ 窄屏无横向溢出、分页条在视口内、三个视图都有标题、旧入口重定向带查询串')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
