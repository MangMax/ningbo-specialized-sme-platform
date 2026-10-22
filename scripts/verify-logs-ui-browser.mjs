#!/usr/bin/env node
/**
 * Real-browser verification for the runtime logs UI (isolated synthetic fixture).
 *
 * This is the browser companion to scripts/verify-logs-ui-usability.mjs:
 * - the API/fixture verifier starts the isolated Nuxt dev server and writes a manifest;
 * - this script launches headless Chrome over CDP, holds the list request with a
 *   request gate, and verifies skeleton → loaded layout at 1280 and 390;
 * - it also verifies long values, pagination focus, detail close, failed navigation
 *   retaining old rows, and clear/policy cancel writing nothing.
 *
 * It never touches the parent service or business data. Raw results are written to
 * LOGS_UI_BROWSER_OUT/browser-results.json (default: a fresh temp dir).
 *
 * Usage: node scripts/verify-logs-ui-browser.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const worktree = resolve('.')
const outDir = process.env.LOGS_UI_BROWSER_OUT || mkdtempSync(join(tmpdir(), 'logs-ui-browser-'))
mkdirSync(outDir, { recursive: true })
const manifestPath = join(outDir, 'fixture-manifest.json')
const resultsPath = join(outDir, 'browser-results.json')
const fixtureLogPath = join(outDir, 'fixture.log')
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fixture = spawn(process.execPath, ['scripts/verify-logs-ui-usability.mjs', '--serve'], {
  cwd: worktree,
  env: { ...process.env, LOGS_UI_MANIFEST_PATH: manifestPath },
  stdio: ['ignore', 'pipe', 'pipe']
})
let fixtureLog = ''
fixture.stdout.setEncoding('utf8')
fixture.stderr.setEncoding('utf8')
fixture.stdout.on('data', (chunk) => (fixtureLog += chunk))
fixture.stderr.on('data', (chunk) => (fixtureLog += chunk))
function stopFixture() {
  if (fixture.exitCode === null) fixture.kill('SIGTERM')
}
process.on('exit', stopFixture)
process.on('SIGINT', () => {
  stopFixture()
  process.exit(1)
})

async function readManifest(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) {
      writeFileSync(fixtureLogPath, fixtureLog)
      throw new Error(`fixture exited ${fixture.exitCode}\n${fixtureLog.slice(-3000)}`)
    }
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest.realNormalEvent) return manifest
      } catch {
        /* manifest may be mid-write */
      }
    }
    await sleep(200)
  }
  writeFileSync(fixtureLogPath, fixtureLog)
  throw new Error('fixture manifest timeout')
}

const manifest = await readManifest()
const base = manifest.base
const syntheticUrl = new URL(manifest.pagePath, base)
const from = syntheticUrl.searchParams.get('from')
const to = syntheticUrl.searchParams.get('to')
const filterUrl = (extra = {}) => {
  const url = new URL('/logs', base)
  url.searchParams.set('from', from)
  url.searchParams.set('to', to)
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) url.searchParams.set(key, value)
  return url.href
}

