#!/usr/bin/env node
/**
 * Layout/density measurement for the runtime-log settings tab (F03 polish).
 *
 * Measures the user-reported problems at 1280x800 / 1920x1080 / 390x844:
 *  - right-side whitespace: settings Card width vs the main content inner width
 *  - Tabs overflow: scrollWidth/clientWidth and scrollHeight/clientHeight on both
 *    the profile tablist and the level tablist (implicit vertical scroller)
 *  - text density: persistent explanatory paragraphs and their characters
 * Also asserts keyboard focus is not clipped and the page itself never scrolls X.
 *
 * usage: node scripts/verify-log-settings-layout-180.mjs <baseUrl> <outDir> <label>
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2]
const outDir = process.argv[3]
const label = process.argv[4] || 'run'
if (!base || !outDir) throw new Error('usage: <baseUrl> <outDir> [label]')
mkdirSync(outDir, { recursive: true })
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profileDir = mkdtempSync(join(tmpdir(), 'f03-layout-chrome-'))
const chromePort = 9200 + Math.floor(Math.random() * 200)
const chrome = spawn(chromePath, [
  '--headless=new', '--remote-debugging-port=' + chromePort, '--user-data-dir=' + profileDir,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--remote-allow-origins=*', '--window-size=1280,800', 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })
let cleanupDone = false
function cleanup() {
  if (cleanupDone) return
  cleanupDone = true
  try { chrome.kill('SIGKILL') } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { cleanup(); process.exit(1) })

let ws, serial = 0
const pending = new Map()
async function connect() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch('http://127.0.0.1:' + chromePort + '/json/version'); if (r.ok) break } catch {}
    await sleep(100)
  }
  const target = await (await fetch('http://127.0.0.1:' + chromePort + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(120) }
  throw new Error('waitFor timed out: ' + expression)
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(outDir, name)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}
const setViewport = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })

/** Runs inside the page; stringified and evaluated over CDP. */
function measureInPage() {
  const card = document.querySelector('[data-testid=log-settings-card]')
  const cardRect = card ? card.getBoundingClientRect() : null
  // The available width is the card's own scroll container content box. Using the
  // outer <main> would count the page's vertical scrollbar as "wasted whitespace".
  const holder = card ? card.parentElement : null
  const holderStyle = holder ? getComputedStyle(holder) : null
  const mainInner = holder
    ? holder.clientWidth - parseFloat(holderStyle.paddingLeft || '0') - parseFloat(holderStyle.paddingRight || '0')
    : null
  const lists = Array.from(document.querySelectorAll('[data-testid=log-field-controls] [role=tablist]'))
  const tabGeometry = lists.map((list) => {
    const s = getComputedStyle(list)
    const triggers = Array.from(list.querySelectorAll('[role=tab]'))
    const lr = list.getBoundingClientRect()
    return {
      ariaLabel: list.getAttribute('aria-label'),
      clientWidth: list.clientWidth, scrollWidth: list.scrollWidth,
      clientHeight: list.clientHeight, scrollHeight: list.scrollHeight,
      overflowX: s.overflowX, overflowY: s.overflowY,
      overflowsX: list.scrollWidth > list.clientWidth + 1,
      overflowsY: list.scrollHeight > list.clientHeight + 1,
      triggerCount: triggers.length,
      triggerHeights: triggers.map((t) => Math.round(t.getBoundingClientRect().height)),
      triggerClippedY: triggers.filter((t) => { const tr = t.getBoundingClientRect(); return tr.bottom > lr.bottom + 1 || tr.top < lr.top - 1 }).length
    }
  })
  const panel = document.querySelector('[data-testid=log-field-controls]')
  const switches = panel ? Array.from(panel.querySelectorAll('[data-slot=switch]')) : []
  const switchGeometry = switches.map((s) => { const r = s.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) } })
  const settings = document.querySelector('[data-testid=log-settings-card]') || document.body
  const isPersistent = (el) => !el.closest('[role=dialog]') && !el.closest('[role=status]') && !el.closest('[data-dynamic]') && !el.closest('[aria-live]')
  const paragraphs = Array.from(settings.querySelectorAll('p')).filter(isPersistent).map((el) => el.textContent.replace(/\s+/g, ' ').trim()).filter((text) => text.length > 0)
  const descriptions = Array.from(settings.querySelectorAll('[data-slot=field-description]')).filter(isPersistent).map((el) => el.textContent.replace(/\s+/g, ' ').trim())
  const labels = Array.from(settings.querySelectorAll('[data-slot=field-label]')).filter(isPersistent).map((el) => el.textContent.trim())
  const tiny = Array.from(settings.querySelectorAll('*')).filter((el) => { const fs = parseFloat(getComputedStyle(el).fontSize); return fs < 12 && el.textContent.trim().length > 0 && !el.closest('[aria-hidden=true]') }).length
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight },
    pageScroll: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, hasHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth },
    card: cardRect ? { left: Math.round(cardRect.left), right: Math.round(cardRect.right), width: Math.round(cardRect.width) } : null,
    holderTag: holder ? holder.tagName : null,
    mainInner: mainInner === null ? null : Math.round(mainInner),
    cardFillRatio: cardRect && mainInner ? Number((cardRect.width / mainInner).toFixed(3)) : null,
    rightGap: cardRect && mainInner ? Math.round(mainInner - cardRect.width) : null,
    tabGeometry, switchGeometry,
    text: { paragraphCount: paragraphs.length, paragraphChars: paragraphs.join('').length, paragraphs, descriptionCount: descriptions.length, descriptionChars: descriptions.join('').length, descriptions, labelCount: labels.length },
    tinyTextCount: tiny
  })
}

