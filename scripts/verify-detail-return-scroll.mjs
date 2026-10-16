#!/usr/bin/env node
/**
 * Real-browser regression for detail → preview → detail scroll restoration.
 * Uses an isolated empty SQLite file and 31 synthetic scroll rows because the route scroll
 * behavior is independent of roster contents. This is not original-file or business-data acceptance.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] ?? 3494)
const DEBUG_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'rl10-detail-scroll-'))
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 'rl10-detail-scroll-chrome-'))

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* server is starting */
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.sequence = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`))
      }, 30_000)
    })
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function waitUntil(cdp, sessionId, expression, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, sessionId, expression)) return
    } catch {
      // Navigation can replace the execution context between polls.
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`)
}

async function main() {
  const server = spawn(join(process.cwd(), 'node_modules/.bin/nuxt'), [
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    String(PORT),
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      NUXT_DB_PATH: join(TEMP_ROOT, 'roster.db'),
      NUXT_FILES_DIR: join(TEMP_ROOT, 'files'),
      NUXT_INCOMING_DIR: join(TEMP_ROOT, 'incoming'),
    },
  })
  let chrome
  let cdp

  try {
    await waitForHttp(`${BASE}/`)
    const chromePath = process.env.CHROME_BIN ?? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((path) => existsSync(path))
    if (!chromePath) throw new Error('Chrome not found; set CHROME_BIN to its executable')

    chrome = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      'about:blank',
    ], { stdio: 'ignore' })
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
    cdp = new Cdp(new WebSocket(version.webSocketDebuggerUrl))
    await new Promise((resolve, reject) => {
      cdp.socket.addEventListener('open', resolve, { once: true })
      cdp.socket.addEventListener('error', reject, { once: true })
    })

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', {
      url: `${BASE}/enterprises/35?back=view%3Dtitle%26page%3D2`,
    }, sessionId)
    await waitUntil(cdp, sessionId, "document.body.innerText.includes('未能加载企业详情')")

    const observed = await evaluate(cdp, sessionId, `(async () => {
      const detailPath = location.pathname + location.search;
      const syntheticRows = document.createElement('section');
      syntheticRows.id = 'synthetic-detail-events';
      Object.assign(syntheticRows.style, {
        position: 'absolute', top: '850px', left: '16px', width: '900px',
        zIndex: '-1', pointerEvents: 'none'
      });
      for (let i = 1; i <= 31; i++) {
        const row = document.createElement('div');
        row.textContent = '合成事件 ' + i;
        row.style.cssText = 'height:32px;border-bottom:1px solid #ddd';
        syntheticRows.appendChild(row);
      }
      document.body.appendChild(syntheticRows);

      window.__detailReturnScrollCalls = [];
      const nativeScrollTo = window.scrollTo.bind(window);
      window.scrollTo = (...args) => {
        const position = typeof args[0] === 'object' ? args[0] : { left: args[0], top: args[1] };
        window.__detailReturnScrollCalls.push(position);
        return nativeScrollTo(...args);
      };
      sessionStorage.setItem('roster:evidence-preview-return', JSON.stringify([
        { back: detailPath, scrollY: 70, scrollTop: null }
      ]));
      window.scrollTo({ top: 70, behavior: 'instant' });

      const router = document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router;
      await router.push({
        path: '/preview',
        query: { file: 'jxj/announcement/test.pdf', page: '8', back: detailPath }
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      window.__detailReturnScrollCalls.length = 0;

      const backLink = [...document.querySelectorAll('a')].find((link) =>
        link.textContent.includes('返回') && link.getAttribute('href')?.startsWith('/enterprises/35')
      );
      if (!backLink) throw new Error('preview return link was not rendered');
      backLink.click();
      return detailPath;
    })()`)

    await waitUntil(cdp, sessionId, `location.pathname === '/enterprises/35' && document.body.innerText.includes('未能加载企业详情')`)
    await sleep(500)
    const final = await evaluate(cdp, sessionId, `({
      path: location.pathname + location.search,
      scrollY: window.scrollY,
      calls: window.__detailReturnScrollCalls,
      returnState: sessionStorage.getItem('roster:evidence-preview-return')
    })`)
    if (final.path !== observed || final.scrollY !== 70) {
      throw new Error(`detail return scroll mismatch: ${JSON.stringify(final)}`)
    }
    if (!final.calls.some((position) => position.top === 70)) {
      throw new Error(`saved offset was not restored: ${JSON.stringify(final.calls)}`)
    }
    if (final.calls.some((position) => position.top === 0)) {
      throw new Error(`route scrolled to top after restore: ${JSON.stringify(final.calls)}`)
    }
    if (final.returnState !== null) throw new Error(`return state was not consumed: ${final.returnState}`)
    console.log(`✓ real Chrome route returned with window.scrollY=${final.scrollY}; later top reset absent`)
    console.log(`  route scroll calls after return: ${JSON.stringify(final.calls)}`)
    await cdp.send('Target.closeTarget', { targetId })
  } finally {
    try {
      await cdp?.send('Browser.close')
    } catch {
      /* ignore shutdown errors */
    }
    chrome?.kill()
    server.kill()
    await sleep(500)
    rmSync(TEMP_ROOT, { recursive: true, force: true })
    rmSync(CHROME_PROFILE, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
