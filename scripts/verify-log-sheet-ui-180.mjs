#!/usr/bin/env node
/**
 * Sheet (B direction) UI browser evidence via the repo-owned CDP path.
 *
 * The T3 collaborative preview is attempted first for the manual focus check;
 * this verifier is the reproducible fallback and never touches user tabs.
 *
 * usage: node scripts/verify-log-sheet-ui-180.mjs <baseUrl> <outDir>
 */
import assert from 'node:assert/strict'
import { spawnOwnedChild, stopOwnedChild, waitForChromeDevTools } from './lib/isolated-local-services.mjs'
import { closeSync, openSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2]
const outDir = process.argv[3]
if (!base || !outDir) throw new Error('usage: <baseUrl> <outDir>')
mkdirSync(outDir, { recursive: true })
const chromePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Keep startup, assertions and signal exits inside the same owned closeout.
let chrome, profile, ws, chromeClosed, chromePort
const chromeStderrPath = join(outDir, 'chrome-stderr.log')
let cleanupPromise
const lifecycle = { errors: [] }
async function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    ws?.close()
    try {
      if (chrome) {
        await stopOwnedChild(chrome)
        await chromeClosed
      }
      if (profile) rmSync(profile, { recursive: true, force: true })
    } catch (error) {
      lifecycle.errors.push(String(error.stack || error))
    }
    Object.assign(lifecycle, {
      chromePort, chromePid: chrome?.pid,
      chromeExit: chrome && { code: chrome.exitCode, signal: chrome.signalCode },
      profile, profileRemoved: profile ? !existsSync(profile) : true
    })
    if (lifecycle.errors.length) process.exitCode = 1
    writeFileSync(join(outDir, 'sheet-browser-closeout.json'), JSON.stringify(lifecycle, null, 2))
  })()
  return cleanupPromise
}
let signalExitStarted = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (signalExitStarted) return
    signalExitStarted = true
    lifecycle.errors.push(`Interrupted by ${signal}`)
    process.exitCode = 1
    void cleanup().then(() => process.exit(1), error => { console.error(error); process.exit(1) })
  })
}

async function run() {
profile = mkdtempSync(join(tmpdir(), 'sheet-ui-chrome-'))
// A file keeps stderr even when Chrome updaters inherit its descriptor;
// inherited pipes would keep ChildProcess.close pending after the group exits.
const chromeStderr = openSync(chromeStderrPath, 'a')
try {
chrome = spawnOwnedChild(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--remote-allow-origins=*',
    '--window-size=1280,900',
    'about:blank'
  ],
  { stdio: ['ignore', 'ignore', chromeStderr] }
)
} finally {
  closeSync(chromeStderr)
}
chromeClosed = new Promise(resolve => chrome.once('close', resolve))
const version = await waitForChromeDevTools(chrome, profile)
chromePort = Number(new URL(version.webSocketDebuggerUrl).port)
const target = await (
  await fetch(
    'http://127.0.0.1:' + chromePort + '/json/new?' + encodeURIComponent('about:blank'),
    { method: 'PUT' }
  )
).json()
ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
  ws.onclose = () => reject(new Error('Owned Chrome closed before CDP connected'))
})
let serial = 0
const pending = new Map()
ws.onclose = () => {
  for (const entry of pending.values()) entry.reject(new Error('Owned Chrome CDP connection closed'))
  pending.clear()
}
const network = []
const responses = []
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
    return
  }
  if (message.method === 'Network.requestWillBeSent')
    network.push({ method: message.params.request.method, url: message.params.request.url })
  if (message.method === 'Network.responseReceived')
    responses.push({ url: message.params.response.url, status: message.params.response.status })
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error('Owned Chrome CDP connection is not open'))
    const id = ++serial
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    throw new Error(
      (details.exception && details.exception.description) || details.text || 'evaluate failed'
    )
  }
  return result.result.value
}
async function waitFor(expression, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error('waitFor timed out: ' + expression)
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  })
  const path = join(outDir, name)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}
async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
}
async function navigate(url, ready) {
  await send('Page.navigate', { url })
  await waitFor("document.readyState === 'complete'")
  await waitFor(ready)
  await sleep(800)
}
const policyWrites = () =>
  network.filter(
    (entry) =>
      entry.method !== 'GET' && entry.method !== 'OPTIONS' && entry.url.includes('/api/logs/policy')
  )