const MEASURE = '(' + measureInPage.toString() + ')()'

async function prepare(url) {
  await send('Page.navigate', { url })
  await waitFor("document.readyState === 'complete'")
  await waitFor("!!document.querySelector('[data-testid=log-settings-card]')")
  // The panel mounts after the policy read; retry the real click instead of
  // assuming a fixed delay, and never synthesize an open state.
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await evaluate("(() => { const t = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('详情字段（高级）')); if (!t) return 'missing'; const inner = t.closest('[data-testid=log-field-controls]') ? t : t; return t.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed' })()")
    if (state === 'open') break
    if (state === 'closed') {
      await evaluate("(() => { const t = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('详情字段（高级）')); t.scrollIntoView({block:'center'}); t.click(); return true })()")
    }
    await sleep(400)
  }
  await waitFor("document.querySelector('[data-testid=log-field-controls] button[data-slot=accordion-trigger]').getAttribute('aria-expanded') === 'true'", 15000)
  await sleep(900)
}

await connect()
await send('Page.enable')
await send('Runtime.enable')

const report = { label, base, viewports: [] }
try {
  for (const pair of [[1280, 800], [1920, 1080], [390, 844]]) {
    await setViewport(pair[0], pair[1])
    await sleep(500)
    await prepare(base + '/logs?tab=settings')
    const data = JSON.parse(await evaluate(MEASURE))
    data.screenshot = await shot(label + '-' + pair[0] + 'x' + pair[1] + '.png')
    data.focus = JSON.parse(await evaluate("(() => { const tabs = Array.from(document.querySelectorAll('[data-testid=log-field-controls] [role=tab]')); const first = tabs[0]; const last = tabs[tabs.length - 1]; const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= -1 && r.bottom <= innerHeight + 1 }; first.focus(); const a = vis(first); last.focus(); const b = vis(last); const clipped = tabs.some((t) => { const tr = t.getBoundingClientRect(); const lr = t.closest('[role=tablist]').getBoundingClientRect(); return tr.top < lr.top - 1 || tr.bottom > lr.bottom + 1 }); return JSON.stringify({ firstFocusable: a, lastFocusable: b, anyTriggerClipped: clipped }) })()"))
    report.viewports.push(data)
  }
  writeFileSync(join(outDir, label + '-layout.json'), JSON.stringify(report, null, 2))
  if (process.argv.includes('--assert')) {
    // Target geometry: the settings Card must use the main inner width, every
    // tablist must be overflow-free in both axes, and the page never scrolls X.
    for (const viewport of report.viewports) {
      const tag = viewport.viewport.w + 'x' + viewport.viewport.h
      assert.equal(viewport.pageScroll.hasHScroll, false, tag + ': page must not scroll horizontally')
      assert.equal(viewport.rightGap, 0, tag + ': settings card must fill the main inner width')
      assert.ok(viewport.cardFillRatio >= 0.999, tag + ': card fill ratio ' + viewport.cardFillRatio)
      assert.ok(viewport.tabGeometry.length >= 2, tag + ': both tablists must exist')
      for (const list of viewport.tabGeometry) {
        assert.equal(list.overflowsX, false, tag + ': ' + list.ariaLabel + ' overflows X')
        assert.equal(list.overflowsY, false, tag + ': ' + list.ariaLabel + ' overflows Y')
        assert.equal(list.triggerClippedY, 0, tag + ': ' + list.ariaLabel + ' clips a tab')
      }
      assert.equal(viewport.focus.anyTriggerClipped, false, tag + ': focus ring would be clipped')
      assert.equal(viewport.tinyTextCount, 0, tag + ': no text under 12px')
    }
    console.log(JSON.stringify({ verdict: 'PASS', viewports: report.viewports.map((v) => ({ viewport: v.viewport, cardWidth: v.card.width, mainInner: v.mainInner, rightGap: v.rightGap, paragraphs: v.text.paragraphCount, paragraphChars: v.text.paragraphChars, tabs: v.tabGeometry.map((t) => ({ label: t.ariaLabel, cw: t.clientWidth, sw: t.scrollWidth, ch: t.clientHeight, sh: t.scrollHeight })) })) }, null, 2))
  } else {
    console.log(JSON.stringify({ verdict: 'MEASURED', report }, null, 2))
  }
} catch (error) {
  writeFileSync(join(outDir, label + '-layout.json'), JSON.stringify({ label, base, error: String(error && error.stack ? error.stack : error), partial: report }, null, 2))
  console.error('LAYOUT FAILURE', error)
  process.exitCode = 1
} finally {
  cleanup()
}