// ---------- headless Chrome + CDP ----------
const chromePort = 9300 + Math.floor(Math.random() * 400)
const profile = mkdtempSync(join(tmpdir(), 'logs-ui-chrome-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--remote-allow-origins=*',
    '--window-size=1280,800',
    'about:blank'
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
let chromeErr = ''
chrome.stderr.setEncoding('utf8')
chrome.stderr.on('data', (chunk) => (chromeErr += chunk))
function stopChrome() {
  if (chrome.exitCode === null) chrome.kill('SIGTERM')
}
process.on('exit', stopChrome)

async function devtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${chromePort}/json/version`)
      if (response.ok) return response.json()
    } catch {}
    await sleep(100)
  }
  throw new Error(`headless Chrome did not start\n${chromeErr.slice(-1000)}`)
}
await devtools()
const target = await (
  await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT'
  })
).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
let serial = 0
const pending = new Map()
const network = []
let gateMode = 'continue'
let held = []
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
    return
  }
  if (message.method === 'Network.requestWillBeSent') {
    network.push({
      method: message.params.request.method,
      url: message.params.request.url,
      postData: message.params.request.postData
    })
  }
  if (message.method === 'Fetch.requestPaused') {
    const { requestId, request } = message.params
    let pathname = ''
    try {
      pathname = new URL(request.url).pathname
    } catch {}
    if (pathname === '/api/logs') {
      if (gateMode === 'hold') held.push(requestId)
      else if (gateMode === 'fail') void send('Fetch.failRequest', { requestId, errorReason: 'Aborted' })
      else void send('Fetch.continueRequest', { requestId })
    } else {
      void send('Fetch.continueRequest', { requestId })
    }
  }
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(`waitFor timed out: ${expression}`)
}
async function waitStable(expression, samples = 3, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  let last = await evaluate(expression)
  let same = 0
  while (Date.now() < deadline) {
    await sleep(100)
    const next = await evaluate(expression)
    if (JSON.stringify(next) === JSON.stringify(last)) same++
    else same = 0
    last = next
    if (same >= samples) return last
  }
  return last
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
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
async function navigate(url, readyExpression) {
  await send('Page.navigate', { url })
  await waitFor(`document.readyState === 'complete'`)
  await waitFor(readyExpression)
}
async function releaseHeld() {
  const ids = held.splice(0)
  for (const requestId of ids) await send('Fetch.continueRequest', { requestId })
}
async function failHeld() {
  const ids = held.splice(0)
  for (const requestId of ids) await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' })
}
async function click(selector) {
  const clicked = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.scrollIntoView({ block: 'center', inline: 'center' })
    el.click()
    return true
  })()`)
  if (!clicked) throw new Error(`click target missing: ${selector}`)
}
async function pointerClick(selector) {
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!point) throw new Error(`pointer target missing: ${selector}`)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
}
async function clickButtonText(text) {
  const clicked = await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    if (el.getAttribute('role') === 'tab') el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    el.click()
    return true
  })()`)
  if (!clicked) throw new Error(`button text missing: ${text}`)
}

const measureExpr = `(() => {
  const section = document.querySelector('section[aria-labelledby="log-list-heading"]')
  const management = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('日志配置'))
  return {
    resultsTop: section ? Math.round(section.getBoundingClientRect().top + window.scrollY) : null,
    managementTop: management ? Math.round(management.getBoundingClientRect().top + window.scrollY) : null,
    pageScrollWidth: document.documentElement.scrollWidth,
    pageClientWidth: document.documentElement.clientWidth,
    windowScrollY: window.scrollY
  }
})()`
const desktopSkeletonExpr = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="log-row-skeleton"]')]
  const first = nodes[0]
  return { count: nodes.length, firstHeight: first ? Math.round(first.getBoundingClientRect().height) : 0, cells: first ? first.querySelectorAll('td').length : 0 }
})()`
const mobileSkeletonExpr = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="log-card-skeleton"]')]
  const first = nodes[0]
  return { count: nodes.length, firstHeight: first ? Math.round(first.getBoundingClientRect().height) : 0, rows: first ? first.querySelectorAll('[data-skeleton-row]').length : 0 }
})()`
const desktopLoadedExpr = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="log-table-scroll"] .data-table tbody tr')]
  const first = nodes[0]
  return { count: nodes.length, firstHeight: first ? Math.round(first.getBoundingClientRect().height) : 0 }
})()`
const mobileLoadedExpr = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="log-card-list"] li')]
  const first = nodes[0]
  return { count: nodes.length, firstHeight: first ? Math.round(first.getBoundingClientRect().height) : 0 }
})()`

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/logs*', requestStage: 'Request' }] })

const checks = []
async function check(name, fn) {
  try {
    const detail = await fn()
    checks.push({ name, result: 'PASS', detail: detail ?? null })
  } catch (error) {
    checks.push({ name, result: 'FAIL', error: error.message })
  }
}

// ---------- 1) 1280 skeleton gate, normal short rows ----------
await check('1280 request gate: 25-row skeleton aligns with loaded normal rows', async () => {
  await setViewport(1280, 800)
  gateMode = 'hold'
  await navigate(filterUrl({ operation: 'task.progress' }), `document.querySelectorAll('[data-testid="log-row-skeleton"]').length === 25`)
  const skeleton = await evaluate(desktopSkeletonExpr)
  const before = await waitStable(measureExpr)
  await evaluate(`document.querySelector('section[aria-labelledby="log-list-heading"]').scrollIntoView({ block: 'start' })`)
  const skeletonShot = await shot('browser-desktop-skeleton-1280x800.png')
  await releaseHeld()
  gateMode = 'continue'
  await waitFor(
    `document.querySelectorAll('[data-testid="log-row-skeleton"]').length === 0 && document.querySelectorAll('[data-log-detail]').length > 0`
  )
  const loaded = await evaluate(desktopLoadedExpr)
  const after = await waitStable(measureExpr)
  await evaluate(`document.querySelector('[data-testid="log-table-scroll"] .data-table tbody tr')?.scrollIntoView({ block: 'start' })`)
  const loadedShot = await shot('browser-desktop-loaded-1280x800.png')
  const managementDelta = Math.abs(after.managementTop - before.managementTop)
  const resultsDelta = Math.abs(after.resultsTop - before.resultsTop)
  assert.equal(skeleton.count, 25)
  assert.equal(skeleton.cells, 10)
  assert.equal(loaded.count, 25)
  assert.ok(managementDelta <= 4, `management moved ${managementDelta}px`)
  assert.ok(resultsDelta <= 4, `results moved ${resultsDelta}px`)
  assert.ok(Math.abs(loaded.firstHeight - skeleton.firstHeight) <= 12, `row height ${skeleton.firstHeight} -> ${loaded.firstHeight}`)
  return { skeleton, loaded, before, after, managementDelta, resultsDelta, skeletonShot, loadedShot }
})

// ---------- 2) 390 skeleton gate, normal short rows ----------
await check('390 request gate: 6-row summary skeleton aligns with loaded normal rows', async () => {
  await setViewport(390, 844)
  gateMode = 'hold'
  await navigate(filterUrl({ operation: 'task.progress' }), `document.querySelectorAll('[data-testid="log-card-skeleton"]').length === 25`)
  const skeleton = await evaluate(mobileSkeletonExpr)
  const before = await waitStable(measureExpr)
  await evaluate(`document.querySelector('[data-testid="log-card-list"]')?.scrollIntoView({ block: 'start' })`)
  const skeletonShot = await shot('browser-mobile-skeleton-390x844.png')
  await releaseHeld()
  gateMode = 'continue'
  await waitFor(
    `document.querySelectorAll('[data-testid="log-card-skeleton"]').length === 0 && document.querySelectorAll('[data-log-detail]').length > 0`
  )
  const loaded = await evaluate(mobileLoadedExpr)
  const after = await waitStable(measureExpr)
  await evaluate(`document.querySelector('[data-testid="log-card-list"] li')?.scrollIntoView({ block: 'start' })`)
  const loadedShot = await shot('browser-mobile-loaded-390x844.png')
  const managementDelta = Math.abs(after.managementTop - before.managementTop)
  const perItemDelta = managementDelta / 25
  assert.equal(skeleton.count, 25)
  assert.equal(skeleton.rows, 6)
  assert.equal(loaded.count, 25)
  assert.ok(skeleton.firstHeight >= 150, `skeleton card too short: ${skeleton.firstHeight}`)
  assert.ok(loaded.firstHeight >= 150, `loaded card too short: ${loaded.firstHeight}`)
  const ratio = loaded.firstHeight / skeleton.firstHeight
  assert.ok(ratio >= 0.75 && ratio <= 1.35, `card height ratio ${ratio.toFixed(2)}: ${skeleton.firstHeight} -> ${loaded.firstHeight}`)
  assert.ok(perItemDelta <= 20, `per-item height shift ${perItemDelta.toFixed(1)}px`)
  assert.equal(after.pageScrollWidth, after.pageClientWidth)
  return { skeleton, loaded, before, after, managementDelta, perItemDelta, ratio, skeletonShot, loadedShot }
})

// ---------- 3) 1280 first screen + long values + detail close ----------
await check('1280 first screen and long values keep independent bounded cells; detail closes to the trigger', async () => {
  await setViewport(1280, 800)
  gateMode = 'hold'
  await navigate(syntheticUrl.href, `document.querySelectorAll('[data-testid="log-row-skeleton"]').length === 25`)
  const firstBefore = await waitStable(measureExpr)
  await releaseHeld()
  gateMode = 'continue'
  await waitFor(`document.querySelectorAll('[data-log-detail]').length > 0`)
  const firstAfter = await waitStable(measureExpr)
  await evaluate(`document.querySelector('section[aria-labelledby="log-list-heading"]').scrollIntoView({ block: 'start' })`)
  const firstShot = await shot('browser-desktop-first-1280x800.png')
  assert.ok(Math.abs(firstAfter.managementTop - firstBefore.managementTop) <= 4)
  // Long row: filter by the exact 96-char operation.
  await navigate(
    filterUrl({ operation: manifest.longOperation }),
    `document.querySelectorAll('[data-log-detail]').length > 0`
  )
  const long = await evaluate(`(() => {
    const scroller = document.querySelector('[data-testid="log-table-scroll"]')
    const headers = [...scroller.querySelectorAll('.data-table thead th')].map((th) => th.textContent.trim())
    const row = scroller.querySelector('.data-table tbody tr')
    const cells = [...row.querySelectorAll('td')]
    return {
      headers,
      count: cells.length,
      operation: cells[3].textContent.trim(),
      operationTitle: cells[3].querySelector('span[title]')?.getAttribute('title') ?? null,
      target: cells[4].textContent.trim(),
      targetTitle: cells[4].querySelector('span[title]')?.getAttribute('title') ?? null,
      result: cells[5].textContent.trim(),
      errorCode: cells[6].textContent.trim(),
      errorTitle: cells[6].querySelector('span[title]')?.getAttribute('title') ?? null,
      duration: cells[7].textContent.trim(),
      status: cells[8].textContent.trim(),
      scroller: { width: scroller.clientWidth, scrollWidth: scroller.scrollWidth },
      adjacency: cells.slice(0, -1).map((cell, i) => ({
        pair: headers[i] + '|' + headers[i + 1],
        overlap: cell.getBoundingClientRect().right > cells[i + 1].getBoundingClientRect().left + 0.5
      })),
      rowHeight: Math.round(row.getBoundingClientRect().height),
      page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }
    }
  })()`)
  const longShot = await shot('browser-desktop-long-1280x800.png')
  assert.equal(long.count, 10)
  assert.ok(!long.headers.includes('关联标识'))
  assert.equal(long.scroller.scrollWidth, long.scroller.width, '1280 table needs no horizontal scroll')
  assert.equal(long.operation, manifest.longOperation)
  assert.equal(long.operationTitle, manifest.longOperation)
  assert.equal(long.target, 'POST ' + manifest.longRoute)
  assert.equal(long.targetTitle, 'POST ' + manifest.longRoute)
  assert.equal(long.result, '失败')
  assert.equal(long.errorCode, manifest.longErrorCode)
  assert.equal(long.errorTitle, manifest.longErrorCode)
  assert.equal(long.duration, `${Number.MAX_SAFE_INTEGER} ms`)
  assert.equal(long.status, '500')
  assert.equal(long.adjacency.filter((entry) => entry.overlap).length, 0)
  assert.equal(long.page.scrollWidth, long.page.clientWidth)
  const sheetExpr = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes('运行日志详情'))`
  await pointerClick('[data-log-detail]')
  await waitFor(`!!(${sheetExpr})`)
  await waitFor(`(() => { const el = ${sheetExpr}; return el && el.querySelectorAll('h3').length === 4 })()`)
  await waitFor(`(() => { const el = ${sheetExpr}; return el && el.textContent.includes(${JSON.stringify(manifest.longErrorCode)}) })()`)
  const dialog = await evaluate(`(() => {
    const el = ${sheetExpr}
    return {
      groups: [...el.querySelectorAll('h3')].map((h) => h.textContent.trim()),
      hasError: el.textContent.includes('安全失败码') && el.textContent.includes(${JSON.stringify(manifest.longErrorCode)})
    }
  })()`)
  const detailShot = await shot('browser-desktop-detail-1280x800.png')
  const closed = await evaluate(`(() => {
    const el = ${sheetExpr}
    const button = el?.querySelector(':scope > button')
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.ok(closed)
  await waitFor(`!(${sheetExpr})`)
  const focus = await evaluate(`document.activeElement?.dataset?.logDetail ?? null`)
  assert.deepEqual(dialog.groups, ['基本信息', '目标与对象', '结果与计数', '关联标识'])
  assert.ok(dialog.hasError)
  assert.ok(focus)
  return { firstBefore, firstAfter, firstShot, long, longShot, detailShot, dialog, focus }
})

// ---------- 4) 390 first screen + long values ----------
await check('390 first screen and long values wrap inside the card without horizontal scroll', async () => {
  await setViewport(390, 844)
  gateMode = 'hold'
  await navigate(syntheticUrl.href, `document.querySelectorAll('[data-testid="log-card-skeleton"]').length === 25`)
  const before = await waitStable(measureExpr)
  await releaseHeld()
  gateMode = 'continue'
  await waitFor(`document.querySelectorAll('[data-log-detail]').length > 0`)
  const after = await waitStable(measureExpr)
  await evaluate(`document.querySelector('[data-testid="log-card-list"]')?.scrollIntoView({ block: 'start' })`)
  const firstShot = await shot('browser-mobile-first-390x844.png')
  await navigate(filterUrl({ operation: manifest.longOperation }), `document.querySelectorAll('[data-log-detail]').length > 0`)
  const long = await evaluate(`(() => {
    const list = document.querySelector('[data-testid="log-card-list"]')
    const item = list.querySelector('li')
    const errorRow = item.querySelector('[data-log-field="errorCode"]')
    return {
      text: item.textContent.replace(/\\s+/g, ' ').trim(),
      itemWidth: Math.round(item.getBoundingClientRect().width),
      itemHeight: Math.round(item.getBoundingClientRect().height),
      errorText: errorRow?.textContent.trim() ?? null,
      buttonHeight: Math.round(item.querySelector('[data-log-detail]').getBoundingClientRect().height),
      page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      overflow: [...list.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect()
        const lr = list.getBoundingClientRect()
        return r.width > 0 && (r.right > lr.right + 0.5 || r.left < lr.left - 0.5)
      }).length
    }
  })()`)
  await evaluate(`document.querySelector('[data-testid="log-card-list"] li')?.scrollIntoView({ block: 'start' })`)
  const longShot = await shot('browser-mobile-long-390x844.png')
  assert.ok(long.text.includes(manifest.longOperation))
  assert.ok(long.text.includes(manifest.longRoute))
  assert.ok(long.text.includes('失败码'))
  assert.ok(long.errorText.includes(manifest.longErrorCode))
  assert.equal(long.buttonHeight, 44)
  assert.equal(long.page.scrollWidth, long.page.clientWidth)
  assert.equal(long.overflow, 0)
  const sheetExpr = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes('运行日志详情'))`
  await click('[data-log-detail]')
  await waitFor(`!!(${sheetExpr})`)
  await waitFor(`(() => { const el = ${sheetExpr}; return el && el.querySelectorAll('h3').length === 4 })()`)
  const dialogGroups = await evaluate(`(() => [...${sheetExpr}.querySelectorAll('h3')].map((h) => h.textContent.trim()))()`)
  const closed = await evaluate(`(() => {
    const el = ${sheetExpr}
    const button = el?.querySelector(':scope > button')
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.ok(closed)
  await waitFor(`!(${sheetExpr})`)
  const focus = await evaluate(`document.activeElement?.dataset?.logDetail ?? null`)
  assert.deepEqual(dialogGroups, ['基本信息', '目标与对象', '结果与计数', '关联标识'])
  assert.ok(focus)
  return { before, after, firstShot, long, longShot, dialogGroups, focus }
})

// ---------- 4b) source-specific MCP/TUS detail at both widths ----------
await check('MCP and TUS details keep source-specific sections and fit at 1280 and 390', async () => {
  const results = []
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await setViewport(width, height)
    const slug = width === 1280 ? '1280x800' : '390x844'
    const sheetExpr = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes('运行日志详情'))`

    await navigate(filterUrl({ operation: 'mcp.request' }), `document.querySelectorAll('[data-log-detail]').length > 0`)
    await click('[data-log-detail]')
    await waitFor(`(() => { const el = ${sheetExpr}; return el && el.textContent.includes('客户端类别（自报）') })()`)
    await waitFor(`(() => { const el = ${sheetExpr}; if (!el) return false; const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 })()`)
    const mcp = await evaluate(`(() => {
      const el = ${sheetExpr}
      const rect = el.getBoundingClientRect()
      return {
        groups: [...el.querySelectorAll('h3')].map((h) => h.textContent.trim()),
        text: el.textContent,
        sheet: { left: rect.left, right: rect.right, width: rect.width },
        page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }
      }
    })()`)
    const mcpShot = await shot(`browser-${width === 1280 ? 'desktop' : 'mobile'}-mcp-detail-${slug}.png`)
    assert.deepEqual(mcp.groups, ['基本信息', '采集信息', '目标与对象', '结果与计数', 'MCP 调用', '关联标识'])
    assert.ok(mcp.text.includes('Cursor（cursor，自报）'))
    assert.ok(mcp.text.includes('2025-06-18（客户端声明）'))
    assert.ok(mcp.text.includes('MCP Toolkit 模块上下文（mcp-toolkit）'))
    assert.ok(mcp.text.includes('框架采集（framework）'))
    assert.ok(mcp.text.includes('请求处理（request）'))
    assert.ok(mcp.text.includes('不是鉴权身份'))
    assert.ok(!mcp.text.includes('文件编号'))
    assert.ok(!mcp.text.includes('页码'))
    assert.equal(mcp.page.scrollWidth, mcp.page.clientWidth)
    assert.ok(mcp.sheet.width <= width)
    await evaluate(`(() => { const el = ${sheetExpr}; el?.querySelector(':scope > button')?.click() })()`)
    await waitFor(`!(${sheetExpr})`)

    await navigate(filterUrl({ operation: 'file.upload' }), `document.querySelectorAll('[data-log-detail]').length > 0`)
    await click('[data-log-detail]')
    await waitFor(`(() => { const el = ${sheetExpr}; return el && el.textContent.includes('上传（TUS）') })()`)
    await waitFor(`(() => { const el = ${sheetExpr}; if (!el) return false; const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 })()`)
    const tus = await evaluate(`(() => {
      const el = ${sheetExpr}
      const rect = el.getBoundingClientRect()
      return {
        groups: [...el.querySelectorAll('h3')].map((h) => h.textContent.trim()),
        text: el.textContent,
        sheet: { left: rect.left, right: rect.right, width: rect.width },
        page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }
      }
    })()`)
    const tusShot = await shot(`browser-${width === 1280 ? 'desktop' : 'mobile'}-tus-detail-${slug}.png`)
    assert.deepEqual(tus.groups, ['基本信息', '采集信息', '目标与对象', '结果与计数', '上传（TUS）'])
    assert.ok(tus.text.includes('0123456789abcdef0123456789abcdef'))
    assert.ok(tus.text.includes('已完成（completed）'))
    assert.ok(tus.text.includes('声明总量（字节）'))
    assert.ok(tus.text.includes('tus 服务端回调（tus）'))
    assert.ok(tus.text.includes('生命周期钩子（hook）'))
    assert.ok(tus.text.includes('请求处理（request）'))
    assert.ok(!tus.text.includes('文件编号'))
    assert.ok(!tus.text.includes('页码'))
    assert.equal(tus.page.scrollWidth, tus.page.clientWidth)
    assert.ok(tus.sheet.width <= width)
    await evaluate(`(() => {
      const el = ${sheetExpr}
      el?.querySelector(':scope > button')?.click()
    })()`)
    await waitFor(`!(${sheetExpr})`)

    // 应用手动埋点没有确知 execution；详情只显示 present 字段，不补默认 request。
    await navigate(
      filterUrl({ operation: 'mcp.tool.get_platform_capabilities' }),
      `document.querySelectorAll('[data-log-detail]').length > 0`
    )
    await click('[data-log-detail]')
    await waitFor(`(() => { const el = ${sheetExpr}; return el && el.textContent.includes('应用手动埋点') })()`)
    const appOrigin = await evaluate(`(() => {
      const el = ${sheetExpr}
      return {
        text: el.textContent,
        groups: [...el.querySelectorAll('h3')].map((h) => h.textContent.trim()),
        page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }
      }
    })()`)
    assert.ok(appOrigin.groups.includes('采集信息'))
    assert.ok(appOrigin.text.includes('应用手动埋点（application）'))
    assert.ok(appOrigin.text.includes('手动埋点（manual）'))
    assert.ok(!appOrigin.text.includes('执行位置'))
    assert.equal(appOrigin.page.scrollWidth, appOrigin.page.clientWidth)
    await evaluate(`(() => {
      const el = ${sheetExpr}
      el?.querySelector(':scope > button')?.click()
    })()`)
    await waitFor(`!(${sheetExpr})`)
    const focus = await evaluate(`document.activeElement?.dataset?.logDetail ?? null`)
    assert.ok(focus)
    results.push({ width, mcp, tus, appOrigin, mcpShot, tusShot, focus })
  }
  return results
})