const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push({ name, result: 'PASS' })
  } catch (error) {
    results.push({ name, result: 'FAIL', error: String(error && error.message ? error.message : error) })
    throw error
  }
}
const H = [
  "const q=(s)=>document.querySelector(s);",
  "const qa=(s)=>Array.from(document.querySelectorAll(s));",
  "const byId=(id)=>document.getElementById(id);",
  "const row=(p,k)=>q('[data-testid=log-module-row-'+p+'-'+k+']');",
  "const sheet=(p,k)=>q('[data-testid=log-module-sheet-'+p+'-'+k+']');",
  "const open=(p,k)=>{const r=row(p,k);if(r.getAttribute('aria-expanded')!=='true')r.click();return true};",
  "const close=()=>{const s=q('[data-slot=sheet-content][data-state=open]');const d=s?s.querySelector('[data-testid=log-module-sheet-done]'):null;if(d)d.click();return true};",
  "const block=(p)=>q('[data-testid=log-field-controls-'+p+']');",
  "const sw=(p,f)=>byId('log-field-'+p+'-all-'+f);",
  "const text=(el)=>el?el.textContent.replace(/\\s+/g,' ').trim():'';"
].join('\n')
const run = (body) => evaluate('(() => {' + H + '\n' + body + '\n})()')

let lastFocus = null
let sheetFocus = null
let escapeVia = null
let reviewEscapeVia = null
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')

