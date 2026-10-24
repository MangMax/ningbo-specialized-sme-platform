#!/usr/bin/env node
/**
 * F03 browser evidence via repo-owned CDP (headless Chrome), against the already
 * running owned fixture from scripts/verify-log-fields-ui-180.mjs.
 *
 * Why this exists: the T3 preview snapshot channel timed out three times on the
 * same step (15s each), so per the fallback rule the agent switched to the
 * repo's own CDP path. This script never touches the user's own browser tabs.
 *
 * usage: node scripts/verify-log-fields-ui-browser-180.mjs <baseUrl> <outDir>
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2]
const outDir = process.argv[3]
if (!base || !outDir) throw new Error('usage: <baseUrl> <outDir>')
mkdirSync(outDir, { recursive: true })
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chromePort = 9400 + Math.floor(Math.random() * 300)
const profile = mkdtempSync(join(tmpdir(), 'f03-chrome-'))
const chrome = spawn(chromePath, [
  '--headless=new', '--remote-debugging-port=' + chromePort, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--remote-allow-origins=*', '--window-size=1280,800', 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })
let chromeErr = ''
chrome.stderr.setEncoding('utf8')
chrome.stderr.on('data', (chunk) => (chromeErr += chunk))
// Always reclaim the owned Chrome profile: a killed run must not leave a
// f03-chrome-* directory (or a live Chrome) behind for the next session.
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
const target = await (await fetch('http://127.0.0.1:' + chromePort + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0
const pending = new Map()
const network = []
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
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
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
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(outDir, name)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}
async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
}
async function navigate(url, ready) {
  await send('Page.navigate', { url })
  await waitFor("document.readyState === 'complete'")
  await waitFor(ready)
  await sleep(700)
}

const results = []
const check = (name, fn) => { try { fn(); results.push({ name, result: 'PASS' }) } catch (e) { results.push({ name, result: 'FAIL', error: String(e && e.message ? e.message : e) }); throw e } }
const writes = () => network.filter((entry) => entry.method !== 'GET' && entry.method !== 'OPTIONS')
const PANEL = "[data-testid=log-field-controls]"
let lastFocus = null
let lastEscape = null

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')

try {
  // ---------- desktop 1280x800 ----------
  await setViewport(1280, 800)
  await navigate(base + '/logs?tab=settings', "!!document.querySelector('[data-testid=log-field-controls]')")
  const desktopShot = await shot('f03-desktop-1280-collapsed.png')
  const closed = await evaluate("(() => { const trigger = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('详情字段（高级）')); const root = document.documentElement; return JSON.stringify({ expanded: trigger.getAttribute('aria-expanded'), text: trigger.textContent.replace(/\\s+/g,' ').trim(), scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }) })()")
  const closedState = JSON.parse(closed)
  check('desktop starts collapsed and states the saved state without horizontal scroll', () => {
    assert.equal(closedState.expanded, 'false')
    assert.match(closedState.text, /详情字段（高级）/)
    assert.match(closedState.text, /不记录|默认全部保留/)
    assert.ok(closedState.scrollWidth <= closedState.clientWidth)
  })
  await evaluate("(() => { const t = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('详情字段（高级）')); t.scrollIntoView({block:'center'}); t.click(); return true })()")
  await waitFor("document.querySelector('[data-testid=log-field-controls] button[data-slot=accordion-trigger]').getAttribute('aria-expanded') === 'true'")
  // Sample the real open animation inside the field panel only (other disclosure
  // panels on this page have their own closed content nodes).
  const CONTENT = "[data-testid=log-field-controls] [data-slot=accordion-content]"
  const early = JSON.parse(await evaluate("(() => { const c = document.querySelector('" + CONTENT + "'); const s = getComputedStyle(c); return JSON.stringify({ state: c.getAttribute('data-state'), height: Math.round(c.getBoundingClientRect().height), animationName: s.animationName, duration: s.animationDuration }) })()"))
  await waitFor("(() => { const c = document.querySelector('" + CONTENT + "'); return !!c && c.getBoundingClientRect().height > " + early.height + " })()", 5000).catch(() => {})
  await sleep(900)
  const animation = JSON.parse(await evaluate("(() => { const c = document.querySelector('" + CONTENT + "'); const s = getComputedStyle(c); return JSON.stringify({ state: c.getAttribute('data-state'), animationName: earlyAnimationName, duration: s.animationDuration, height: Math.round(c.getBoundingClientRect().height) }) })()".replace('earlyAnimationName', JSON.stringify(early.animationName))))
  await sleep(600)
  await evaluate("(() => { document.querySelector('[data-testid=log-field-controls]').scrollIntoView({ block: 'center' }); return true })()")
  await sleep(400)
  const panelShot = await shot('f03-desktop-1280-expanded-http.png')
  const desktop = JSON.parse(await evaluate("(() => {\n  const panel = document.querySelector('[data-testid=log-field-controls]')\n  const root = document.documentElement\n  const tabs = Array.from(panel.querySelectorAll('[role=tab]')).map(t => ({ label: t.textContent.trim(), selected: t.getAttribute('aria-selected') }))\n  const switches = Array.from(panel.querySelectorAll('[data-slot=switch]'))\n  const fieldRects = Array.from(panel.querySelectorAll('[data-slot=field-group] > [data-slot=field]')).map(f => { const r = f.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width) } })\n  return JSON.stringify({\n    tabs, switchCount: switches.length,\n    switchStates: switches.map(s => ({ id: s.id, state: s.getAttribute('data-state') })),\n    fieldRects, gridCols: getComputedStyle(panel.querySelector('[data-slot=field-group]')).gridTemplateColumns,\n    scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,\n    nativeCheckbox: panel.querySelectorAll('input[type=checkbox]').length,\n    nativeSelect: panel.querySelectorAll('select').length,\n    details: panel.querySelectorAll('details').length,\n    tiny: Array.from(panel.querySelectorAll('*')).filter(el => getComputedStyle(el).fontSize === '11px').length,\n    cardInCard: panel.querySelectorAll('[data-slot=card] [data-slot=card]').length\n  })\n})()"))
  check('desktop shows two profile tabs and 4 level tabs with 4 switches, no matrix or native controls', () => {
    assert.deepEqual(desktop.tabs.slice(0, 2).map(t => t.label), ['HTTP 请求', 'TUS 上传'])
    assert.deepEqual(desktop.tabs.slice(2).map(t => t.label), ['调试', '信息', '警告', '错误'])
    assert.equal(desktop.tabs.filter(t => t.selected === 'true').length, 2)
    assert.equal(desktop.switchCount, 4)
    assert.equal(desktop.fieldRects.length, 4)
    assert.equal(new Set(desktop.fieldRects.map(r => r.left)).size, 2)
    assert.equal(new Set(desktop.fieldRects.map(r => r.top)).size, 2)
    assert.equal(desktop.nativeCheckbox, 0)
    assert.equal(desktop.nativeSelect, 0)
    assert.equal(desktop.details, 0)
    assert.equal(desktop.tiny, 0)
    assert.equal(desktop.cardInCard, 0)
    assert.ok(desktop.scrollWidth <= desktop.clientWidth)
  })
  check('the shared disclosure runs its real open animation and ends taller than it started', () => {
    assert.equal(early.state, 'open')
    assert.equal(animation.state, 'open')
    assert.equal(early.animationName, 'accordion-down')
    assert.equal(early.duration, '0.2s')
    assert.ok(animation.height > early.height, 'content grows: ' + early.height + ' -> ' + animation.height)
  })

  await evaluate("(() => { Array.from(document.querySelectorAll('[data-testid=log-field-controls] [role=tab]')).find(t => t.textContent.trim() === 'TUS 上传').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()")
  await sleep(500)
  const tusDesktop = JSON.parse(await evaluate("(() => {\n  const panel = document.querySelector('[data-testid=log-field-controls]')\n  return JSON.stringify({\n    ids: Array.from(panel.querySelectorAll('[data-slot=switch]')).map(s => s.id),\n    states: Array.from(panel.querySelectorAll('[data-slot=switch]')).map(s => s.getAttribute('data-state')),\n    status: panel.querySelector('[data-testid=log-field-status]') ? panel.querySelector('[data-testid=log-field-status]').textContent.trim() : null,\n    parentOff: panel.textContent.includes('当前不采集')\n  })\n})()"))
  const tusShot = await shot('f03-desktop-1280-tus.png')
  check('TUS profile keeps the dotted catalog keys switch by switch', () => {
    assert.deepEqual(tusDesktop.ids.slice().sort(), [
      'log-field-tus-info-tus.method', 'log-field-tus-info-tus.offset',
      'log-field-tus-info-tus.size', 'log-field-tus-info-tus.uploadId'
    ])
    assert.equal(tusDesktop.parentOff, false)
  })

  const writesBefore = writes().length
  await evaluate("(() => { Array.from(document.querySelectorAll('[data-testid=log-field-controls] [role=tab]')).find(t => t.textContent.trim() === 'HTTP 请求').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()")
  await sleep(400)
  // A real draft change is required: with no diff the review button is correctly disabled.
  const beforeState = await evaluate("document.querySelector('[data-testid=log-field-controls] [data-slot=switch]').getAttribute('data-state')")
  await evaluate("(() => { document.querySelector('[data-testid=log-field-controls] [data-slot=switch]').click(); return true })()")
  await sleep(400)
  const draftChange = await evaluate("(() => ({ before: " + JSON.stringify(beforeState) + ", after: document.querySelector('[data-testid=log-field-controls] [data-slot=switch]').getAttribute('data-state'), reviewEnabled: !document.querySelector('[data-testid=log-policy-review]').disabled }))()")
  check('a draft change enables review while writing nothing', () => {
    assert.notEqual(draftChange.before, draftChange.after)
    assert.equal(draftChange.reviewEnabled, true)
    assert.equal(writes().length, writesBefore)
  })
  await sleep(300)
  await evaluate("(() => { const b = document.querySelector('[data-testid=log-policy-review]'); b.scrollIntoView({block:'center'}); b.click(); return true })()")
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  // Let the shared Dialog's zoom/fade finish so the screenshot shows the settled
  // dialog, not a mid-animation frame.
  await sleep(700)
  const dialogShot = await shot('f03-desktop-1280-review.png')
  await evaluate("(() => { const d = document.querySelector('[role=dialog][data-state=open]'); Array.from(d.querySelectorAll('button')).find(b => b.textContent.trim() === '取消').click(); return true })()")
  await waitFor("!document.querySelector('[role=dialog][data-state=open]')")
  await sleep(300)
  check('cancelling the review dialog sends zero writes', () => {
    assert.equal(writes().length, writesBefore)
  })

  // ---------- 390x844 ----------
  await setViewport(390, 844)
  await sleep(600)
  const mobile = JSON.parse(await evaluate("(() => {\n  const panel = document.querySelector('[data-testid=log-field-controls]')\n  const root = document.documentElement\n  const fields = Array.from(panel.querySelectorAll('[data-slot=field-group] > [data-slot=field]')).map(f => { const r = f.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) } })\n  const sw = Array.from(panel.querySelectorAll('[data-slot=switch]')).map(s => { const r = s.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) } })\n  const lists = Array.from(panel.querySelectorAll('[role=tablist]'))\n  const levelTabs = lists[1]\n  return JSON.stringify({\n    innerWidth, innerHeight,\n    scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,\n    fieldCount: fields.length, fieldLefts: fields.map(f => f.left), fieldTops: fields.map(f => f.top),\n    gridCols: getComputedStyle(panel.querySelector('[data-slot=field-group]')).gridTemplateColumns,\n    switches: sw,\n    levelTabWidths: Array.from(levelTabs.querySelectorAll('[role=tab]')).map(t => Math.round(t.getBoundingClientRect().width)),\n    panelRight: Math.round(panel.getBoundingClientRect().right),\n    tiny: Array.from(panel.querySelectorAll('*')).filter(el => getComputedStyle(el).fontSize === '11px').length\n  })\n})()"))
  const mobileShot = await shot('f03-mobile-390-expanded.png')
  // Scroll the panel itself into view so the saved screenshot shows the controls,
  // not the top of the settings page.
  await evaluate("(() => { document.querySelector('[data-testid=log-field-controls]').scrollIntoView({ block: 'start' }); return true })()")
  await sleep(400)
  const mobilePanelShot = await shot('f03-mobile-390-panel.png')
  check('390x844 is one column with no horizontal scroll and every control inside the viewport', () => {
    assert.equal(mobile.innerWidth, 390)
    assert.equal(mobile.innerHeight, 844)
    assert.ok(mobile.scrollWidth <= mobile.clientWidth, 'page must not scroll horizontally: ' + mobile.scrollWidth + ' > ' + mobile.clientWidth)
    assert.equal(mobile.fieldCount, 4)
    assert.equal(new Set(mobile.fieldLefts).size, 1)
    assert.equal(new Set(mobile.fieldTops).size, 4)
    assert.match(mobile.gridCols, /^[0-9.]+px$/)
    for (const s of mobile.switches) { assert.equal(s.w, 32); assert.equal(s.h, 18); assert.ok(s.right <= 390) }
    assert.equal(new Set(mobile.levelTabWidths).size, 1)
    assert.equal(mobile.tiny, 0)
  })

  await evaluate("(() => { const b = document.querySelector('[data-testid=log-policy-review]'); b.scrollIntoView({block:'center'}); b.focus(); b.click(); return true })()")
  await waitFor("!!document.querySelector('[role=dialog][data-state=open]')")
  // Move focus into the dialog (the cancel button) so the key event has a target,
  // then send a real CDP key event. If the headless channel does not route Escape
  // to the Reka content handler, fall back to a DOM keydown on that same element
  // and record which path was used instead of silently claiming the raw key path.
  await evaluate("(() => { const d = document.querySelector('[role=dialog][data-state=open]'); const cancel = Array.from(d.querySelectorAll('button')).find(b => b.textContent.trim() === '取消'); cancel.focus(); return true })()")
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  var escapeVia = 'cdp-input'
  let closedByKey = false
  for (let i = 0; i < 20; i++) { if (!(await evaluate("!!document.querySelector('[role=dialog][data-state=open]')"))) { closedByKey = true; break } await sleep(100) }
  lastEscape = JSON.parse(await evaluate("(() => { const d = document.querySelector('[role=dialog][data-state=open]'); return JSON.stringify({ openByCdp: !!d, active: (document.activeElement && document.activeElement.tagName) || null, activeText: (document.activeElement && document.activeElement.textContent || '').trim().slice(0, 20) }) })()"))
  if (!closedByKey) {
    // Reka's dismissable layer listens for Escape on the document, so replay the
    // same event there. Recorded as a separate path, not claimed as raw input.
    escapeVia = 'dom-keydown-on-document'
    await evaluate("(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true })); return true })()")
  }
  await waitFor("!document.querySelector('[role=dialog][data-state=open]')")
  // Focus restoration happens when the shared Dialog unmounts after its close
  // animation. Headless Chrome may never fire animationend, so nudge that event
  // (the same event the shared component listens to) instead of sleeping forever.
  const nudged = await evaluate("(() => { const d = document.querySelector('[role=dialog]'); if (!d) return false; d.dispatchEvent(new AnimationEvent('animationend', { animationName: 'fade-out-0', bubbles: true })); return true })()")
  await waitFor("!document.querySelector('[role=dialog]')", 5000).catch(() => {})
  await sleep(300)
  lastEscape = { ...(lastEscape || {}), nudgedAnimationEnd: nudged }
  const focus = JSON.parse(await evaluate("(() => { const a = document.activeElement; return JSON.stringify({ dialogOpen: !!document.querySelector('[role=dialog][data-state=open]'), isReview: a === document.querySelector('[data-testid=log-policy-review]'), tag: a ? a.tagName : null, activeText: (a && a.textContent || '').trim().slice(0, 40), isBody: a === document.body, dialogStillMounted: !!document.querySelector('[role=dialog]') }) })()"))
  lastFocus = focus
  // Headless Chrome runs the tab as hidden, so the shared Dialog's CSS close
  // animation never fires animationend and the portal stays mounted; focus is
  // restored by the library only on unmount. The close itself and zero writes are
  // asserted here; the focus-restore path is verified in the interactive preview
  // tab (see f03-ui-handoff.md) and this limitation is reported, not hidden.
  check('Escape closes the review dialog and sends zero writes', () => {
    assert.equal(focus.dialogOpen, false)
    assert.equal(writes().length, writesBefore)
  })

  const payload = { base, outDir, results, escapeVia, writes: writes(), screenshots: { desktopShot, panelShot, tusShot, dialogShot, mobileShot, mobilePanelShot }, chromePort, chromePid: chrome.pid }
  writeFileSync(join(outDir, 'f03-browser-results.json'), JSON.stringify(payload, null, 2))
  console.log(JSON.stringify({ verdict: 'PASS', ...payload }, null, 2))
} catch (error) {
  writeFileSync(join(outDir, 'f03-browser-results.json'), JSON.stringify({ base, outDir, results, escapeVia: typeof escapeVia === 'undefined' ? null : escapeVia, lastFocus, lastEscape, writes: writes(), error: String(error && error.stack ? error.stack : error) }, null, 2))
  console.error('BROWSER FAILURE', error)
  process.exitCode = 1
} finally {
  stopChrome()
}