// ---------- 5) real normal HTTP event ----------
await check('real 200 /api/health event renders method, route, status and neutral failure code', async () => {
  await setViewport(1280, 800)
  const event = manifest.realNormalEvent
  await navigate(`${base}/logs?requestId=${encodeURIComponent(event.requestId)}`, `document.querySelectorAll('[data-log-detail]').length > 0`)
  const row = await evaluate(`(() => {
    const cells = [...document.querySelector('[data-testid="log-table-scroll"] .data-table tbody tr').querySelectorAll('td')]
    return { cells: cells.length, source: cells[2].textContent.trim(), target: cells[4].textContent.trim(), result: cells[5].textContent.trim(), errorCode: cells[6].textContent.trim(), status: cells[8].textContent.trim() }
  })()`)
  const path = await shot('browser-desktop-real-normal-http-1280x800.png')
  assert.equal(row.cells, 10)
  assert.ok(row.source.includes('HTTP 接口'))
  assert.equal(row.target, 'GET /api/health')
  assert.equal(row.result, '成功')
  assert.equal(row.errorCode, '不适用')
  assert.equal(row.status, '200')
  return { event, row, path }
})

// ---------- 6) pagination focus ----------
await check('cursor pagination returns to the first row and focuses the list heading', async () => {
  await setViewport(1280, 800)
  await navigate(filterUrl({ operation: 'task.progress' }), `document.querySelectorAll('[data-log-detail]').length > 0`)
  const firstPageText = await evaluate(`document.querySelector('[data-testid="log-table-scroll"] .data-table tbody tr').textContent`)
  const nextDisabled = await evaluate(`document.querySelector('[data-table-next]').disabled`)
  assert.equal(nextDisabled, false)
  await evaluate(`(() => { const s = document.querySelector('[data-testid="log-table-scroll"]'); s.scrollTop = 120; return s.scrollTop })()`)
  await pointerClick('[data-table-next]')
  await waitFor(`document.querySelector('[data-testid="table-pagination"]').textContent.includes('第 2 页')`)
  await waitFor(`document.activeElement?.id === 'log-list-heading'`)
  const after = await evaluate(`(() => ({
    scrollTop: document.querySelector('[data-testid="log-table-scroll"]').scrollTop,
    activeId: document.activeElement?.id ?? null,
    firstText: document.querySelector('[data-testid="log-table-scroll"] .data-table tbody tr').textContent,
    pagination: document.querySelector('[data-testid="table-pagination"]').textContent.replace(/\\s+/g, ' ').trim()
  }))()`)
  const path = await shot('browser-desktop-page-2-1280x800.png')
  assert.equal(after.scrollTop, 0)
  assert.equal(after.activeId, 'log-list-heading')
  assert.notEqual(after.firstText, firstPageText)
  assert.ok(after.pagination.includes('第 2 页'))
  await evaluate(`document.querySelector('[aria-label="第 1 页"]').click()`)
  await waitFor(`document.querySelector('[aria-label="第 1 页"]')?.getAttribute('aria-current') === 'page'`)
  return { firstPageText, after, path }
})

