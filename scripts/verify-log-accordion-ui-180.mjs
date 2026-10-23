#!/usr/bin/env node
/**
 * Accordion UI browser evidence via the repo-owned CDP path.
 *
 * The T3 collaborative preview was opened and navigated successfully, but
 * preview_snapshot timed out twice on the same step (15s each), so this verifier
 * is the documented fallback. It never touches the user's own browser tabs.
 *
 * usage: node scripts/verify-log-accordion-ui-180.mjs <baseUrl> <outDir>
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2]
const outDir = process.argv[3]
if (!base || !outDir) throw new Error('usage: <baseUrl> <outDir>')
mkdirSync(outDir, { recursive: true })
const chromePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const chromePort = 9600 + Math.floor(Math.random() * 200)
const profile = mkdtempSync(join(tmpdir(), 'accordion-ui-chrome-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=' + chromePort,
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
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
let chromeErr = ''
chrome.stderr.setEncoding('utf8')
chrome.stderr.on('data', (chunk) => (chromeErr += chunk))
let cleaned = false
const stopChrome = () => {
  if (cleaned) return
  cleaned = true
  if (chrome.exitCode === null) chrome.kill('SIGKILL')
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
}
process.on('exit', stopChrome)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    stopChrome()
    process.exit(1)
  })
}

async function devtools() {
  for (let i = 0; i < 150; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + chromePort + '/json/version')
      if (response.ok) return response.json()
    } catch {}
    await sleep(100)
  }
  throw new Error('headless Chrome did not start\n' + chromeErr.slice(-800))
}
await devtools()
const target = await (
  await fetch(
    'http://127.0.0.1:' + chromePort + '/json/new?' + encodeURIComponent('about:blank'),
    { method: 'PUT' }
  )
).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
let serial = 0
const pending = new Map()
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
const checks = []
const check = (name, fn) => {
  try {
    fn()
    results.push({ name, result: 'PASS' })
  } catch (error) {
    results.push({ name, result: 'FAIL', error: String(error && error.message ? error.message : error) })
    throw error
  }
  checks.push(name)
}
const H = [
  "const q=(s)=>document.querySelector(s);",
  "const qa=(s)=>Array.from(document.querySelectorAll(s));",
  "const byId=(id)=>document.getElementById(id);",
  "const panel=(p,k)=>q('[data-testid=log-module-'+p+'-'+k+']');",
  "const trig=(p,k)=>panel(p,k).querySelector('[data-slot=accordion-trigger]');",
  "const open=(p,k)=>{const t=trig(p,k);if(t.getAttribute('aria-expanded')!=='true')t.click();return true};",
  "const close=(p,k)=>{const t=trig(p,k);if(t.getAttribute('aria-expanded')==='true')t.click();return true};",
  "const block=(p)=>q('[data-testid=log-field-controls-'+p+']');",
  "const sw=(p,f)=>byId('log-field-'+p+'-all-'+f);",
  "const text=(el)=>el?el.textContent.replace(/\s+/g,' ').trim():'';"
].join('\n')
const run = (body) => evaluate('(() => {' + H + '\n' + body + '\n})()')

let lastFocus = null
let escapeVia = null
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')

try {
  // ---------- 1280 x 900: independent panels, chevrons, icons ----------
  await setViewport(1280, 900)
  await navigate(
    base + '/logs?tab=settings',
    "!!document.querySelector('[data-testid=log-module-integration-nuxt-nitro]')"
  )
  await waitFor("!!document.getElementById('log-field-http-all-httpRoute')")
  // Fixture setup: the API probe is skipped so a real 409 still has capacity
  // headroom. Create the same saved-mixed state through the real API, then
  // reload; this setup write is excluded from the UI policy-write count.
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
  await waitFor("!!document.getElementById('log-field-http-all-httpRoute')")
  // Hide the dev-only Nuxt DevTools chrome so the screenshots show the product.
  await evaluate(
    "(() => { for (const id of ['nuxt-devtools-container','vue-tracer-overlay']) document.getElementById(id)?.remove(); return true })()"
  )
  await sleep(900)
  network.length = 0
  responses.length = 0
  const initial = JSON.parse(
    await run(
      "return JSON.stringify({panels:qa('[data-testid^=log-module-]').length,httpOpen:trig('integration','nuxt-nitro').getAttribute('aria-expanded'),tusOpen:trig('integration','tus').getAttribute('aria-expanded'),httpBlock:!!block('http'),tusBlock:!!block('tus'),bottom:!!q('[data-testid=log-field-controls]'),switches:qa('[data-slot=switch]').length})"
    )
  )
  const defaultShot = await shot('accordion-1280-default.png')
  check('HTTP is the default-open panel; TUS is closed; the old bottom block is gone', () => {
    assert.equal(setupStatus, 200)
    assert.equal(initial.panels, 22)
    assert.equal(initial.httpOpen, 'true')
    assert.equal(initial.tusOpen, 'false')
    assert.equal(initial.httpBlock, true)
    assert.equal(initial.tusBlock, false)
    assert.equal(initial.bottom, false)
  })

  await run("open('integration','tus'); return true")
  await sleep(700)
  const both = JSON.parse(
    await run(
      "return JSON.stringify({http:!!block('http'),tus:!!block('tus'),httpOpen:trig('integration','nuxt-nitro').getAttribute('aria-expanded'),tusOpen:trig('integration','tus').getAttribute('aria-expanded')})"
    )
  )
  const bothShot = await shot('accordion-1280-http-tus.png')
  check('HTTP and TUS panels open independently at the same time', () => {
    assert.equal(both.http, true)
    assert.equal(both.tus, true)
    assert.equal(both.httpOpen, 'true')
    assert.equal(both.tusOpen, 'true')
  })

  const chevrons = JSON.parse(
    await run(
      "return JSON.stringify(qa('[data-testid=log-panel-chevron]').map(el=>{const s=el.querySelector('svg');return {html:el.innerHTML,transform:getComputedStyle(s).transform,cls:el.className,path:!!s.querySelector('path')}}))"
    )
  )
  check('every module chevron is the fixed lucide chevron-right and never rotates when open', () => {
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
      "const chev=qa('[data-testid=log-panel-chevron] svg.iconify'); const all=qa('svg.iconify'); return JSON.stringify({chevrons:chev.length,all:all.length,empty:all.filter(s=>!s.getAttribute('viewBox')||s.childElementCount===0).length,emptyHtml:all.filter(s=>!s.getAttribute('viewBox')||s.childElementCount===0).map(s=>({html:s.outerHTML.slice(0,300),parent:s.parentElement?s.parentElement.outerHTML.slice(0,300):null})),remote:performance.getEntriesByType('resource').filter(e=>e.name.includes('api.iconify.design')).length,nuxt:panel('integration','nuxt-nitro').querySelector('svg.iconify').outerHTML.includes('00dc82'),tus:panel('integration','tus').querySelector('svg.iconify').outerHTML.includes('43AA91'),mcpColor:getComputedStyle(panel('integration','mcp-toolkit').querySelector('svg.iconify')).color,mcpCurrent:panel('integration','mcp-toolkit').querySelector('svg.iconify').outerHTML.includes('currentColor')})"
    )
  )
  check('all icons render from the local Nuxt Icon bundle, including brand and custom assets', () => {
    assert.equal(icons.chevrons, 22)
    assert.ok(icons.all > 50, 'expected section, group, module and chevron icons: ' + icons.all)
    assert.equal(icons.empty, 0, 'empty icons: ' + JSON.stringify(icons.emptyHtml))
    assert.equal(icons.remote, 0)
    assert.equal(icons.nuxt, true)
    assert.equal(icons.tus, true)
    assert.equal(icons.mcpCurrent, true)
    assert.doesNotMatch(icons.mcpColor, /rgba\(0, 0, 0, 0\)|rgb\(0, 0, 0\)/)
  })

  await run("close('integration','nuxt-nitro'); return true")
  await sleep(500)
  const closedOne = JSON.parse(
    await run(
      "return JSON.stringify({http:!!block('http'),tus:!!block('tus'),httpOpen:trig('integration','nuxt-nitro').getAttribute('aria-expanded')})"
    )
  )
  check('closing one panel leaves the other panel and its draft mounted', () => {
    assert.equal(closedOne.http, false)
    assert.equal(closedOne.tus, true)
    assert.equal(closedOne.httpOpen, 'false')
  })
  await run("open('integration','nuxt-nitro'); return true")
  await sleep(600)

  // ---------- fields follow their collector; sources get a note, not switches ----------
  await run("open('source','http'); return true")
  await run("open('source','task'); return true")
  await sleep(600)
  const follow = JSON.parse(
    await run(
      "const httpRow=q('[data-testid=log-module-source-http]'); const taskRow=q('[data-testid=log-module-source-task]'); return JSON.stringify({httpFields:httpRow.querySelectorAll('[data-testid^=log-field-controls]').length,httpSwitches:httpRow.querySelectorAll('[data-slot=switch]').length,httpText:text(httpRow),taskText:text(taskRow),httpBlockSwitches:block('http').querySelectorAll('[data-slot=switch]').length,tusBlockSwitches:block('tus').querySelectorAll('[data-slot=switch]').length})"
    )
  )
  check('HTTP/TUS fields live in their collector panels; source rows show a follow note and no fake fields', () => {
    assert.equal(follow.httpFields, 0)
    assert.equal(follow.httpSwitches, 1)
    assert.match(follow.httpText, /此来源没有独立的详情字段/)
    assert.match(follow.httpText, /字段跟随「Nuxt \/ Nitro 请求」/)
    assert.match(follow.taskText, /该模块没有独立的详情字段/)
    assert.equal(follow.httpBlockSwitches, 4)
    assert.equal(follow.tusBlockSwitches, 4)
  })
  await run("close('source','http'); close('source','task'); return true")
  await sleep(300)

  // ---------- saved mixed state is visible and not overwritten on read ----------
  const mixed = JSON.parse(
    await run(
      "const el=sw('http','httpRoute'); return JSON.stringify({attr:el.getAttribute('data-mixed'),state:el.getAttribute('data-state'),aria:el.getAttribute('aria-checked'),text:text(block('http'))})"
    )
  )
  check('a saved mixed level shows an explicit mixed state without writing anything', () => {
    assert.equal(mixed.attr, 'true')
    assert.equal(mixed.state, 'unchecked')
    assert.equal(mixed.aria, 'false')
    assert.match(mixed.text, /各级别不一致/)
    assert.equal(policyWrites().length, 0)
  })

  // ---------- draft change; cancel; Escape; focus ----------
  await run("sw('http','durationMs').click(); return true")
  await sleep(400)
  const draft = JSON.parse(
    await run(
      "return JSON.stringify({state:sw('http','durationMs').getAttribute('data-state'),review:!q('[data-testid=log-policy-review]').disabled})"
    )
  )
  check('a draft change enables review and writes nothing yet', () => {
    assert.equal(draft.state, 'unchecked')
    assert.equal(draft.review, true)
    assert.equal(policyWrites().length, 0)
  })
  await run("q('[data-testid=log-policy-review]').scrollIntoView({block:'center'}); q('[data-testid=log-policy-review]').click(); return true")
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  await sleep(600)
  const reviewShot = await shot('accordion-1280-review.png')
  await run("const d=q('[role=dialog][data-state=open]'); Array.from(d.querySelectorAll('button')).find(b=>b.textContent.trim()==='取消').click(); return true")
  await waitFor("!document.querySelector('[role=dialog][data-state=open]')")
  await sleep(400)
  check('cancelling the review dialog sends zero policy writes', () => {
    assert.equal(policyWrites().length, 0)
  })

  await run("q('[data-testid=log-policy-review]').click(); return true")
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  await run("const d=q('[role=dialog][data-state=open]'); const c=Array.from(d.querySelectorAll('button')).find(b=>b.textContent.trim()==='取消'); c.focus(); return true")
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
  escapeVia = 'cdp-input'
  let closedByKey = false
  for (let i = 0; i < 20; i++) {
    if (!(await evaluate("!!document.querySelector('[role=dialog][data-state=open]')"))) {
      closedByKey = true
      break
    }
    await sleep(100)
  }
  if (!closedByKey) {
    escapeVia = 'dom-keydown-on-document'
    await evaluate(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true})); return true"
    )
  }
  await waitFor("!document.querySelector('[role=dialog][data-state=open]')")
  const nudged = await evaluate(
    "(() => { const d=document.querySelector('[role=dialog]'); if(!d) return false; d.dispatchEvent(new AnimationEvent('animationend',{animationName:'fade-out-0',bubbles:true})); return true })()"
  )
  await waitFor("!document.querySelector('[role=dialog]')", 5000).catch(() => {})
  await sleep(300)
  lastFocus = JSON.parse(
    await run(
      "const a=document.activeElement; return JSON.stringify({dialogOpen:!!q('[role=dialog][data-state=open]'),isReview:a===q('[data-testid=log-policy-review]'),tag:a?a.tagName:null,activeText:text(a).slice(0,40),isBody:a===document.body,mounted:!!q('[role=dialog]')})"
    )
  )
  check('Escape closes the review dialog, restores focus to the review trigger, and sends zero policy writes', () => {
    assert.equal(lastFocus.dialogOpen, false)
    assert.equal(lastFocus.isReview, true, 'focus should return to the review button')
    assert.equal(policyWrites().length, 0)
  })

  // ---------- pending is visible, then a real PATCH succeeds and is read back ----------
  await run(
    "window.__origFetch=window.fetch; window.fetch=(...args)=>{const url=typeof args[0]==='string'?args[0]:(args[0]&&args[0].url)||'';const method=(args[1]&&args[1].method)||'GET';if(url.includes('/api/logs/policy')&&method==='PATCH')return new Promise((res,rej)=>setTimeout(()=>window.__origFetch(...args).then(res,rej),1200));return window.__origFetch(...args)}; return true"
  )
  await run("sw('http','httpMethod').click(); return true")
  await sleep(400)
  await run("q('[data-testid=log-policy-review]').click(); return true")
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  await run("q('[data-testid=log-policy-confirm]').click(); return true")
  await sleep(150)
  const pendingUi = JSON.parse(
    await run(
      "const b=q('[data-testid=log-policy-confirm]'); return JSON.stringify({text:text(b),disabled:b.disabled,dialog:!!q('[role=dialog][data-state=open]')})"
    )
  )
  check('the submit button exposes 正在提交 and disables itself while the PATCH is pending', () => {
    assert.match(pendingUi.text, /正在提交/)
    assert.equal(pendingUi.disabled, true)
  })
  await waitFor("document.body.textContent.includes('日志配置已保存。')", 15000)
  await run("window.fetch=window.__origFetch; return true")
  await sleep(800)
  const successShot = await shot('accordion-1280-success.png')
  const readback = JSON.parse(
    await evaluate(
      "(async()=>{const r=await fetch('/api/logs/policy',{headers:{'x-log-browser':'1'},cache:'no-store'});return JSON.stringify(await r.json())})()"
    )
  )
  check('a real PATCH succeeds, the UI reports saved, and GET reads back every changed level', () => {
    assert.equal(readback.fieldControls.http.debug.httpMethod, false)
    assert.equal(readback.fieldControls.http.info.httpMethod, false)
    assert.equal(readback.fieldControls.http.warn.httpMethod, false)
    assert.equal(readback.fieldControls.http.error.httpMethod, false)
    assert.equal(readback.fieldControls.http.info.durationMs, false)
    assert.equal(readback.retentionDays, 7)
    assert.equal(readback.maxBytes, 536870912)
    assert.ok(responses.some((entry) => entry.url.includes('/api/logs/policy') && entry.status === 200))
  })

  // ---------- a real capacity 409 keeps the draft and the committed policy ----------
  await run(
    "const set=(id,v)=>{const el=byId(id);const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(el,String(v));el.dispatchEvent(new Event('input',{bubbles:true}))}; set('log-retention-days',6); set('log-max-bytes',1048576); return true"
  )
  await run("sw('http','httpRoute').click(); return true")
  await sleep(400)
  await run("q('[data-testid=log-policy-review]').click(); return true")
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  await sleep(500)
  const conflictShot = await shot('accordion-1280-409-review.png')
  await run("q('[data-testid=log-policy-confirm]').click(); return true")
  await waitFor("document.body.textContent.includes('原策略仍生效')", 20000)
  await sleep(600)
  const conflict = JSON.parse(
    await run(
      "return JSON.stringify({notice:document.body.textContent.includes('原策略仍生效'),draftHttp:sw('http','httpRoute').getAttribute('data-state'),draftDays:byId('log-retention-days').value,draftBytes:byId('log-max-bytes').value})"
    )
  )
  const conflictPolicy = JSON.parse(
    await evaluate(
      "(async()=>{const r=await fetch('/api/logs/policy',{headers:{'x-log-browser':'1'},cache:'no-store'});return JSON.stringify(await r.json())})()"
    )
  )
  check('a real 409 keeps the draft and never overwrites the committed policy', () => {
    assert.equal(conflict.notice, true)
    assert.equal(conflict.draftHttp, 'checked')
    assert.equal(conflict.draftDays, '6')
    assert.equal(conflict.draftBytes, '1048576')
    assert.equal(conflictPolicy.retentionDays, 7)
    assert.equal(conflictPolicy.maxBytes, 536870912)
    assert.equal(conflictPolicy.fieldControls.http.info.httpRoute, false)
  })
  await sleep(400)
  const conflictUiShot = await shot('accordion-1280-409.png')

  // ---------- dark appearance and readable mono brand icon ----------
  await run("document.documentElement.classList.add('dark'); return true")
  await sleep(500)
  const dark = JSON.parse(
    await run(
      "const mcp=panel('integration','mcp-toolkit').querySelector('svg'); const chev=q('[data-testid=log-panel-chevron] svg'); const root=document.documentElement; return JSON.stringify({mcpColor:getComputedStyle(mcp).color,chevColor:getComputedStyle(chev).color,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth})"
    )
  )
  const darkShot = await shot('accordion-1280-dark.png')
  check('dark appearance keeps the mono MCP/chevron icons readable and the page without horizontal scroll', () => {
    assert.doesNotMatch(dark.mcpColor, /rgba\(0, 0, 0, 0\)|rgb\(0, 0, 0\)/)
    assert.doesNotMatch(dark.chevColor, /rgba\(0, 0, 0, 0\)|rgb\(0, 0, 0\)/)
    // The app tokens are oklch(); getComputedStyle preserves that notation.
    const light = (() => {
      const color = dark.mcpColor
      if (color.startsWith('oklch('))
        return Number(color.slice(6).trim().split(/[\s/,]+/)[0]) > 0.5
      const rgb = (color.match(/\d+(?:\.\d+)?/g) || []).map(Number)
      return rgb.length >= 3 && rgb[0] > 100 && rgb[1] > 100 && rgb[2] > 100
    })()
    assert.ok(light, 'dark icon color should be light: ' + dark.mcpColor)
    assert.ok(dark.scrollWidth <= dark.clientWidth)
  })
  await run("document.documentElement.classList.remove('dark'); return true")

  // ---------- 390 x 844 ----------
  await setViewport(390, 844)
  await sleep(700)
  const mobileClosed = JSON.parse(
    await run(
      "const root=document.documentElement; return JSON.stringify({innerWidth,innerHeight,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,panels:qa('[data-testid^=log-module-]').length})"
    )
  )
  const mobileDefaultShot = await shot('accordion-390-default.png')
  await run("open('integration','tus'); return true")
  await sleep(700)
  await run("q('[data-testid=log-module-integration-nuxt-nitro]').scrollIntoView({block:'start'}); return true")
  await sleep(500)
  const mobile = JSON.parse(
    await run(
      "const root=document.documentElement; const sws=qa('[data-slot=switch]').map(s=>{const r=s.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right)}}); const tiny=qa('*').filter(el=>el.getClientRects().length&&text(el)&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>({tag:el.tagName,font:getComputedStyle(el).fontSize,text:text(el).slice(0,40)})); const panels=qa('[data-testid^=log-module-]').map(el=>Math.round(el.getBoundingClientRect().right)); return JSON.stringify({innerWidth,innerHeight,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,sws,tiny,panelsMax:Math.max(...panels)})"
    )
  )
  const mobileOpenShot = await shot('accordion-390-open.png')
  check('390x844 has no horizontal scroll, no text below 12px, and every switch fits', () => {
    assert.equal(mobile.innerWidth, 390)
    assert.equal(mobile.innerHeight, 844)
    assert.ok(
      mobile.scrollWidth <= mobile.clientWidth,
      'horizontal overflow: ' + mobile.scrollWidth + ' > ' + mobile.clientWidth
    )
    assert.equal(mobile.tiny.length, 0, 'text below 12px: ' + JSON.stringify(mobile.tiny.slice(0, 5)))
    for (const entry of mobile.sws) {
      assert.equal(entry.w, 32)
      assert.equal(entry.h, 18)
      assert.ok(entry.right <= 390, 'switch outside viewport: ' + entry.right)
    }
    assert.ok(mobile.panelsMax <= 390, 'panel outside viewport: ' + mobile.panelsMax)
  })
  check('the 390 closed state still shows all 22 module panels', () => {
    assert.equal(mobileClosed.panels, 22)
    assert.equal(mobileClosed.innerWidth, 390)
  })

  const payload = {
    verdict: 'PASS',
    base,
    outDir,
    results,
    escapeVia,
    lastFocus,
    policyWrites: policyWrites(),
    screenshots: {
      defaultShot,
      bothShot,
      reviewShot,
      successShot,
      conflictShot,
      conflictUiShot,
      darkShot,
      mobileDefaultShot,
      mobileOpenShot
    },
    setupStatus,
    chromePort,
    chromePid: chrome.pid
  }
  writeFileSync(join(outDir, 'accordion-browser-results.json'), JSON.stringify(payload, null, 2))
  console.log(JSON.stringify(payload, null, 2))
} catch (error) {
  writeFileSync(
    join(outDir, 'accordion-browser-results.json'),
    JSON.stringify(
      {
        verdict: 'FAIL',
        base,
        outDir,
        results,
        escapeVia,
        lastFocus,
        policyWrites: policyWrites(),
        error: String(error && error.stack ? error.stack : error)
      },
      null,
      2
    )
  )
  console.error('ACCORDION BROWSER FAILURE', error)
  process.exitCode = 1
} finally {
  stopChrome()
  writeFileSync(
    join(outDir, 'accordion-browser-closeout.json'),
    JSON.stringify(
      {
        chromePort,
        chromePid: chrome.pid,
        chromeExit: { code: chrome.exitCode, signal: chrome.signalCode },
        profile,
        profileRemoved: !existsSync(profile)
      },
      null,
      2
    )
  )
}
