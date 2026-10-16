/**
 * 真实浏览器验收用的**极简 CDP 客户端**(零新依赖)—— 从 `verify-ledger-ui.mjs` 的
 * 内联实现里抽出来,给后加的页面验收脚本共用。
 *
 * 为什么不引 playwright / puppeteer:本仓的验收脚本只做三件事 —— 打开一个 URL、
 * 等它真渲染出数据、在页面里求值一次。Node 24 自带 `WebSocket`,Chrome 自带 CDP,
 * 引一个几百 MB 的浏览器框架只为这三件事不划算,而且会把「量到的到底是不是真排版」
 * 这层搞得看不见(`vitest.config.ts` 跑在 `environment: 'node'`,jsdom 的
 * `scrollWidth` 恒为 0 —— 布局事实只能靠真排版引擎量)。
 *
 * ⚠️ `verify-ledger-ui.mjs` 里那份**内联实现仍然保留**(它是 RL-17 的文件,
 * 别票的会话可能正在改)。这里是给新脚本用的;谁下次碰那个文件,顺手换成本模块即可。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** 等一个 HTTP 端点起来(轮询,直到超时)。 */
export async function waitForHttp(url, timeoutMs = 60_000) {
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

function findChrome() {
  return (
    process.env.CHROME_BIN ??
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) =>
      existsSync(p),
    )
  )
}

/**
 * 起一个无头 Chrome 并连上。返回 `{ cdp, close() }`。
 * `close()` 会把浏览器关掉并清理临时 profile(Chrome 收尾时还在写 profile,立刻删会
 * ENOTEMPTY —— 所以等一小会儿再删,删不掉就算了)。
 */
export async function startChrome({ debugPort }) {
  const binary = findChrome()
  if (!binary) throw new Error('找不到 Chrome(可用 CHROME_BIN 指定)')
  const userDataDir = mkdtempSync(join(tmpdir(), 'verify-ui-chrome-'))
  const chrome = spawn(
    binary,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`)
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  return {
    cdp: new Cdp(ws),
    async close() {
      try {
        await this.cdp.send('Browser.close')
      } catch {
        /* ignore */
      }
      chrome.kill()
      await sleep(1000)
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(userDataDir, { recursive: true, force: true })
          break
        } catch {
          await sleep(500)
        }
      }
    },
  }
}

/**
 * 在页面里求值一次。
 */
export async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result.value
}

/**
 * 等页面**真的把数据渲染出来**(轮询到表达式为真)为止。
 *
 * 为什么不能睡固定时长、也不能「等不到就跳过」:冷启动的生产实例上睡不够就会量到
 * 加载中的页面,断言被**静默跳过**而脚本照样打印 ✓ —— 那比没有验收更坏,它给出假的安心。
 * 所以这里等不到就返回 false,由调用方**判失败**。
 */
export async function waitUntil(cdp, sessionId, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, expression)) return true
    await sleep(300)
  }
  return false
}

/**
 * 打开一个页面、等就绪,把**会话**交给 `fn` 用 —— 交互式验收(点一行、翻一页、
 * 看「正在加载」有没有出现)需要会话一直活着,量完就关会把中途状态一起带走。
 *
 * 每次都新建 target:同一个 target 反复 navigate 会带上上一页的滚动位置与
 * `documentElement` 状态,量出来的宽度偶尔是上一页的(实测串味过)。
 */
export async function withPage(cdp, { url, viewport, readyExpression }, fn) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...viewport, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url }, sessionId)
    if (readyExpression) {
      const ready = await waitUntil(cdp, sessionId, readyExpression)
      if (!ready) throw new Error(`${url} 在 30s 内没有渲染出预期的内容 —— 量不出东西,按失败算`)
    }
    return await fn({
      sessionId,
      evaluate: (expression) => evaluate(cdp, sessionId, expression),
      waitUntil: (expression, timeoutMs) => waitUntil(cdp, sessionId, expression, timeoutMs),
      click: (selector) => click(cdp, sessionId, selector),
    })
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

/** 打开一个页面、等就绪、求值一次(交互式验收用 `withPage`)。 */
export async function openAndMeasure(cdp, opts) {
  return withPage(cdp, opts, ({ evaluate: run }) => run(opts.expression))
}

/** 在页面里点一个元素(用原生 click,不依赖 CDP 的坐标与命中测试)。 */
export async function click(cdp, sessionId, selector) {
  return evaluate(
    cdp,
    sessionId,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true })()`,
  )
}

/**
 * 给页面加人工网络延迟。
 *
 * 「更换筛选 / 翻页时必须有加载状态」这条**没办法靠等**去验:本机的接口只要几十毫秒,
 * 轮询根本抓不到那一瞬。加 1.5 秒延迟之后,加载状态一定会被观察到 —— 断言才是确定的,
 * 而不是「大多数时候能过」。
 */
export async function setLatency(cdp, sessionId, latencyMs) {
  await cdp.send('Network.enable', {}, sessionId)
  await cdp.send(
    'Network.emulateNetworkConditions',
    { offline: false, latency: latencyMs, downloadThroughput: -1, uploadThroughput: -1 },
    sessionId,
  )
}

export { sleep }