// ---------- 7) failed navigation retains old rows ----------
await check('failed filter navigation retains old rows and offers an explicit retry', async () => {
  await setViewport(1280, 800)
  await navigate(syntheticUrl.href, `document.querySelectorAll('[data-log-detail]').length > 0`)
  const oldRow = await evaluate(`document.querySelector('[data-testid="log-table-scroll"] .data-table tbody tr').textContent`)
  const before = await waitStable(measureExpr)
  gateMode = 'hold'
  await evaluate(`(() => {
    const input = document.querySelector('#log-operation')
    input.value = 'task.finished'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await clickButtonText('应用筛选')
  await waitFor(`[...document.querySelectorAll('[role="status"]')].some((el) => el.textContent.includes('正在读取当前筛选'))`)
  const retained = await evaluate(`document.querySelector('[data-testid="log-table-scroll"] .data-table tbody tr').textContent`)
  assert.ok(retained.length > 0)
  await failHeld()
  gateMode = 'continue'
  await waitFor(`!!document.querySelector('[data-testid="table-failure-state"]')`)
  await waitStable(measureExpr)
  const failed = await evaluate(`(() => ({
    failure: document.querySelector('[data-testid="table-failure-state"]').textContent.replace(/\\s+/g, ' ').trim(),
    firstRow: document.querySelector('[data-testid="log-table-scroll"] .data-table tbody tr')?.textContent ?? '',
    after: (() => {
      const section = document.querySelector('section[aria-labelledby="log-list-heading"]')
      const management = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('日志配置'))
      return {
        resultsTop: section ? Math.round(section.getBoundingClientRect().top + window.scrollY) : null,
        managementTop: management ? Math.round(management.getBoundingClientRect().top + window.scrollY) : null
      }
    })()
  }))()`)
  const failureShot = await shot('browser-desktop-retained-failure-1280x800.png')
  assert.ok(failed.failure.includes('task.finished'))
  assert.ok(failed.firstRow.length > 0)
  assert.ok(Math.abs(failed.after.managementTop - before.managementTop) <= 4)
  await click('[data-testid=table-retry]')
  await waitFor(`!document.querySelector('[data-testid="table-failure-state"]')`)
  await waitFor(`document.querySelector('[data-testid="log-table-scroll"] .data-table tbody tr')?.textContent.includes('task.finished')`)
  const recovered = await evaluate(`document.querySelector('[data-testid="log-table-scroll"] .data-table tbody tr').textContent`)
  return { oldRow, retained, failed, failureShot, recovered }
})

// ---------- 8) clear/policy cancel writes nothing ----------
await check('clear and policy review cancel without any write request', async () => {
  await setViewport(1280, 800)
  await navigate(syntheticUrl.href, `document.querySelectorAll('[data-log-detail]').length > 0`)
  const writesBefore = network.filter((entry) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(entry.method)).length
  await clickButtonText('日志配置')
  await waitFor(`!!document.querySelector('#log-retention-days')`)
  await clickButtonText('清理当前筛选范围')
  await waitFor(`[...document.querySelectorAll('[role="dialog"]')].some((el) => el.textContent.includes('确认清理运行日志'))`)
  await clickButtonText('取消')
  await waitFor(`!document.querySelector('[role="dialog"]')`)
  const clearWrites = network.filter((entry) => entry.method === 'POST' && new URL(entry.url).pathname === '/api/logs/clear')
  assert.equal(clearWrites.length, 0)
  // Policy: change a value, open the review, then cancel.
  await evaluate(`(() => {
    const input = document.querySelector('#log-retention-days')
    input.value = '6'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('核对日志配置修改') && !b.disabled)`)
  await clickButtonText('核对日志配置修改')
  await waitFor(`[...document.querySelectorAll('[role="dialog"]')].some((el) => el.textContent.includes('核对日志配置修改'))`)
  const policyShot = await shot('browser-desktop-policy-review-1280x800.png')
  await clickButtonText('取消')
  await waitFor(`!document.querySelector('[role="dialog"]')`)
  const policyWrites = network.filter((entry) => entry.method === 'PATCH' && new URL(entry.url).pathname === '/api/logs/policy')
  assert.equal(policyWrites.length, 0)
  const writesAfter = network.filter((entry) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(entry.method)).length
  return { writesBefore, writesAfter, clearWrites: clearWrites.length, policyWrites: policyWrites.length, policyShot }
})

// ---------- 9) dual-axis collection settings ----------
await check('dual-axis settings review and save only changed rules; unwired stays non-configurable', async () => {
  await setViewport(1280, 800)
  await navigate(syntheticUrl.href, `document.querySelectorAll('[data-log-detail]').length > 0`)
  await clickButtonText('日志配置')
  await waitFor(`!!document.querySelector('[data-testid="log-collection-sources"]')`)
  await waitFor(`!!document.querySelector('[data-testid="log-collection-integrations"]')`)
  const layout = await evaluate(`(() => ({
    switches: document.querySelectorAll('[data-slot="switch"]').length,
    checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
    sources: document.querySelectorAll('[data-testid="log-collection-sources"] [data-slot="switch"]').length,
    integrations: document.querySelectorAll('[data-testid="log-collection-integrations"] [data-slot="switch"]').length,
    page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
    unwired: document.querySelector('[data-testid="log-unwired-integrations"]')?.textContent ?? ''
  }))()`)
  assert.equal(layout.switches, 17)
  assert.equal(layout.checkboxes, 0)
  assert.equal(layout.sources, 11)
  assert.equal(layout.integrations, 6)
  assert.equal(layout.page.scrollWidth, layout.page.clientWidth)
  assert.ok(layout.unwired.includes('未接入的技术集成（5）'))

  // 未接入项折叠，展开后仍没有伪开关。
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('未接入的技术集成'))
    el?.scrollIntoView({ block: 'center' })
    el?.click()
    return !!el
  })()`)
  await waitFor(`document.body.textContent.includes('Drizzle 数据库')`)
  const unwired = await evaluate(`(() => ({
    text: document.body.textContent,
    fakeSwitch: !!document.querySelector('#log-integration-drizzle-enabled')
  }))()`)
  assert.ok(unwired.text.includes('未接入，不可配置'))
  assert.equal(unwired.fakeSwitch, false)

  // 改一条来源开关和一条最低级别，均通过共享 Reka 控件。
  await click('#log-source-http-enabled')
  await waitFor(`document.querySelector('#log-source-http-enabled')?.dataset.state === 'unchecked'`)
  await click('[aria-label="MCP 调用的最低日志级别"]')
  await waitFor(`!![...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes('警告'))`)
  await sleep(150)
  const levelPoint = await evaluate(`(() => {
    const el = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes('警告'))
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: levelPoint.x, y: levelPoint.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: levelPoint.x, y: levelPoint.y, button: 'left', clickCount: 1 })
  await waitFor(`[...document.querySelectorAll('[aria-label="MCP 调用的最低日志级别"]')].some((el) => el.textContent.includes('警告'))`)

  const writesBefore = network.filter((entry) => entry.method === 'PATCH').length
  await clickButtonText('核对日志配置修改')
  await waitFor(`[...document.querySelectorAll('[role="dialog"]')].some((el) => el.textContent.includes('核对日志配置修改'))`)
  const reviewText = await evaluate(`[...document.querySelectorAll('[role="dialog"]')].find((el) => el.textContent.includes('核对日志配置修改'))?.textContent ?? ''`)
  assert.ok(reviewText.includes('来源采集 · HTTP 接口'))
  assert.ok(reviewText.includes('来源采集 · MCP 调用'))
  assert.ok(!reviewText.includes('后台任务'))
  assert.equal(network.filter((entry) => entry.method === 'PATCH').length, writesBefore)
  await evaluate('window.scrollTo(0, 0)')
  const settingsShot = await shot('browser-desktop-log-config-1280x800.png')
  const reviewShot = await shot('browser-desktop-log-config-review-1280x800.png')
  await clickButtonText('取消')
  await waitFor(`!document.querySelector('[role="dialog"]')`)
  assert.equal(network.filter((entry) => entry.method === 'PATCH').length, writesBefore)

  // 重新核对并保存：payload 只含变化规则，不重置其他规则，也不回传 GET 的 catalog/revision。
  await clickButtonText('核对日志配置修改')
  await waitFor(`!!document.querySelector('[data-testid="log-policy-confirm"]')`)
  await click('[data-testid="log-policy-confirm"]')
  await waitFor(`!document.querySelector('[data-testid="log-policy-confirm"]')`)
  await waitFor(`document.body.textContent.includes('日志配置已保存')`)
  await waitFor(`document.querySelector('#log-source-http-enabled')?.dataset.state === 'unchecked'`)
  const patch = network.find((entry) => entry.method === 'PATCH' && new URL(entry.url).pathname === '/api/logs/policy')
  assert.ok(patch)
  assert.ok(patch.postData)
  const body = JSON.parse(patch.postData)
  assert.deepEqual(body, {
    retentionDays: 7,
    maxBytes: 536870912,
    collection: {
      sources: {
        http: { enabled: false, minLevel: 'debug' },
        mcp: { enabled: true, minLevel: 'warn' }
      }
    }
  })
  assert.ok(!('integrations' in body.collection))
  return { layout, unwired, reviewText, body, settingsShot, reviewShot }
})

// ---------- 10) settings at 390 ----------
await check('390 settings stay full width with no horizontal scroll', async () => {
  await setViewport(390, 844)
  await navigate(`${base}/logs?tab=settings`, `!!document.querySelector('[data-testid="log-collection-sources"]')`)
  const mobile = await evaluate(`(() => ({
    page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
    switchCount: document.querySelectorAll('[data-slot="switch"]').length,
    settingsWidth: Math.round(document.querySelector('[data-testid="log-collection-sources"]')?.getBoundingClientRect().width ?? 0)
  }))()`)
  const shotPath = await shot('browser-mobile-log-config-390x844.png')
  assert.equal(mobile.page.scrollWidth, mobile.page.clientWidth)
  assert.equal(mobile.switchCount, 17)
  assert.ok(mobile.settingsWidth > 300)
  return { ...mobile, shotPath }
})

const failedChecks = checks.filter((entry) => entry.result === 'FAIL')
const summary = {
  kind: 'browser',
  synthetic: true,
  fixture: { base, pagePath: manifest.pagePath, events: manifest.fixtureEvents, source: manifest.source, realEvent: manifest.realEvent, realNormalEvent: manifest.realNormalEvent, longErrorCode: manifest.longErrorCode },
  chrome: { path: chromePath, userAgent: await evaluate('navigator.userAgent') },
  checks,
  passed: checks.length - failedChecks.length,
  failed: failedChecks.length
}
writeFileSync(resultsPath, JSON.stringify(summary, null, 2))
writeFileSync(fixtureLogPath, fixtureLog)
console.log(JSON.stringify({ outDir, resultsPath, passed: summary.passed, failed: summary.failed, checks: checks.map((entry) => ({ name: entry.name, result: entry.result, error: entry.error })) }, null, 2))

ws.close()
stopChrome()
stopFixture()
if (failedChecks.length) process.exitCode = 1
