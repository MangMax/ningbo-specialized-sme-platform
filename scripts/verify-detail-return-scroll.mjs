#!/usr/bin/env node
/**
 * Real-browser regression for detail → preview → detail scroll restoration.
 * Uses an isolated empty SQLite file and 31 synthetic scroll rows because the route scroll
 * behavior is independent of roster contents. This is not original-file or business-data acceptance.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawnOwnedChild as spawn, startIsolatedNuxt, stopOwnedChild, waitForChromeDevTools } from './lib/isolated-local-services.mjs'

const PORT_HINT = Number(process.argv[2] ?? process.env.RL10_TEST_PORT ?? 0)
let BASE
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'rl10-detail-scroll-'))
const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 'rl10-detail-scroll-chrome-'))

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
      let timeout
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      timeout = setTimeout(() => {
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

async function waitUntil(cdp, sessionId, expression, timeoutMs = 60_000, stableSamples = 1) {
  let consecutive = 0
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, sessionId, expression)) { if (++consecutive >= stableSamples) return }
      else consecutive = 0
    } catch {
      // Navigation can replace the execution context between polls.
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`)
}

async function main() {
  let service
  let chrome
  let cdp

  try {
    service = await startIsolatedNuxt({
      cwd: process.cwd(),
      portHint: PORT_HINT,
      env: {
        NUXT_DB_PATH: join(TEMP_ROOT, 'roster.db'),
        NUXT_FILES_DIR: join(TEMP_ROOT, 'files'),
        NUXT_INCOMING_DIR: join(TEMP_ROOT, 'incoming'),
      },
    })
    BASE = service.baseUrl
    const chromePath = process.env.CHROME_BIN ?? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((path) => existsSync(path))
    if (!chromePath) throw new Error('Chrome not found; set CHROME_BIN to its executable')

    chrome = spawn(chromePath, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${CHROME_PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      'about:blank',
    ], { stdio: 'ignore' })
    const version = await waitForChromeDevTools(chrome, CHROME_PROFILE)
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
      return detailPath;
    })()`)

    // Router completion precedes Nuxt's page transition/render. Wait for the
    // public return link rather than a fixed delay or router-private ready flag.
    await waitUntil(cdp, sessionId, `location.pathname === '/preview' && [...document.querySelectorAll('a')].some(a => a.textContent.trim() === '返回企业详情' && a.getAttribute('href')?.startsWith('/enterprises/35'))`)
    await evaluate(cdp, sessionId, `(() => {
      window.__detailReturnScrollCalls.length = 0;
      [...document.querySelectorAll('a')].find(a => a.textContent.trim() === '返回企业详情' && a.getAttribute('href')?.startsWith('/enterprises/35')).click();
    })()`)

    await waitUntil(cdp, sessionId, `location.pathname === '/enterprises/35' && document.body.innerText.includes('未能加载企业详情')`)
    await waitUntil(cdp, sessionId, `window.scrollY === 70 && sessionStorage.getItem('roster:evidence-preview-return') === null && window.__detailReturnScrollCalls.some(p => p.top === 70)`, 60_000, 5)
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
    await stopOwnedChild(chrome)
    await service?.stop()
    rmSync(TEMP_ROOT, { recursive: true, force: true })
    rmSync(CHROME_PROFILE, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