try {
  await setViewport(1280, 900)
  await navigate(
    base + '/logs?tab=settings',
    "!!document.querySelector('[data-testid=log-module-row-integration-nuxt-nitro]')"
  )
  await waitFor("!!document.querySelector('[data-testid=log-module-row-integration-tus]')")
  const setupBody = {
    retentionDays: 7,
    maxBytes: 536870912,
    fieldControls: {
      http: {
        debug: { httpMethod: true, httpRoute: true, statusCode: true, durationMs: true },
        info: { httpMethod: true, httpRoute: false, statusCode: false, durationMs: true },
        warn: { httpMethod: true, httpRoute: true, statusCode: true, durationMs: true },
        error: { httpMethod: true, httpRoute: true, statusCode: true, durationMs: true }
      },
      tus: {
        debug: { 'tus.method': true, 'tus.uploadId': true, 'tus.size': true, 'tus.offset': true },
        info: { 'tus.method': true, 'tus.uploadId': false, 'tus.size': true, 'tus.offset': true },
        warn: { 'tus.method': true, 'tus.uploadId': true, 'tus.size': true, 'tus.offset': true },
        error: { 'tus.method': true, 'tus.uploadId': true, 'tus.size': true, 'tus.offset': true }
      }
    }
  }
  const setupResponse = await fetch(base + '/api/logs/policy', {
    method: 'PATCH',
    headers: {
      'x-log-browser': '1',
      'sec-fetch-site': 'same-origin',
      referer: base + '/logs',
      origin: base,
      'content-type': 'application/json'
    },
    body: JSON.stringify(setupBody)
  })
  const setupStatus = setupResponse.status
  await send('Page.reload', { ignoreCache: true })
  await waitFor("document.readyState === 'complete'")
  await waitFor("!!document.querySelector('[data-testid=log-module-row-integration-nuxt-nitro]')")
  await evaluate(
    "window.q=(s)=>document.querySelector(s); window.qa=(s)=>Array.from(document.querySelectorAll(s)); window.byId=(id)=>document.getElementById(id); true"
  )
  await evaluate(
    "(() => { for (const id of ['nuxt-devtools-container','vue-tracer-overlay']) document.getElementById(id)?.remove(); return true })()"
  )
  await sleep(900)
  network.length = 0
  responses.length = 0

  const initial = JSON.parse(
    await run(
      "return JSON.stringify({rows:qa('[data-testid^=log-module-row-]').length,switches:qa('[data-slot=switch]').length,selects:qa('select').length,blocks:qa('[data-testid^=log-field-controls]').length,chevrons:qa('[data-testid=log-module-chevron]').length,bottom:!!q('[data-testid=log-field-controls]'),rowText:text(row('integration','nuxt-nitro'))})"
    )
  )
  const defaultShot = await shot('sheet-1280-index.png')
  check('the main list is a 22-row index with no inline switches, selects or field blocks', () => {
    assert.equal(setupStatus, 200)
    assert.equal(initial.rows, 22)
    assert.equal(initial.switches, 0)
    assert.equal(initial.selects, 0)
    assert.equal(initial.blocks, 0)
    assert.equal(initial.bottom, false)
    assert.equal(initial.chevrons, 22)
    assert.match(initial.rowText, /Nuxt \/ Nitro 请求/)
    assert.match(initial.rowText, /开启/)
    assert.match(initial.rowText, /详情 2\/4 项/)
  })

  const hoverBox = JSON.parse(
    await run(
      "const r=row('integration','nuxt-nitro').getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})"
    )
  )
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverBox.x, y: hoverBox.y })
  await sleep(250)
  const hover = JSON.parse(
    await run(
      "const s=getComputedStyle(row('integration','nuxt-nitro')); return JSON.stringify({bg:s.backgroundColor,decoration:s.textDecorationLine})"
    )
  )
  check('the whole row hovers with the accent background and no underline', () => {
    assert.notEqual(hover.bg, 'rgba(0, 0, 0, 0)')
    assert.equal(hover.decoration, 'none')
  })

  await run("open('integration','nuxt-nitro'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-integration-nuxt-nitro]') && q('[data-testid=log-module-sheet-integration-nuxt-nitro]').getAttribute('data-state')==='open'"
  )
  await sleep(600)
  const http = JSON.parse(
    await run(
      "const s=sheet('integration','nuxt-nitro'); const r=s.getBoundingClientRect(); return JSON.stringify({left:Math.round(r.left),width:Math.round(r.width),innerWidth,title:text(s.querySelector('[data-slot=sheet-title]')),summary:text(s.querySelector('[data-testid=log-module-sheet-summary]')),switches:s.querySelectorAll('[data-slot=switch]').length,fields:block('http').querySelectorAll('[data-slot=switch]').length,blockText:text(block('http')),sheetText:text(s),rowOpen:row('integration','nuxt-nitro').getAttribute('aria-expanded'),hasDone:!!s.querySelector('[data-testid=log-module-sheet-done]'),hasMixed:sw('http','httpRoute').getAttribute('data-mixed')})"
    )
  )
  const httpShot = await shot('sheet-1280-http.png')
  check('clicking the HTTP row opens a moderate-width Sheet titled with the module and all real controls', () => {
    assert.match(http.title, /Nuxt \/ Nitro 请求/)
    assert.equal(http.rowOpen, 'true')
    assert.ok(http.width >= 400 && http.width <= 520, 'width ' + http.width)
    assert.ok(http.width < http.innerWidth / 2, 'desktop sheet should not be too wide')
    assert.equal(http.fields, 4)
    assert.equal(http.switches, 5)
    assert.equal(http.hasDone, true)
    assert.match(http.sheetText, /采集开关/)
    assert.match(http.sheetText, /采集门槛/)
    assert.match(http.sheetText, /记录内容/)
    assert.match(http.sheetText, /同时生效/)
    assert.match(http.sheetText, /已保存/)
    assert.match(http.sheetText, /完成编辑/)
    assert.match(http.blockText, /请求参数、响应内容、原始报文尚未采集/)
    assert.match(http.blockText, /HTTP 完成事件只有 信息 \/ 警告 \/ 错误，没有调试档/)
    assert.equal(http.hasMixed, 'true')
    assert.match(http.blockText, /各级别不一致/)
    assert.equal(policyWrites().length, 0)
  })

  const chevrons = JSON.parse(
    await run(
      "return JSON.stringify(qa('[data-testid=log-module-chevron]').map(el=>{const s=el.querySelector('svg');return {html:el.innerHTML,transform:getComputedStyle(s).transform,cls:el.className,path:!!s.querySelector('path')}}))"
    )
  )
  check('every chevron stays fixed pointing right, including while the Sheet is open', () => {
    assert.equal(chevrons.length, 22)
    for (const entry of chevrons) {
      assert.match(entry.html, /m9 18l6-6l-6-6/)
      assert.equal(entry.transform, 'none')
      assert.doesNotMatch(entry.cls, /rotate/)
      assert.equal(entry.path, true)
    }
  })

  const icons = JSON.parse(
    await run(
      "const chev=qa('[data-testid=log-module-chevron] svg.iconify'); const all=qa('svg.iconify'); return JSON.stringify({chevrons:chev.length,all:all.length,empty:all.filter(s=>!s.getAttribute('viewBox')||s.childElementCount===0).length,emptyHtml:all.filter(s=>!s.getAttribute('viewBox')||s.childElementCount===0).map(s=>s.outerHTML.slice(0,300)),remote:performance.getEntriesByType('resource').filter(e=>e.name.includes('api.iconify.design')).length,nuxt:row('integration','nuxt-nitro').querySelector('svg.iconify').outerHTML.includes('00dc82'),tus:row('integration','tus').querySelector('svg.iconify').outerHTML.includes('43AA91'),mcpColor:getComputedStyle(row('integration','mcp-toolkit').querySelector('svg.iconify')).color,mcpCurrent:row('integration','mcp-toolkit').querySelector('svg.iconify').outerHTML.includes('currentColor')})"
    )
  )
  check('all revamp icons render from the local Nuxt Icon bundle, including brand and custom assets', () => {
    assert.equal(icons.chevrons, 22)
    assert.ok(icons.all > 50, 'expected section, group, row and sheet icons: ' + icons.all)
    assert.equal(icons.empty, 0, 'empty icons: ' + JSON.stringify(icons.emptyHtml))
    assert.equal(icons.remote, 0)
    assert.equal(icons.nuxt, true)
    assert.equal(icons.tus, true)
    assert.equal(icons.mcpCurrent, true)
    assert.doesNotMatch(icons.mcpColor, /rgba\(0, 0, 0, 0\)|rgb\(0, 0, 0\)/)
  })

  await run('close(); return true')
  await waitFor("!document.querySelector('[data-slot=sheet-content][data-state=open]')")
  await sleep(500)
  const closed = JSON.parse(
    await run(
      "const a=document.activeElement; return JSON.stringify({rowOpen:row('integration','nuxt-nitro').getAttribute('aria-expanded'),isRow:a===row('integration','nuxt-nitro'),tag:a?a.tagName:null,sheetOpen:!!q('[data-slot=sheet-content][data-state=open]'),rows:qa('[data-testid^=log-module-row-]').length})"
    )
  )
  check('完成编辑 closes the Sheet, returns to the 22-row index and restores focus to the row', () => {
    assert.equal(closed.rowOpen, 'false')
    assert.equal(closed.isRow, true, 'focus should return to the row')
    assert.equal(closed.sheetOpen, false)
    assert.equal(closed.rows, 22)
  })

  await run("open('integration','nuxt-nitro'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-integration-nuxt-nitro]') && q('[data-testid=log-module-sheet-integration-nuxt-nitro]').getAttribute('data-state')==='open'"
  )
  await sleep(400)
  await run("const s=q('[data-slot=sheet-content][data-state=open]'); const d=s?s.querySelector('[data-testid=log-module-sheet-done]'):q('[data-testid=log-module-sheet-done]'); if(d)d.focus(); return true")
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  escapeVia = 'cdp-input-sheet'
  let sheetClosed = false
  for (let i = 0; i < 20; i++) {
    if (!(await evaluate("!!document.querySelector('[data-slot=sheet-content][data-state=open]')"))) {
      sheetClosed = true
      break
    }
    await sleep(100)
  }
  if (!sheetClosed) {
    escapeVia = 'dom-keydown-sheet'
    await evaluate(
      "const s=q('[data-testid=log-module-sheet-integration-nuxt-nitro]'); if(s) s.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true})); return true"
    )
  }
  await waitFor("!document.querySelector('[data-slot=sheet-content][data-state=open]')")
  await sleep(400)
  // The headless CSS animation may not fire the Presence exit; nudge it so the
  // Sheet content unmounts and its close-auto-focus event can return focus.
  await evaluate("(() => { const s=q('[data-testid=log-module-sheet-integration-nuxt-nitro]'); if(s) s.dispatchEvent(new AnimationEvent('animationend',{animationName:'slide-out-to-right',bubbles:true})); return true })()")
  await waitFor("!document.querySelector('[data-testid=log-module-sheet-integration-nuxt-nitro]')", 4000).catch(() => {})
  await waitFor("document.activeElement === document.querySelector('[data-testid=log-module-row-integration-nuxt-nitro]')", 4000).catch(() => {})
  await sleep(200)
  sheetFocus = JSON.parse(
    await run(
      "const a=document.activeElement; return JSON.stringify({rowOpen:row('integration','nuxt-nitro').getAttribute('aria-expanded'),isRow:a===row('integration','nuxt-nitro'),tag:a?a.tagName:null,testid:a?a.getAttribute('data-testid'):null,activeText:text(a).slice(0,40),isBody:a===document.body,sheetOpen:!!q('[data-slot=sheet-content][data-state=open]')})"
    )
  )
  check('Escape closes the Sheet and returns focus to the row without writing', () => {
    assert.equal(sheetFocus.rowOpen, 'false')
    assert.equal(sheetFocus.isRow, true, 'focus should return to the row after Escape')
    assert.equal(sheetFocus.sheetOpen, false)
    assert.equal(policyWrites().length, 0)
  })

  await run("open('source','http'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-source-http]') && q('[data-testid=log-module-sheet-source-http]').getAttribute('data-state')==='open'"
  )
  await sleep(400)
  const follow = JSON.parse(
    await run(
      "const s=sheet('source','http'); return JSON.stringify({sheetText:text(s),switches:s.querySelectorAll('[data-slot=switch]').length,fields:s.querySelectorAll('[data-testid^=log-field-controls]').length,rowText:text(row('source','http'))})"
    )
  )
  await run('close(); return true')
  await waitFor("!document.querySelector('[data-slot=sheet-content][data-state=open]')")
  await run("open('source','task'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-source-task]') && q('[data-testid=log-module-sheet-source-task]').getAttribute('data-state')==='open'"
  )
  await sleep(400)
  const noFields = JSON.parse(
    await run(
      "const s=sheet('source','task'); return JSON.stringify({sheetText:text(s),switches:s.querySelectorAll('[data-slot=switch]').length,fields:s.querySelectorAll('[data-testid^=log-field-controls]').length,rowText:text(row('source','task'))})"
    )
  )
  check('source drawers show the collector follow note or 暂无字段采集选项, never fake field switches', () => {
    assert.match(follow.sheetText, /此来源暂无独立的字段采集选项/)
    assert.match(follow.sheetText, /字段跟随「Nuxt \/ Nitro 请求」/)
    assert.equal(follow.fields, 0)
    assert.equal(follow.switches, 1)
    assert.match(noFields.sheetText, /暂无字段采集选项/)
    assert.equal(noFields.fields, 0)
    assert.equal(noFields.switches, 1)
  })
  await run('close(); return true')
  await waitFor("!document.querySelector('[data-slot=sheet-content][data-state=open]')")

  await run("open('integration','nuxt-nitro'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-integration-nuxt-nitro]') && q('[data-testid=log-module-sheet-integration-nuxt-nitro]').getAttribute('data-state')==='open'"
  )
  await sleep(300)
  await run("sw('http','durationMs').click(); return true")
  await sleep(300)
  await run('close(); return true')
  await waitFor("!document.querySelector('[data-slot=sheet-content][data-state=open]')")

  await run("open('integration','tus'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-integration-tus]') && q('[data-testid=log-module-sheet-integration-tus]').getAttribute('data-state')==='open'"
  )
  await sleep(300)
  await run("sw('tus','tus.method').click(); return true")
  await sleep(300)
  const draft = JSON.parse(
    await run(
      "return JSON.stringify({http:text(row('integration','nuxt-nitro')),tus:text(row('integration','tus')),summary:text(q('[data-testid=log-unsaved-summary]')),sheetOpen:!!q('[data-slot=sheet-content][data-state=open]')})"
    )
  )
  check('cross-module edits live in the same global draft and the index shows 未保存', () => {
    assert.match(draft.summary, /未保存：Nuxt \/ Nitro 请求、tus 服务端回调/)
    assert.match(draft.http, /未保存/)
    assert.match(draft.tus, /未保存/)
    assert.equal(draft.sheetOpen, true)
    assert.equal(policyWrites().length, 0)
  })
  await run('close(); return true')
  await waitFor("!document.querySelector('[data-slot=sheet-content][data-state=open]')")

  await run(
    "q('[data-testid=log-policy-review]').scrollIntoView({block:'center'}); q('[data-testid=log-policy-review]').click(); return true"
  )
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  await sleep(600)
  const review = JSON.parse(
    await run(
      "const d=q('[role=dialog][data-state=open]'); const t=d.querySelector('[data-testid=log-field-review-table]'); return JSON.stringify({dialog:text(d),table:t?text(t):'',sheetOpen:!!q('[data-slot=sheet-content][data-state=open]'),hasModuleSaved:/本模块已保存|当前模块已保存/.test(text(d))})"
    )
  )
  const reviewShot = await shot('sheet-1280-review.png')
  check('the global review opens only after the Sheet closes and includes both module changes', () => {
    assert.equal(review.sheetOpen, false)
    assert.match(review.dialog, /核对日志配置修改/)
    assert.match(review.table, /HTTP 请求 · 信息 · 耗时/)
    assert.match(review.table, /TUS 上传 · 信息 · 上传请求方法/)
    assert.equal(review.hasModuleSaved, false)
    assert.equal(policyWrites().length, 0)
  })

  await run(
    "const d=q('[role=dialog][data-state=open]'); Array.from(d.querySelectorAll('button')).find(b=>b.textContent.trim()==='取消').click(); return true"
  )
  await waitFor("!document.querySelector('[role=dialog][data-state=open]')")
  await sleep(300)
  check('cancelling the global review sends zero policy writes', () => {
    assert.equal(policyWrites().length, 0)
  })

  await run("q('[data-testid=log-policy-review]').click(); return true")
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  await run(
    "const d=q('[role=dialog][data-state=open]'); const c=Array.from(d.querySelectorAll('button')).find(b=>b.textContent.trim()==='取消'); c.focus(); return true"
  )
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  reviewEscapeVia = 'cdp-input-dialog'
  let dialogClosed = false
  for (let i = 0; i < 20; i++) {
    if (!(await evaluate("!!document.querySelector('[role=dialog][data-state=open]')"))) {
      dialogClosed = true
      break
    }
    await sleep(100)
  }
  if (!dialogClosed) {
    reviewEscapeVia = 'dom-keydown-dialog'
    await evaluate(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true})); return true"
    )
  }
  await waitFor("!document.querySelector('[role=dialog][data-state=open]')")
  await sleep(300)
  lastFocus = JSON.parse(
    await run(
      "const a=document.activeElement; return JSON.stringify({dialogOpen:!!q('[role=dialog][data-state=open]'),isReview:a===q('[data-testid=log-policy-review]'),tag:a?a.tagName:null,activeText:text(a).slice(0,40),isBody:a===document.body})"
    )
  )
  check('Escape closes the review dialog, restores focus to the review trigger, and writes nothing', () => {
    assert.equal(lastFocus.dialogOpen, false)
    assert.equal(lastFocus.isReview, true, 'focus should return to the review button')
    assert.equal(policyWrites().length, 0)
  })

  await run(
    "window.__origFetch=window.fetch; window.fetch=(...args)=>{const url=typeof args[0]==='string'?args[0]:(args[0]&&args[0].url)||'';const method=(args[1]&&args[1].method)||'GET';if(url.includes('/api/logs/policy')&&method==='PATCH')return new Promise((res,rej)=>setTimeout(()=>window.__origFetch(...args).then(res,rej),1200));return window.__origFetch(...args)}; return true"
  )
  await run("q('[data-testid=log-policy-review]').click(); return true")
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  await run("q('[data-testid=log-policy-confirm]').click(); return true")
  await sleep(150)
  const pending = JSON.parse(
    await run(
      "const b=q('[data-testid=log-policy-confirm]'); return JSON.stringify({text:text(b),disabled:b.disabled,dialog:!!q('[role=dialog][data-state=open]')})"
    )
  )
  check('the confirm button shows 正在提交 and disables while the PATCH is pending', () => {
    assert.match(pending.text, /正在提交/)
    assert.equal(pending.disabled, true)
  })
  await waitFor("document.body.textContent.includes('日志配置已保存。')", 15000)
  await run("window.fetch=window.__origFetch; return true")
  await sleep(800)
  const successShot = await shot('sheet-1280-success.png')
  const readback = JSON.parse(
    await evaluate(
      "(async()=>{const r=await fetch('/api/logs/policy',{headers:{'x-log-browser':'1'},cache:'no-store'});return JSON.stringify(await r.json())})()"
    )
  )
  check('the real PATCH succeeds and GET reads back the HTTP and TUS changes', () => {
    assert.equal(readback.fieldControls.http.debug.durationMs, false)
    assert.equal(readback.fieldControls.http.info.durationMs, false)
    assert.equal(readback.fieldControls.http.warn.durationMs, false)
    assert.equal(readback.fieldControls.http.error.durationMs, false)
    assert.equal(readback.fieldControls.tus.debug['tus.method'], false)
    assert.equal(readback.fieldControls.tus.info['tus.method'], false)
    assert.equal(readback.retentionDays, 7)
    assert.equal(readback.maxBytes, 536870912)
    assert.ok(responses.some((entry) => entry.url.includes('/api/logs/policy') && entry.status === 200))
  })

  await run("open('integration','nuxt-nitro'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-integration-nuxt-nitro]') && q('[data-testid=log-module-sheet-integration-nuxt-nitro]').getAttribute('data-state')==='open'"
  )
  await sleep(300)
  await run("sw('http','httpRoute').click(); return true")
  await sleep(300)
  await run('close(); return true')
  await waitFor("!document.querySelector('[data-slot=sheet-content][data-state=open]')")
  await run(
    "const set=(id,v)=>{const el=byId(id);const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(el,String(v));el.dispatchEvent(new Event('input',{bubbles:true}))}; set('log-retention-days',6); set('log-max-bytes',1048576); return true"
  )
  await sleep(300)
  await run("q('[data-testid=log-policy-review]').click(); return true")
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  await sleep(500)
  const conflictShot = await shot('sheet-1280-409-review.png')
  await run("q('[data-testid=log-policy-confirm]').click(); return true")
  await waitFor("document.body.textContent.includes('原策略仍生效')", 20000)
  await sleep(600)
  await run("open('integration','nuxt-nitro'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-integration-nuxt-nitro]') && q('[data-testid=log-module-sheet-integration-nuxt-nitro]').getAttribute('data-state')==='open'"
  )
  const conflict = JSON.parse(
    await run(
      "return JSON.stringify({notice:document.body.textContent.includes('原策略仍生效'),draftHttp:sw('http','httpRoute').getAttribute('data-state'),draftDays:byId('log-retention-days').value,draftBytes:byId('log-max-bytes').value,sheetText:text(sheet('integration','nuxt-nitro'))})"
    )
  )
  await run('close(); return true')
  await waitFor("!document.querySelector('[data-slot=sheet-content][data-state=open]')")
  const conflictPolicy = JSON.parse(
    await evaluate(
      "(async()=>{const r=await fetch('/api/logs/policy',{headers:{'x-log-browser':'1'},cache:'no-store'});return JSON.stringify(await r.json())})()"
    )
  )
  const conflictUiShot = await shot('sheet-1280-409.png')
  check('a real 409 keeps the draft and never overwrites the committed policy', () => {
    assert.equal(conflict.notice, true)
    assert.equal(conflict.draftHttp, 'checked')
    assert.equal(conflict.draftDays, '6')
    assert.equal(conflict.draftBytes, '1048576')
    assert.equal(conflictPolicy.retentionDays, 7)
    assert.equal(conflictPolicy.maxBytes, 536870912)
    assert.equal(conflictPolicy.fieldControls.http.info.httpRoute, false)
    assert.equal(conflictPolicy.fieldControls.http.info.durationMs, false)
  })

  await run("document.documentElement.classList.add('dark'); return true")
  await sleep(500)
  await run("open('integration','nuxt-nitro'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-integration-nuxt-nitro]') && q('[data-testid=log-module-sheet-integration-nuxt-nitro]').getAttribute('data-state')==='open'"
  )
  await sleep(500)
  const dark = JSON.parse(
    await run(
      "const mcp=row('integration','mcp-toolkit').querySelector('svg'); const s=sheet('integration','nuxt-nitro'); const label=s.querySelector('[data-slot=field-label]'); const root=document.documentElement; return JSON.stringify({mcpColor:getComputedStyle(mcp).color,sheetColor:getComputedStyle(s).color,labelColor:label?getComputedStyle(label).color:null,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,sheetWidth:Math.round(s.getBoundingClientRect().width)})"
    )
  )
  const darkShot = await shot('sheet-1280-dark.png')
  check('dark appearance keeps the Sheet and mono icons readable without horizontal scroll', () => {
    assert.doesNotMatch(dark.mcpColor, /rgba\(0, 0, 0, 0\)|rgb\(0, 0, 0\)/)
    assert.ok(dark.sheetColor && dark.sheetColor !== 'rgba(0, 0, 0, 0)')
    assert.ok(dark.labelColor && dark.labelColor !== 'rgba(0, 0, 0, 0)')
    assert.ok(dark.scrollWidth <= dark.clientWidth)
    assert.ok(dark.sheetWidth >= 400 && dark.sheetWidth <= 520)
  })
  await run('close(); return true')
  await waitFor("!document.querySelector('[data-slot=sheet-content][data-state=open]')")
  await run("document.documentElement.classList.remove('dark'); return true")

  await setViewport(390, 844)
  await sleep(700)
  const mobileClosed = JSON.parse(
    await run(
      "const root=document.documentElement; const rows=qa('[data-testid^=log-module-row-]'); const tiny=qa('*').filter(el=>el.getClientRects().length&&text(el)&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>({tag:el.tagName,font:getComputedStyle(el).fontSize,text:text(el).slice(0,40)})); return JSON.stringify({innerWidth,innerHeight,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,rows:rows.length,rowsMax:Math.max(...rows.map(r=>Math.round(r.getBoundingClientRect().right))),tiny})"
    )
  )
  const mobileIndexShot = await shot('sheet-390-index.png')
  check('390 closed index has no horizontal scroll, no text below 12px and all 22 rows fit', () => {
    assert.equal(mobileClosed.innerWidth, 390)
    assert.equal(mobileClosed.innerHeight, 844)
    assert.ok(mobileClosed.scrollWidth <= mobileClosed.clientWidth)
    assert.equal(mobileClosed.tiny.length, 0, 'tiny text: ' + JSON.stringify(mobileClosed.tiny.slice(0, 5)))
    assert.equal(mobileClosed.rows, 22)
    assert.ok(mobileClosed.rowsMax <= 390, 'row outside viewport: ' + mobileClosed.rowsMax)
  })

  await run("open('integration','nuxt-nitro'); return true")
  await waitFor(
    "!!q('[data-testid=log-module-sheet-integration-nuxt-nitro]') && q('[data-testid=log-module-sheet-integration-nuxt-nitro]').getAttribute('data-state')==='open'"
  )
  await sleep(700)
  await run("const s=sheet('integration','nuxt-nitro'); s.getAnimations().forEach(a=>a.finish()); return true")
  const mobile = JSON.parse(
    await run(
      "const s=sheet('integration','nuxt-nitro'); const r=s.getBoundingClientRect(); const body=q('[data-testid=log-module-sheet-body]'); const footer=q('[data-slot=sheet-footer]'); const fr=footer.getBoundingClientRect(); const root=document.documentElement; const sws=qa('[data-slot=switch]').map(el=>{const x=el.getBoundingClientRect();return {w:Math.round(x.width),h:Math.round(x.height),right:Math.round(x.right)}}); const tiny=qa('*').filter(el=>el.getClientRects().length&&text(el)&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>({tag:el.tagName,font:getComputedStyle(el).fontSize,text:text(el).slice(0,40)})); return JSON.stringify({innerWidth,innerHeight,left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width),scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,overflowY:getComputedStyle(body).overflowY,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,footerBottom:Math.round(fr.bottom),footerTop:Math.round(fr.top),sws,tiny})"
    )
  )
  const mobileSheetShot = await shot('sheet-390-http.png')
  check('390 Sheet is full viewport width, scrolls internally, keeps the footer visible and has no horizontal scroll', () => {
    assert.equal(mobile.width, 390)
    assert.equal(mobile.left, 0)
    assert.equal(mobile.right, 390)
    assert.ok(mobile.scrollWidth <= mobile.clientWidth)
    assert.equal(mobile.overflowY, 'auto')
    assert.ok(mobile.scrollHeight >= mobile.clientHeight)
    assert.ok(mobile.footerTop >= 0 && mobile.footerBottom <= 844)
    assert.equal(mobile.tiny.length, 0, 'tiny text: ' + JSON.stringify(mobile.tiny.slice(0, 5)))
    for (const entry of mobile.sws) assert.ok(entry.right <= 390, 'switch outside viewport: ' + entry.right)
  })

  await run("q('[data-testid=log-field-advanced-http]').click(); return true")
  await sleep(500)
  const advanced = JSON.parse(
    await run(
      "const s=sheet('integration','nuxt-nitro'); s.getAnimations().forEach(a=>a.finish()); const b=q('[data-testid=log-module-sheet-body]'); const f=q('[data-slot=sheet-footer]').getBoundingClientRect(); b.scrollTop=b.scrollHeight; return JSON.stringify({scrollHeight:b.scrollHeight,clientHeight:b.clientHeight,scrollTop:b.scrollTop,footerTop:Math.round(f.top),footerBottom:Math.round(f.bottom),overflowY:getComputedStyle(b).overflowY})"
    )
  )
  const mobileAdvancedShot = await shot('sheet-390-advanced.png')
  check('the 390 advanced field editor scrolls inside the Sheet and keeps the footer visible', () => {
    assert.equal(advanced.overflowY, 'auto')
    assert.ok(advanced.scrollHeight > advanced.clientHeight, 'advanced content should overflow')
    assert.ok(advanced.scrollTop > 0, 'body should scroll to the advanced content')
    assert.ok(advanced.footerTop >= 0 && advanced.footerBottom <= 844)
  })

  const payload = {
    verdict: 'PASS',
    base,
    outDir,
    results,
    escapeVia,
    reviewEscapeVia,
    sheetFocus,
    lastFocus,
    policyWrites: policyWrites(),
    screenshots: {
      defaultShot,
      httpShot,
      reviewShot,
      successShot,
      conflictShot,
      conflictUiShot,
      darkShot,
      mobileIndexShot,
      mobileSheetShot,
      mobileAdvancedShot
    },
    setupStatus,
    chromePort,
    chromePid: chrome.pid
  }
  writeFileSync(join(outDir, 'sheet-browser-results.json'), JSON.stringify(payload, null, 2))
  console.log(JSON.stringify(payload, null, 2))
} catch (error) {
  writeFileSync(
    join(outDir, 'sheet-browser-results.json'),
    JSON.stringify(
      {
        verdict: 'FAIL',
        base,
        outDir,
        results,
        escapeVia,
        reviewEscapeVia,
        sheetFocus,
        lastFocus,
        policyWrites: policyWrites(),
        error: String(error && error.stack ? error.stack : error)
      },
      null,
      2
    )
  )
  console.error('SHEET BROWSER FAILURE', error)
  process.exitCode = 1
}
}
try {
  await run()
} catch (error) {
  lifecycle.errors.push(String(error.stack || error))
  console.error(error)
  process.exitCode = 1
} finally {
  await cleanup()
}
