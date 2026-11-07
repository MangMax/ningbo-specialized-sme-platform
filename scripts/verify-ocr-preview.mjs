#!/usr/bin/env node
/** Functional acceptance only: fresh synthetic DB/files, private Chrome profile, no visual CI.
 * pnpm build && node scripts/verify-ocr-preview.mjs
 * node scripts/verify-ocr-preview.mjs --serve  (manual T3/oil-ui inspection; Ctrl-C stops)
 * Chrome CDP follows the repository's isolated-browser verification workflow and allows
 * actual prefers-reduced-motion emulation, which the T3 preview appearance tool lacks.
 *
 * The workbench is now one screen per page: a file sheet, an on-demand filter sheet,
 * a single fixed bottom pager, and equal-height image/text panes. This script exercises
 * the real entries and keeps the data-integrity assertions from the earlier ticket.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { spawnOwnedChild, getOwnedChildStartFailure, reserveLoopbackPort, stopOwnedChild, waitForChromeDevTools } from './lib/isolated-local-services.mjs'

let root, base, server, chrome, cdp, db, source, profile, sessionId
const log = []
let primaryError
const cleanupErrors = []
// Acquisition attempts are distinct from absent handles. Only the helper's
// original error can authenticate a partially acquired child.
const owned = new Map()
function spawn(name, command, args, options) {
  const state = { attempted: true, confirmed: false, child: undefined, stopAttempted: false }
  owned.set(name, state)
  try { return state.child = spawnOwnedChild(command, args, options) }
  catch (error) {
    state.child = getOwnedChildStartFailure(error)?.child
    throw error
  }
}
function errorDetail(error) {
  if (!error) return undefined
  return { name: error.name, message: error.message, stack: error.stack, code: error.code,
    cause: error.cause && errorDetail(error.cause), errors: error.errors?.map(errorDetail),
    startResult: error.startResult, stopResult: error.stopResult }
}
// Keep handlers installed through finally: repeated serve signals must not
// restore the default termination action halfway through owned cleanup.
let serveResolve, serveSignalled = false
const serveSignal = () => { serveSignalled = true; serveResolve?.() }
if (process.argv.includes('--serve')) {
  process.on('SIGINT', serveSignal)
  process.on('SIGTERM', serveSignal)
}
// Explicit complete-body deadlines: readiness remains 60s with 2s attempts;
// files and PDF rendering each receive 60s including headers AND body.
async function httpText(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('HTTP complete-body deadline: ' + url)), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    return { status: response.status, body: await response.text() }
  } finally { clearTimeout(timer) }
}
async function ready() {
  const deadline = Date.now() + 60000
  let lastError
  while (Date.now() < deadline) {
    assert.equal(server.exitCode, null, 'server exited before readiness')
    assert.equal(server.signalCode, null, 'server signalled before readiness')
    try {
      const response = await httpText(`${base}/ocr`, {}, Math.min(2000, deadline - Date.now()))
      if (response.status >= 200 && response.status < 300) return
      lastError = new Error('HTTP ' + response.status)
    } catch (error) { lastError = error }
    await sleep(200)
  }
  throw new Error('HTTP readiness deadline', { cause: lastError })
}
function fileDigests(dir = join(root, 'files')) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? fileDigests(path) : [[path, createHash('sha256').update(readFileSync(path)).digest('hex')]]
  })
}
function snapshot() {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
function assertTargetHistory(before, after, source, edits, startedAt, endedAt) {
  const oldTarget = before.ocr_result.find(r => r.file_id === 1 && r.page_no === 1)
  const target = after.ocr_result.find(r => r.file_id === 1 && r.page_no === 1)
  assert.ok(oldTarget && target, 'target identity missing')
  assert.equal(oldTarget.raw, '{"original": "workbench-97.pdf", "page": 1}')
  assert.equal(oldTarget.revision, 1)
  assert.equal(oldTarget.markdown, source)
  const history = JSON.parse(target.raw)
  assert.deepEqual(Object.keys(history).sort(), ['captures', 'format', 'revisions'])
  assert.equal(history.format, 'ocr-provenance-v1')
  assert.deepEqual(history.captures, [{ raw: { original: 'workbench-97.pdf', page: 1 }, source: null, markdown: null }])
  assert.equal(history.revisions.length, edits.length + 1)
  assert.deepEqual(history.revisions[0], { markdown: source, channel: 'api', engine: 'paddleocr', model: '合成引擎', createdAt: '2026-10-17T00:00:00Z', capture: null })
  for (const [i, markdown] of edits.entries()) {
    const revision = history.revisions[i + 1]
    assert.match(revision.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.ok(Date.parse(revision.createdAt) >= startedAt && Date.parse(revision.createdAt) <= endedAt, 'revision time outside run')
    assert.deepEqual(revision, { markdown, channel: 'upload', engine: 'paddleocr', model: null, createdAt: revision.createdAt, capture: 0 })
  }
  assert.equal(target.markdown, edits.at(-1))
  assert.equal(target.revision, 1 + edits.length)
  assert.equal(target.engine, 'paddleocr')
  assert.equal(target.model, null)
  assert.equal(target.channel, 'upload')
  assert.equal(target.created_at, history.revisions.at(-1).createdAt)
  assert.equal(target.page_rel_path, '.workbench-97.pdf.pages/p001.png')
  // Only these checked fields may differ. Identity, unknown columns, and every
  // other row/table remain in the full comparison; never replace a whole row.
  const normalized = structuredClone(after)
  const row = normalized.ocr_result.find(r => r.file_id === 1 && r.page_no === 1)
  for (const field of ['markdown', 'revision', 'raw', 'engine', 'model', 'channel', 'created_at', 'page_rel_path']) row[field] = oldTarget[field]
  assert.deepEqual(normalized, before)
}
class Cdp {
  seq = 0; pending = new Map(); onEvent = () => {}
  constructor(socket) {
    this.socket = socket
    socket.addEventListener('close', () => this.rejectPending(new Error('CDP socket closed')))
    socket.addEventListener('error', () => this.rejectPending(new Error('CDP socket error')))
    socket.addEventListener('message', event => {
      const m = JSON.parse(event.data)
      if (!m.id) { this.onEvent(m); return }
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id); clearTimeout(p.timer)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    })
  }
  rejectPending(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear()
  }
  close() {
    this.rejectPending(new Error('CDP disposed'))
    this.socket.close()
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
}
try {
  root = mkdtempSync(join(tmpdir(), 'ocr-preview-48-'))
  const fixture = spawnSync('uv', ['run', 'scripts/fixtures/ocr-preview.py', root], { encoding: 'utf8' })
  assert.equal(fixture.status, 0, fixture.stderr)
  const port = await reserveLoopbackPort()
  base = `http://127.0.0.1:${port}`
  server = spawn('server', process.execPath, ['.output/server/index.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: join(root, 'roster.db'),
      NUXT_DB_READONLY: '0', NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'),
      NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', b => log.push(String(b)))
  server.stderr.on('data', b => log.push(String(b)))
  console.log(JSON.stringify({ root, base, serverPid: server.pid }))
  let serverError
  server.on('error', error => { serverError = error })
  db = new Database(join(root, 'roster.db'))
  source = readFileSync(join(root, 'source.md'), 'utf8')
  console.log(JSON.stringify({ root, base, serverPid: server.pid, policy: 'retain synthetic root and logs; remove Chrome profile after group exit' }))
  // Do not probe an unrelated listener if another process won the released port.
  const listenerDeadline = Date.now() + 60000
  while (!log.join('').includes(`Listening on ${base}`)) {
    if (serverError) throw serverError
    assert.equal(server.exitCode, null, 'server exited before announcing listener')
    assert.equal(server.signalCode, null, 'server signalled before announcing listener')
    assert.ok(Date.now() < listenerDeadline, 'server did not announce owned listener')
    await sleep(50)
  }
  await ready()
  // Warm app migrations/reference seeds before measuring read-only interactions.
  const files = await httpText(`${base}/api/files`)
  assert.equal(files.status, 200, files.body)
  // Derived page images only. No OCR job or import is invoked.
  // 200 DPI is an existing API option (72–600) and gives the A4 fixture enough
  // pixels for a 2x display without changing the server contract.
  for (const file of ['workbench-97.pdf', 'second.pdf']) {
    const response = await httpText(`${base}/api/pdf-pages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, dpi: 200 }) })
    assert.equal(response.status, 200, response.body)
  }
  console.log(JSON.stringify({ base, root, manual: `${base}/ocr?file=workbench-97.pdf&page=1` }))
  if (process.argv.includes('--serve')) {
    await new Promise(resolve => { serveResolve = resolve; if (serveSignalled) resolve() })
  } else {
    const before = snapshot()
    const filesBefore = fileDigests()
    // Planned from the user actions below, not from requests or stored history.
    const expectedEdits = [source + '\n已校对', source + '\n缺失读回校对', '', source,
      ...Array.from({ length: 8 }, () => ['修订完成', source]).flat()]
    const startedAt = Date.now()
    let committed = 0
    const checkCommit = () => {
      committed++
      assertTargetHistory(before, snapshot(), source, expectedEdits.slice(0, committed), startedAt, Date.now())
      console.log(JSON.stringify({ targetCommit: committed, revision: committed + 1 }))
    }
    const chromePath = process.env.CHROME_BIN ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
    assert.ok(chromePath, 'Set CHROME_BIN')
    profile = mkdtempSync(join(tmpdir(), 'ocr-preview-chrome-'))
    chrome = spawn('chrome', chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
    console.log(JSON.stringify({ chromePid: chrome.pid, profile }))
    const version = await waitForChromeDevTools(chrome, profile)
    cdp = new Cdp(new WebSocket(version.webSocketDebuggerUrl))
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        cdp.socket.removeEventListener('open', onOpen)
        cdp.socket.removeEventListener('error', onError)
        cdp.socket.removeEventListener('close', onError)
        error ? reject(error) : resolve()
      }
      const onOpen = () => finish()
      const onError = () => finish(new Error('CDP connection failed'))
      const timer = setTimeout(() => finish(new Error('CDP connection timed out')), 10000)
      cdp.socket.addEventListener('open', onOpen, { once: true })
      cdp.socket.addEventListener('error', onError, { once: true })
      cdp.socket.addEventListener('close', onError, { once: true })
    })
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    sessionId = sid
    const ev = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid)
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const wait = async expression => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (await ev(expression)) return
        await sleep(60)
      }
      console.error('Timeout state', await ev(`JSON.stringify({viewport:{width:innerWidth,height:innerHeight},readRetry:{noTextarea:!document.querySelector('textarea'),savedText:document.body.innerText.includes('保存完成')},textareas:[...document.querySelectorAll('textarea')].map(e=>({html:e.outerHTML.slice(0,1000),visible:e.getClientRects().length>0,pane:e.closest('section')?.getAttribute('aria-label'),disabled:e.disabled,readOnly:e.readOnly})),active:document.activeElement?.outerHTML.slice(0,700),rows:[...document.querySelectorAll('ul[role="list"]>li')].map(e=>e.id),page:document.querySelector('[aria-label="当前文件与页号"]')?.innerText,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(d=>d.innerText.slice(0,500)),buttons:[...document.querySelectorAll('[role="dialog"] button')].map(b=>({text:b.textContent.trim(),aria:b.getAttribute('aria-label'),disabled:b.disabled})),alerts:[...document.querySelectorAll('[role="alert"],[role="status"]')].map(e=>e.textContent)})`))
      throw new Error(`Condition timed out: ${expression}`)
    }
    // Scope repeated navigation controls by their user-visible region, never by first match.
    const click = (label, scope = 'body') => ev(`(() => {
      const root = document.querySelector(${JSON.stringify(scope)})
      if (!root) throw new Error('Scope missing: ' + ${JSON.stringify(scope)})
      const matches = [...root.querySelectorAll('button,[role="menuitem"]')].filter(b =>
        b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (matches.length !== 1) throw new Error('Ambiguous/unavailable control: ' + ${JSON.stringify(label)} + ' (' + matches.length + ')')
      if (matches[0].disabled) throw new Error('Disabled control: ' + ${JSON.stringify(label)})
      matches[0].focus(); matches[0].click()
    })()`)
    const clickPrefix = (prefix, scope = 'body') => ev(`(() => {
      const root = document.querySelector(${JSON.stringify(scope)})
      if (!root) throw new Error('Scope missing')
      const matches = [...root.querySelectorAll('button')].filter(b => b.textContent.trim().startsWith(${JSON.stringify(prefix)}))
      if (matches.length !== 1) throw new Error('Ambiguous prefix: ' + ${JSON.stringify(prefix)} + ' (' + matches.length + ')')
      if (matches[0].disabled) throw new Error('Disabled control')
      matches[0].focus(); matches[0].click()
    })()`)
    const fill = async (selector, value) => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
      return ev(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Input missing'); Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    }
    const openFilters = async () => {
      await clickPrefix('筛选')
      await wait(`document.querySelector('[data-slot="sheet-content"] input[aria-label="当前文件正文关键词"]')`)
    }
    const applyFilters = async () => {
      await click('应用筛选', '[data-slot="sheet-content"]')
      await wait(`!document.querySelector('[data-slot="sheet-content"]')`)
    }
    const openFileSheet = async () => {
      await click('选择 PDF 文件')
      await wait(`!!document.querySelector('[data-slot="sheet-content"] li')`)
      const rowHeight = await ev(`Math.min(...[...document.querySelectorAll('[data-slot="sheet-content"] li button')].map(b => b.getBoundingClientRect().height))`)
      assert.ok(rowHeight >= 44, `file row height ${rowHeight} < 44`)
      // Every file row exposes the full name somewhere (title, plus wrapping on narrow).
      assert.equal(await ev(`[...document.querySelectorAll('[data-slot="sheet-content"] li button')].every(b => !!b.getAttribute('title'))`), true, 'file row missing full-name title')
      if (await ev('innerWidth < 640')) {
        assert.equal(await ev(`[...document.querySelectorAll('[data-slot="sheet-content"] li button > span > span:first-child')].every(n => getComputedStyle(n).whiteSpace !== 'nowrap')`), true, 'narrow file names still truncate to one line')
      }
      return rowHeight
    }
    const selectFile = async (label) => {
      await openFileSheet()
      await ev(`(() => {
        const matches = [...document.querySelectorAll('[data-slot="sheet-content"] li button')].filter(b => b.textContent.includes(${JSON.stringify(label)}))
        if (matches.length !== 1) throw new Error('File row missing: ' + ${JSON.stringify(label)})
        matches[0].focus(); matches[0].click()
      })()`)
      await wait(`!document.querySelector('[data-slot="sheet-content"]')`)
    }
    const openRowMenu = async () => {
      await click('本页更多操作')
      await wait(`!!document.querySelector('[role="menu"]')`)
    }
    const menu = async (label) => {
      await ev(`(() => {
        const matches = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].filter(m =>
          m.textContent.trim() === ${JSON.stringify(label)} || m.textContent.trim().startsWith(${JSON.stringify(label)}))
        if (matches.length !== 1) throw new Error('Ambiguous menu item: ' + ${JSON.stringify(label)} + ' (' + matches.length + ')')
        if (matches[0].getAttribute('data-disabled') !== null || matches[0].hasAttribute('disabled')) throw new Error('Disabled menu item')
        matches[0].focus(); matches[0].click()
      })()`)
      await wait(`!document.querySelector('[role="menu"]')`)
    }
    const navigate = async (file = 'workbench-97.pdf', page = 1) => {
      await cdp.send('Page.navigate', { url: `${base}/ocr?file=${file}&page=${page}` }, sid)
      await wait(`document.querySelector('[aria-label="当前文件与页号"]')?.textContent.includes('第 ${page} /') && document.querySelector('ul[role="list"] li')`)
    }
    const edit = async () => {
      await click('编辑', '[aria-label="翻页与页操作"]')
      await wait(`document.activeElement?.tagName==='TEXTAREA'`)
    }
    const save = async () => {
      await click('保存', '[aria-label="翻页与页操作"]')
    }
    const cancel = async () => {
      await click('取消', '[aria-label="翻页与页操作"]')
      // A dirty draft must ask before discarding; a clean edit exits immediately.
      if (await ev(`!!document.querySelector('[data-slot="dialog-content"]')`)) {
        await click('放弃草稿', '[data-slot="dialog-content"]')
      }
      await wait(`!document.querySelector('textarea') && !document.querySelector('[data-slot="dialog-content"]')`)
    }
    const key = async (name, code) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: name === 'Escape' ? 27 : 39 }, sid)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: name === 'Escape' ? 27 : 39 }, sid)
    }

    await cdp.send('Runtime.enable', {}, sid)
    await cdp.send('Page.enable', {}, sid)
    await cdp.send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
    const requests = [], failures = [], external = [], completed = new Set()
    const downloads = [], finishedDownloads = new Set()
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: join(root, 'downloads'), eventsEnabled: true })
    let failWrite = false, failRead = false, held = null, holdRead = false, missingMarkdown = false
    cdp.onEvent = m => {
      if (m.method === 'Network.requestWillBeSent' && /^https?:/.test(m.params.request.url) && !m.params.request.url.startsWith(base + '/')) external.push(m.params.request.url)
      if (m.method === 'Browser.downloadWillBegin') downloads.push(m.params)
      if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') finishedDownloads.add(m.params.guid)
      if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') completed.add(m.params.requestId)
      if (m.method !== 'Fetch.requestPaused') return
      const { requestId, request } = m.params
      const url = new URL(request.url)
      const api = url.pathname === '/api/ocr-results'
      if (api) requests.push({ method: request.method, url: request.url, body: request.postData })
      if (api && holdRead && request.method === 'GET' && url.searchParams.get('file') === 'workbench-97.pdf') { held = { requestId, networkId: m.params.networkId }; holdRead = false; return }
      if (api && missingMarkdown && request.method === 'GET') {
        missingMarkdown = false
        // A successful response whose per-page body is absent: the app must not
        // treat this as an empty result, and must not re-POST on retry.
        const body = JSON.stringify({
          file: { id: 1, relPath: 'workbench-97.pdf', filename: 'workbench-97.pdf', ext: 'pdf', parseState: 'unparsed' },
          channels: ['upload'],
          pages: [{ page: 1, engine: 'fixture', model: null, channel: 'upload', createdAt: '2026-10-15T00:00:00.000Z', pageRelPath: null, url: null }],
          count: 1,
        })
        cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(body).toString('base64'),
        }, sid).catch(e => failures.push({ error: String(e), url: request.url }))
        return
      }
      const fail = api && ((failWrite && request.method === 'POST') || (failRead && request.method === 'GET'))
      cdp.send(fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId, ...(fail ? { errorReason: 'Failed' } : {}) }, sid).catch(e => failures.push({ error: String(e), url: request.url, networkId: m.params.networkId }))
    }
    await cdp.send('Network.enable', {}, sid)
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${base}/api/ocr-results*`, requestStage: 'Request' }] }, sid)

    // The outgoing workbench must keep its source coordinate until it unmounts.
    // Observe the real transition rather than asserting an import spelling.
    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sid)
      await navigate()
      await click('下一页', '[aria-label="翻页与页操作"]')
      await wait(`new URLSearchParams(location.search).get('page') === '2' && document.querySelector('[aria-label="当前文件与页号"]').textContent.includes('第 2 /')`)
      await ev('history.back()')
      await wait(`new URLSearchParams(location.search).get('page') === '1' && document.querySelector('[aria-label="当前文件与页号"]').textContent.includes('第 1 /')`)
      await edit()
      await fill('textarea', source + '\nroute-history-draft')
      await ev('history.forward()')
      await wait(`document.body.innerText.includes('有未保存的草稿') && new URLSearchParams(location.search).get('page') === '1'`)
      assert.equal(await ev(`document.querySelector('textarea').value`), source + '\nroute-history-draft', 'history navigation overwrote OCR draft')
      await cancel()
      await ev('history.forward()')
      await wait(`new URLSearchParams(location.search).get('page') === '2' && document.querySelector('[aria-label="当前文件与页号"]').textContent.includes('第 2 /')`)
      await ev('history.back()')
      await wait(`new URLSearchParams(location.search).get('page') === '1' && document.querySelector('[aria-label="当前文件与页号"]').textContent.includes('第 1 /')`)
      if (width === 390) {
        await click('Toggle Sidebar')
        await wait(`!!document.querySelector('a[aria-label="专精特新企业称号台账，返回企业列表"]')`)
      }
      await ev(`(() => {
        const region = document.querySelector('[aria-label="当前文件与页号"]');
        window.__outgoingOcrCoordinates = [region.textContent];
        window.__outgoingOcrObserver = new MutationObserver(() => {
          if (region.isConnected) window.__outgoingOcrCoordinates.push(region.textContent);
        });
        window.__outgoingOcrObserver.observe(region, { subtree: true, childList: true, characterData: true });
        document.querySelector('a[aria-label="专精特新企业称号台账，返回企业列表"]').click();
      })()`)
      await wait(`location.pathname === '/' && !document.querySelector('[aria-label="当前文件与页号"]')`)
      const coordinates = await ev(`(() => { window.__outgoingOcrObserver.disconnect(); return window.__outgoingOcrCoordinates; })()`)
      assert.ok(coordinates.every(text => text.includes('workbench-97.pdf') && text.includes('第 1 /')), `outgoing OCR selection changed at ${width}px: ${JSON.stringify(coordinates)}`)
      console.log(`✓ ${width}px outgoing OCR selection survives Nuxt page transition`)
    }

    for (const width of [1440, 390]) {
      const height = width === 390 ? 844 : 900
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid)
      for (const motion of ['no-preference', 'reduce']) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] }, sid)
        await navigate()
        await wait("document.querySelector('td[rowspan=\"2\"]')?.textContent === '宁波甲企业'")
        await wait("[...document.querySelectorAll('ul[role=list] li img')].some(img=>img.complete && img.naturalWidth>0)")
        assert.equal(await ev("matchMedia('(prefers-reduced-motion: reduce)').matches"), motion === 'reduce')
        assert.equal(await ev("document.querySelectorAll('ul[role=\"list\"] .content-preview').length"), 1)
        assert.equal(await ev("!!document.querySelector('.content-preview script,.content-preview iframe,.content-preview img') || !!window.__ocrExecuted"), false)

        // One screen: no document scroll; the fixed bottom bar is in view.
        assert.equal(await ev('document.documentElement.scrollHeight <= innerHeight + 1'), true, `document scrolls at ${width}`)
        assert.equal(await ev('document.documentElement.scrollWidth <= innerWidth + 1'), true, `horizontal page scroll at ${width}`)
        assert.equal(await ev(`(() => { const r=document.querySelector('footer[aria-label="翻页与页操作"]').getBoundingClientRect(); return r.top < innerHeight && r.bottom <= innerHeight + 1 })()`), true, `bottom bar not visible at ${width}`)
        assert.equal(await ev(`document.querySelectorAll('button[aria-label="下一页"]').length`), 1)
        assert.equal(await ev(`document.querySelectorAll('button[aria-label="上一页"]').length`), 1)
        assert.equal(await ev(`document.body.innerText.includes('上一处') || document.body.innerText.includes('下一处')`), false)
        assert.equal(await ev(`document.querySelector('[aria-label="当前文件与页号"]').innerText.includes('第 1 / 97 页')`), true)
        if (width === 1440) {
          assert.equal(await ev(`getComputedStyle(document.querySelector('section[aria-label="当前页页图"]')).display !== 'none'`), true)
          assert.equal(await ev(`getComputedStyle(document.querySelector('section[aria-label="当前页识别文本"]')).display !== 'none'`), true)
          assert.equal(await ev(`(() => { const a=document.querySelector('section[aria-label="当前页页图"]').getBoundingClientRect(); const b=document.querySelector('section[aria-label="当前页识别文本"]').getBoundingClientRect(); return Math.abs(a.top-b.top) < 1 })()`), true)
        } else {
          assert.equal(await ev(`getComputedStyle(document.querySelector('section[aria-label="当前页页图"]')).display`), 'none')
          assert.equal(await ev(`getComputedStyle(document.querySelector('section[aria-label="当前页识别文本"]')).display !== 'none'`), true)
          assert.equal(await ev(`document.body.innerText.includes('文本') && document.body.innerText.includes('页图') && document.body.innerText.includes('对照')`), true)
        }

        assert.equal(await ev("document.body.innerText.includes('共 97 页')"), false, 'duplicate total-page chrome still present')
        if (width === 1440) {
          assert.equal(await ev("!!document.querySelector('[class*=\"bg-black/35\"]')"), false, 'page image still dimmed by a hover/focus overlay')
          assert.equal(await ev("document.querySelector('[data-ocr-zoom-hint]')?.textContent.includes('放大')"), true, 'zoom affordance missing')
          const imageBox = await ev(`(() => { const r=document.querySelector('[aria-label="放大看第 1 页"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: imageBox.x, y: imageBox.y }, sid)
          await wait("parseFloat(getComputedStyle(document.querySelector('[data-ocr-zoom-hint]')).opacity) > 0.9")
          assert.ok(await ev("document.querySelector('[data-ocr-zoom-hint]').getBoundingClientRect().height >= 20"), 'zoom hint too small')
        }

        const writesBefore = requests.filter(r => r.method !== 'GET').length
        await click('源码')
        await wait("document.querySelector('.content-preview pre')?.textContent.includes('<table>')")
        assert.ok(await ev("parseFloat(getComputedStyle(document.querySelector('.content-preview pre')).fontSize) >= 14"), 'source font below 14px')
        assert.equal(await ev("document.querySelector('.content-preview pre')?.getAttribute('tabindex')"), '0', 'source scroller not keyboard reachable')
        // Wrap is visible and on by default; toggling both directions works.
        await wait("getComputedStyle(document.querySelector('ul[role=list] .content-preview pre')).whiteSpace === 'pre-wrap'")
        await click('自动换行')
        await wait("getComputedStyle(document.querySelector('ul[role=list] .content-preview pre')).whiteSpace !== 'pre-wrap'")
        await click('自动换行')
        await wait("getComputedStyle(document.querySelector('ul[role=list] .content-preview pre')).whiteSpace === 'pre-wrap'")
        await click('复制原文')
        await wait("document.body.innerText.includes('已复制原文')")
        assert.equal(await ev('navigator.clipboard.readText()'), source)
        await click('预览')
        await wait("document.querySelector('td[rowspan=\"2\"]')")
        assert.equal(await ev("document.querySelector('.safe-preview-html')?.getAttribute('tabindex')"), '0', 'table scroller not keyboard reachable')
        assert.equal(await ev("document.querySelector('.safe-preview-html')?.getAttribute('role')"), 'region')
        // Long tables scroll locally at both widths; the hint is visible.
        assert.equal(await ev("(() => { const el=[document.querySelector('.preview-content'),...document.querySelectorAll('.preview-content .safe-preview-html,.preview-content pre')].find(e=>e && e.scrollWidth>e.clientWidth); if(!el)return false; el.scrollLeft=200; return el.scrollLeft>0; })()"), true)
        assert.equal(await ev("!!document.querySelector('[data-ocr-horizontal-hint]')"), true)

        // Edit keeps raw Markdown, uses >=14px, and keeps save/cancel in the bar.
        await click('编辑', '[aria-label="翻页与页操作"]')
        await wait("document.activeElement?.tagName==='TEXTAREA'")
        assert.equal(await ev("document.querySelector('textarea').value"), source)
        assert.ok(await ev("parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize) >= 14"), 'editor font below 14px')
        assert.equal(await ev("document.body.innerText.includes('保存写入原始文本')"), false, 'duplicate save explanation still shown')
        assert.equal(await ev("(document.body.innerText.match(/保存使用原始 Markdown/g)||[]).length"), 1, 'save explanation missing/duplicated')
        assert.equal(await ev(`!!document.querySelector('[aria-label="翻页与页操作"] button')`), true)
        if (motion === 'reduce') {
          assert.equal(await ev("document.querySelector('ul[role=\"list\"] li').getAnimations({subtree:true}).some(a=>a.playState==='running')"), false)
        }
        await fill('textarea', source + '\n校对草稿')
        // The file sheet must stay open and explain why a dirty draft blocks the switch.
        await openFileSheet()
        assert.equal(await ev(`!!document.querySelector('[data-slot="sheet-content"]')?.innerText.includes('有未保存的草稿')`), true, 'file sheet missing blocked reason')
        assert.equal(await ev(`[...document.querySelectorAll('[data-slot="sheet-content"] li button')].every(b => b.disabled)`), true, 'file rows not disabled while dirty')
        await ev(`(() => { const b=[...document.querySelectorAll('[data-slot="sheet-content"] li button')].find(b=>b.textContent.includes('second.pdf')); b?.click() })()`)
        await sleep(150)
        assert.equal(await ev(`!!document.querySelector('[data-slot="sheet-content"]')`), true, 'blocked file switch silently closed the sheet')
        assert.equal(await ev("document.querySelector('textarea').value"), source + '\n校对草稿')
        assert.equal(await ev("new URL(location.href).searchParams.get('file')"), 'workbench-97.pdf')
        await key('Escape', 'Escape')
        await wait(`!document.querySelector('[data-slot="sheet-content"]')`)

        // Dirty cancel/Esc: confirm first; refusing keeps the draft.
        await click('取消', '[aria-label="翻页与页操作"]')
        await wait(`!!document.querySelector('[data-slot="dialog-content"]')`)
        assert.equal(await ev(`document.querySelector('[data-slot="dialog-content"]').innerText.includes('放弃未保存的校对')`), true)
        await key('Escape', 'Escape')
        await wait(`!document.querySelector('[data-slot="dialog-content"]')`)
        assert.equal(await ev("document.querySelector('textarea').value"), source + '\n校对草稿', 'Esc in the discard dialog lost the draft')
        await click('取消', '[aria-label="翻页与页操作"]')
        await wait(`!!document.querySelector('[data-slot="dialog-content"]')`)
        await click('放弃草稿', '[data-slot="dialog-content"]')
        await wait(`!document.querySelector('textarea')`)
        assert.equal(await ev("document.activeElement?.getAttribute('aria-label')"), '编辑')
        assert.equal(await ev("document.activeElement?.closest('[aria-label=\"翻页与页操作\"]') !== null"), true)

        // Compare dialog: layout-aware copy, in-dialog paging, source/wrap, Esc focus.
        // On mobile the image pane is a tab; switch to it so the real entry is visible.
        if (width === 390) {
          await click('页图', '[data-slot="tabs-list"]')
          await wait("getComputedStyle(document.querySelector('section[aria-label=\"当前页页图\"]')).display !== 'none'")
        }
        await click('打开当前页对照', 'section[aria-label="当前页页图"]')
        await wait("document.querySelector('[role=dialog]')")
        await wait("[...document.querySelectorAll('[role=dialog] img')].some(img=>img.complete && img.naturalWidth>0)")
        assert.equal(await ev("document.querySelector('[role=dialog] td[rowspan=\"2\"]')?.textContent === '宁波甲企业'"), true)
        assert.equal(await ev("document.querySelector('[role=dialog] [role=dialog]') === null"), true)
        assert.equal(await ev("document.querySelector('[role=dialog]').innerText.includes('关闭后停留当前对照页')"), true, 'compare copy still promises a return to the old page')
        if (width === 390) {
          assert.equal(await ev("document.querySelector('[role=dialog]').innerText.includes('上方是页图，下方是识别文本')"), true)
          assert.ok(await ev("document.querySelector('[role=dialog] [data-comparison-image] img').getBoundingClientRect().width >= 240"), '390 compare image is a thumbnail')
        } else {
          assert.equal(await ev("document.querySelector('[role=dialog]').innerText.includes('左侧是页图，右侧是识别文本')"), true)
          const imageCol = await ev("document.querySelector('[role=dialog] [data-comparison-image]').getBoundingClientRect().width")
          const textCol = await ev("document.querySelector('[role=dialog] section[aria-label=\"对照识别文本\"]').getBoundingClientRect().width")
          assert.ok(imageCol <= 620, `compare image column wastes width: ${imageCol}`)
          assert.ok(textCol >= imageCol && textCol >= 700, `compare text pane too narrow: ${textCol}`)
        }
        await click('对照下一页', '[role=dialog]')
        await wait("document.querySelector('[role=dialog]').innerText.includes('第 2 页') && document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 2 / 97 页')")
        await click('对照上一页', '[role=dialog]')
        await wait("document.querySelector('[role=dialog]').innerText.includes('第 1 页')")
        await click('源码', '[role=dialog]')
        await wait("document.querySelector('[role=dialog] .content-preview pre')?.textContent.includes('<table>')")
        assert.ok(await ev("parseFloat(getComputedStyle(document.querySelector('[role=dialog] .content-preview pre')).fontSize) >= 14"), 'dialog source font below 14px')
        await click('自动换行', '[role=dialog]')
        await wait("getComputedStyle(document.querySelector('[role=dialog] .content-preview pre')).whiteSpace !== 'pre-wrap'")
        await click('自动换行', '[role=dialog]')
        await click('预览', '[role=dialog]')
        await wait("document.querySelector('[role=dialog] td[rowspan=\"2\"]')")
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid)
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid)
        await wait("!document.querySelector('[role=dialog]')")
        assert.equal(await ev("document.activeElement?.getAttribute('aria-label')"), '打开当前页对照')
        if (width === 390) {
          await click('文本', '[data-slot="tabs-list"]')
          await wait("getComputedStyle(document.querySelector('section[aria-label=\"当前页识别文本\"]')).display !== 'none'")
        }
        if (motion === 'reduce') {
          assert.deepEqual(await ev("[...document.querySelectorAll('[data-slot=dialog-overlay],[role=dialog]')].flatMap(e=>e.getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({name:a.animationName,property:a.transitionProperty,target:a.effect.target.outerHTML.slice(0,400)})))"), [], 'comparison dialog still animates under reduce')
        }
        assert.equal(requests.filter(r => r.method !== 'GET').length, writesBefore)
        assert.deepEqual(snapshot(), before, 'display-only operations mutated data')
        assert.deepEqual(fileDigests(), filesBefore, 'display-only operations mutated source/page images')

        // Download comes from the row overflow now (the pane toolbar is compact).
        await openRowMenu()
        const downloadCount = downloads.length
        await menu('下载原文')
        const downloadDeadline = Date.now() + 15000
        while ((downloads.length === downloadCount || !finishedDownloads.has(downloads.at(-1)?.guid)) && Date.now() < downloadDeadline) await sleep(50)
        assert.equal(downloads.length, downloadCount + 1)
        assert.equal(finishedDownloads.has(downloads.at(-1).guid), true)
        assert.equal(downloads.at(-1).suggestedFilename, '第 1 页.md')
        assert.equal(readFileSync(join(root, 'downloads', downloads.at(-1).guid), 'utf8'), source)

        // Filters: apply from the sheet, empty state has one clear action.
        await openFilters()
        await fill('[aria-label="当前文件正文关键词"]', '字段0')
        await applyFilters()
        await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 1 / 97 页') && document.body.innerText.includes('命中 1 页')")
        // Chip removal is reachable at every width (390 included) with a real target.
        assert.equal(await ev(`(() => { const b=document.querySelector('button[aria-label^="移除筛选"]'); if(!b) return false; const r=b.getBoundingClientRect(); return r.width>=24 && r.height>=24 && r.width>0 })()`), true, 'chip remove target below 24px or invisible')
        await openFilters()
        await fill('[aria-label="实际页号或范围"]', '50-60')
        await applyFilters()
        await wait("document.body.innerText.includes('没有命中页')")
        assert.equal(await ev("(document.body.innerText.match(/清除页筛选/g) || []).length"), 1)
        await click('清除页筛选')
        await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 1 / 97 页')")

        if (width === 1440) {
          await openFileSheet()
          await fill('[aria-label="按文件名搜索"]', 'zzz')
          await wait("document.body.innerText.includes('没有匹配的 PDF')")
          assert.ok(await ev(`(() => { const p=[...document.querySelectorAll('[data-slot="sheet-content"] p')].find(p=>p.textContent.includes('没有匹配的 PDF')); return p && parseFloat(getComputedStyle(p).fontSize) >= 13 })()`), 'file empty-state text below 13px')
          await fill('[aria-label="按文件名搜索"]', '')
          await key('Escape', 'Escape')
          await wait("!document.querySelector('[data-slot=\"sheet-content\"]')")
        }

        // Jump to a page with content and verify pane scroll reset without page scroll.
        await ev("document.querySelector('.preview-content').scrollTop = 120")
        await click('跳转实际页号')
        await wait("document.querySelector('input[aria-label=\"跳转实际页号\"]')")
        await fill('input[aria-label="跳转实际页号"]', '4')
        // Desktop opens the page navigator as a Popover; narrow screens use a Sheet.
        await click('跳转', '[data-slot="popover-content"], [data-slot="sheet-content"]')
        await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 4 / 97 页') && document.querySelector('.preview-content')")
        assert.equal(await ev('window.scrollY'), 0)
        assert.equal(await ev("document.querySelector('.preview-content').scrollTop"), 0)

        // Keyboard paging, and no paging while editing.
        await ev("document.activeElement?.blur()")
        await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))")
        await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 5 / 97 页')")
        await edit()
        await ev("document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))")
        await sleep(150)
        assert.equal(await ev("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 5 / 97 页')"), true)
        await cancel()

        // Page navigator: every physical page is listed, thumbnails stay lazy, and a
        // page can be picked directly (no typing first). Popover on desktop, Sheet at 390.
        await click('跳转实际页号')
        await wait(`!!document.querySelector('[data-ocr-page-cell]')`)
        assert.equal(await ev("document.querySelectorAll('[data-ocr-page-cell]').length"), 97, 'navigator did not list every physical page')
        assert.ok(await ev("document.querySelectorAll('[data-ocr-page-cell] img').length < 97"), 'navigator eagerly loaded every page image')
        assert.equal(await ev("document.querySelector('[data-ocr-page-cell][aria-current=\"page\"]')?.dataset.page"), '5', 'navigator did not mark the current page')
        await ev(`document.querySelector('[data-ocr-page-cell][data-page="6"]').click()`)
        await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 6 / 97 页')")
        await key('Escape', 'Escape')
        await wait(`!document.querySelector('[data-slot="popover-content"], [data-slot="sheet-content"]')`)

        if (width === 390) {
          await click('页图', '[data-slot="tabs-list"]')
          await wait("getComputedStyle(document.querySelector('section[aria-label=\"当前页页图\"]')).display !== 'none'")
          assert.equal(await ev("getComputedStyle(document.querySelector('section[aria-label=\"当前页识别文本\"]')).display"), 'none')
          assert.ok(await ev("document.querySelector('section[aria-label=\"当前页页图\"] img').getBoundingClientRect().width >= 240"), '390 image tab still thumbnail-sized')
          await click('对照', '[data-slot="tabs-list"]')
          await wait("getComputedStyle(document.querySelector('section[aria-label=\"当前页页图\"]')).display !== 'none' && getComputedStyle(document.querySelector('section[aria-label=\"当前页识别文本\"]')).display !== 'none'")
          assert.ok(await ev("document.querySelector('section[aria-label=\"当前页页图\"] img').getBoundingClientRect().width >= 240"), '390 compare image still 118px-wide thumbnail')
          assert.ok(await ev(`(() => { const el=document.querySelector('section[aria-label="当前页识别文本"] .preview-content'); const lh=parseFloat(getComputedStyle(el).lineHeight)||24; return el.clientHeight/lh >= 4 })()`), '390 compare text context too short')
          // Real wheel zoom over the in-place viewer increases the page image.
          await sleep(250)
          const before = await ev("document.querySelector('section[aria-label=\"当前页页图\"] img').getBoundingClientRect().width")
          const box = await ev(`(() => { const r=document.querySelector('section[aria-label="当前页页图"] [data-preview-shell] div.relative').getBoundingClientRect(); return { x: r.x + r.width/2, y: Math.min(Math.max(r.y + r.height/2, 20), innerHeight-20) } })()`)
          const hit = await ev(`(() => { const e=document.elementFromPoint(${box.x}, ${box.y}); return e ? e.tagName + '.' + String(e.className) : 'none' })()`)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -160 }, sid)
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            if (await ev("document.querySelector('section[aria-label=\"当前页页图\"] img').getBoundingClientRect().width") > before * 1.05) break
            await sleep(60)
          }
          console.log(JSON.stringify({ zoomProbe: { before, box, hit, after: await ev("document.querySelector('section[aria-label=\"当前页页图\"] img').getBoundingClientRect().width") } }))
          assert.ok(await ev("document.querySelector('section[aria-label=\"当前页页图\"] img').getBoundingClientRect().width") > before * 1.05, '390 compare image cannot be zoomed in place')
          await click('文本', '[data-slot="tabs-list"]')
          await wait("getComputedStyle(document.querySelector('section[aria-label=\"当前页识别文本\"]')).display !== 'none'")
        }
        console.log(JSON.stringify({ width, motion, displayAndCancel: 'passed', noScroll: 'passed', singlePager: 'passed' }))
      }
    }

    // Save / readback failures and the current-page draft guard.
    await navigate()
    await edit()
    await fill('textarea', source + '\n已校对')
    failWrite = true
    await save()
    await wait("document.body.innerText.includes('保存失败') && !!document.querySelector('textarea') && !document.querySelector('textarea').readOnly")
    assert.equal(await ev("document.querySelector('textarea').value"), source + '\n已校对')
    assert.deepEqual(snapshot(), before, 'failed POST changed data')
    failWrite = false; failRead = true
    await save()
    await wait("document.body.innerText.includes('已提交') && document.body.innerText.includes('读回失败') && !!document.querySelector('textarea') && !document.querySelector('textarea').readOnly && !document.querySelector('textarea').disabled")
    checkCommit()
    const postsBeforeReadRetry = requests.filter(r => r.method === 'POST').length
    failRead = false
    // A committed write whose readback failed retries with GET only.
    await click('重试读取', 'section[aria-label="当前页识别文本"]')
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('保存完成')")
    assert.equal(requests.filter(r => r.method === 'POST').length, postsBeforeReadRetry, 'readback retry repeated the POST')
    await navigate()
    await wait("document.body.innerText.includes('已校对')")

    // POST committed, then a successful GET whose per-page markdown is absent.
    await edit(); await fill('textarea', source + '\n缺失读回校对')
    missingMarkdown = true
    await save()
    await wait("document.body.innerText.includes('写入已提交,但读回失败') && !!document.querySelector('textarea') && !document.querySelector('textarea').disabled && !document.querySelector('textarea').readOnly")
    assert.equal(await ev("document.querySelector('textarea').value"), source + '\n缺失读回校对')
    checkCommit()
    const postsBeforeMissingRetry = requests.filter(r => r.method === 'POST').length
    missingMarkdown = false
    await click('重试读取', 'section[aria-label="当前页识别文本"]')
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('保存完成')")
    assert.equal(requests.filter(r => r.method === 'POST').length, postsBeforeMissingRetry, 'missing-markdown retry repeated the POST')
    await navigate()
    await wait("document.body.innerText.includes('缺失读回校对')")

    await edit(); await fill('textarea', ''); await save()
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('空结果') && document.body.innerText.includes('正文为空')")
    checkCommit()
    await navigate()
    await wait("document.body.innerText.includes('正文为空')")
    // Restore the synthetic target so final before/after comparison covers every other field.
    await edit(); await fill('textarea', source); await save()
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('宁波甲企业')")
    checkCommit()

    // A saved row can leave its filter. Focus must survive both remaining and empty matches.
    for (const [width, motion] of [[1440, 'no-preference'], [1440, 'reduce'], [390, 'no-preference'], [390, 'reduce']]) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] }, sid)
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: false }, sid)
      for (const another of [true, false]) {
        await navigate()
        await openFilters()
        await fill('[aria-label="当前文件正文关键词"]', another ? '企业' : '宁波甲企业')
        await applyFilters()
        await edit()
        await fill('textarea', '修订完成')
        assert.equal(await ev("[...document.querySelectorAll('[aria-label=\"翻页与页操作\"] button')].filter(b => /上一页|下一页/.test(b.textContent)).every(b => b.disabled)"), true)
        await save()
        await wait("!document.querySelector('textarea')")
        checkCommit()
        await wait("document.activeElement?.closest('[aria-label=\"翻页与页操作\"]') !== null")
        assert.equal(await ev("!!document.querySelector('ul[role=list] li')"), another)
        if (another) {
          const pageNow = await ev("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText")
          assert.equal(pageNow.includes('第 4 / 97 页'), true, pageNow)
        }
        else await wait("document.body.innerText.includes('没有命中页')")
        if (another) await click('清除条件')
        else await click('清除页筛选')
        await navigate()
        await edit(); await fill('textarea', source); await save()
        await wait("!document.querySelector('textarea') && document.body.innerText.includes('宁波甲企业')")
        checkCommit()
        // Create then delete only the originally unrecognized page; all existing raw rows stay intact.
        await navigate('workbench-97.pdf', 3)
        await click('手工录入')
        await wait("document.activeElement?.tagName==='TEXTAREA'")
        await fill('textarea', '删除校验 企业')
        await save()
        await wait("!document.querySelector('textarea') && document.body.innerText.includes('删除校验')")
        await openFilters()
        await fill('[aria-label="当前文件正文关键词"]', another ? '企业' : '删除校验')
        await applyFilters()
        await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 3 / 97 页')")
        const deletesBefore = requests.filter(r => r.method === 'DELETE').length
        await openRowMenu()
        await menu('删除本页结果')
        await wait("document.querySelector('[role=dialog]')")
        assert.equal(requests.filter(r => r.method === 'DELETE').length, deletesBefore)
        await click('取消', '[role=dialog]')
        await wait("!document.querySelector('[role=dialog]')")
        await openRowMenu()
        await menu('删除本页结果')
        await wait("document.querySelector('[role=dialog]')")
        await click('确认删除', '[role=dialog]')
        await wait("document.activeElement?.closest('[aria-label=\"翻页与页操作\"]') !== null")
        assert.equal(await ev("!!document.querySelector('ul[role=list] li')"), another)
        if (another) await click('清除条件')
        else await click('清除页筛选')
        await wait("!document.querySelector('[data-slot=\"sheet-content\"]')")
        // Both pager buttons use the same physical-page state and navigation action.
        await navigate()
        await click('下一页', '[aria-label="翻页与页操作"]')
        await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 2 / 97 页') && new URL(location.href).searchParams.get('page')==='2'")
        await click('上一页', '[aria-label="翻页与页操作"]')
        await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 1 / 97 页')")
        console.log(JSON.stringify({ width, motion, another, saveAndDeleteFilterFocus: 'passed', bottomPager: 'passed' }))
      }
    }

    // Short viewports: 1280x600 and 720x450 (the CSS reflow equivalent of ~200%
    // browser zoom; not a real zoom and not a @2x screenshot). The document still
    // does not scroll; the workspace keeps a readable minimum and scrolls inside
    // `main`, with the fixed bottom bar reachable.
    for (const [width, height] of [[1280, 600], [720, 450]]) {
      for (const motion of ['no-preference', 'reduce']) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid)
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] }, sid)
      await navigate()
      await wait("document.querySelector('td[rowspan=\"2\"]')")
      assert.equal(await ev('document.documentElement.scrollWidth <= innerWidth + 1'), true, `${width}x${height} horizontal overflow`)
      assert.equal(await ev('document.documentElement.scrollHeight <= innerHeight + 1'), true, `${width}x${height} document scroll`)
      assert.equal(await ev(`(() => { const r=document.querySelector('footer[aria-label="翻页与页操作"]').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top < innerHeight })()`), true, `${width}x${height} bottom bar off-screen`)
      // The short-height contract is eight visible lines reachable by internal
      // scrolling. Preserve the initial geometry, then use one real wheel action
      // on the workspace gutter; never scroll programmatically or until green.
      const initialReading = await ev(`(() => {
        const main=document.querySelector('main[aria-label="校对内容"]');
        const body=document.querySelector('.preview-content');
        const mr=main.getBoundingClientRect(), br=body.getBoundingClientRect();
        const lh=parseFloat(getComputedStyle(body).lineHeight)||parseFloat(getComputedStyle(body).fontSize)*1.5;
        const y=Math.max(mr.top, 0)+Math.min(mr.height, innerHeight-mr.top)/2;
        const x=[mr.left+2,mr.right-2].find(x=>{
          const hit=document.elementFromPoint(x,y);
          return hit && main.contains(hit) && !hit.closest('.preview-content,section,button,input,textarea');
        });
        return {url:location.href,page:document.querySelector('[aria-label="当前文件与页号"]').innerText,
          notices:[...main.querySelectorAll('[role="status"],[role="alert"]')].map(e=>e.textContent),
          documentY:scrollY,scrollTop:main.scrollTop,bodyTop:br.top,mainTop:mr.top,
          lines:Math.max(0,Math.min(br.bottom,mr.bottom)-Math.max(br.top,mr.top))/lh,
          x,y,deltaY:Math.min(Math.max(0,br.top-mr.top),main.scrollHeight-main.clientHeight-main.scrollTop)};
      })()`)
      console.log(JSON.stringify({shortViewportInitial: `${width}x${height}`, motion, ...initialReading}))
      if (initialReading.lines < 8 && initialReading.deltaY > 0) {
        assert.ok(Number.isFinite(initialReading.x), 'no visible workspace gutter for trusted wheel input')
        await cdp.send('Input.dispatchMouseEvent', {type:'mouseWheel',x:initialReading.x,y:initialReading.y,deltaX:0,deltaY:initialReading.deltaY}, sid)
        await wait(`document.querySelector('main[aria-label="校对内容"]').scrollTop > ${initialReading.scrollTop}`)
        await ev(`new Promise((resolve,reject)=>{
          const main=document.querySelector('main[aria-label="校对内容"]');
          const deadline=performance.now()+3000; let previous=null,stable=0;
          const frame=()=>{const state=[main.scrollTop,document.querySelector('.preview-content').getBoundingClientRect().top].join(':');
            stable=state===previous?stable+1:0; previous=state;
            if(stable>=3) return resolve(true);
            if(performance.now()>deadline) return reject(new Error('reading geometry did not settle'));
            requestAnimationFrame(frame);}; requestAnimationFrame(frame);
        })`)
      }
      assert.equal(await ev('location.href'), initialReading.url, 'reading positioning changed file/page route')
      assert.equal(await ev(`document.querySelector('[aria-label="当前文件与页号"]').innerText`), initialReading.page, 'reading positioning changed file/page label')
      assert.equal(await ev('scrollY'), initialReading.documentY, 'reading positioning scrolled the document')
      assert.equal(await ev(`(() => {const r=document.querySelector('footer[aria-label="翻页与页操作"]').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight+1})()`), true, 'reading positioning hid the footer')
      const readable = await ev(`(() => { const el=document.querySelector('.preview-content'); const lh=parseFloat(getComputedStyle(el).lineHeight)||parseFloat(getComputedStyle(el).fontSize)*1.5; const main=document.querySelector('main[aria-label="校对内容"]'); const mr=main.getBoundingClientRect(); const er=el.getBoundingClientRect(); const visible=Math.max(0, Math.min(er.bottom, mr.bottom) - Math.max(er.top, mr.top)); return { lines: visible/lh, pane: visible, workspaceScrolls: main.scrollHeight > main.clientHeight } })()`)
      assert.ok(readable.lines >= 8, `${width}x${height} text collapsed to ${readable.lines.toFixed(1)} lines`)
      if (height <= 560) {
        // Compact chrome keeps the filter and the full counts reachable.
        assert.equal(await ev(`getComputedStyle(document.querySelector('.ocr-meta-row')).display`), 'none', 'short viewport kept the metadata row')
        assert.equal(await ev(`(() => { const b=document.querySelector('button[aria-label="筛选当前文件"]'); return b && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().height > 0 })()`), true, 'short viewport lost the filter entry')
        await click('筛选当前文件')
        await wait(`!!document.querySelector('[data-slot="sheet-content"]')`)
        await key('Escape', 'Escape')
        await wait(`!document.querySelector('[data-slot="sheet-content"]')`)
        await click('跳转实际页号')
        await wait(`!!document.querySelector('[data-slot="popover-content"], [data-slot="sheet-content"]')`)
        assert.equal(await ev(`(() => { const el=document.querySelector('[data-slot="popover-content"], [data-slot="sheet-content"]'); return !!el && el.innerText.includes('全文件 97 页') && el.innerText.includes('有文本 95') })()`), true, 'short viewport lost the full counts')
        await key('Escape', 'Escape')
        await wait(`!document.querySelector('[data-slot="popover-content"], [data-slot="sheet-content"]')`)
      }
      await edit()
      assert.ok(await ev("parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize) >= 14"), `${width}x${height} editor font below 14px`)
      const editorLines = await ev(`(() => { const el=document.querySelector('textarea'); const lh=parseFloat(getComputedStyle(el).lineHeight)||22; const main=document.querySelector('main[aria-label="校对内容"]'); const mr=main.getBoundingClientRect(); const er=el.getBoundingClientRect(); const visible=Math.max(0, Math.min(er.bottom, mr.bottom) - Math.max(er.top, mr.top)); return visible/lh })()`)
      assert.ok(editorLines >= 8, `${width}x${height} editor collapsed to ${editorLines.toFixed(1)} lines`)
      await cancel()

      if (width === 720) {
        // The compare tab must be usable without leaving the view: page image at
        // fit width (zoomable) plus a text context below it.
        await click('对照', '[data-slot="tabs-list"]')
        await wait("getComputedStyle(document.querySelector('section[aria-label=\"当前页页图\"]')).display !== 'none' && getComputedStyle(document.querySelector('section[aria-label=\"当前页识别文本\"]')).display !== 'none'")
        assert.ok(await ev("document.querySelector('section[aria-label=\"当前页页图\"] img').getBoundingClientRect().width >= 240"), '720x450 compare tab image collapsed')
        assert.ok(await ev(`(() => { const el=document.querySelector('section[aria-label="当前页识别文本"] .preview-content'); const lh=parseFloat(getComputedStyle(el).lineHeight)||24; return el.clientHeight/lh >= 4 })()`), '720x450 compare tab text context too short')
      }
      await click('打开当前页对照', 'section[aria-label="当前页页图"]')
      await wait("document.querySelector('[role=dialog]')")
      await wait("[...document.querySelectorAll('[role=dialog] img')].some(img=>img.complete && img.naturalWidth>0)")
      if (width === 720) {
        // Short heights: one scrollable column with real reading heights, not two
        // panes squeezed into ~160px each.
        const paneHeights = await ev(`(() => { const img=document.querySelector('[role=dialog] [data-comparison-image]').getBoundingClientRect(); const txt=document.querySelector('[role=dialog] section[aria-label="对照识别文本"]').getBoundingClientRect(); return { img: img.height, txt: txt.height } })()`)
        assert.ok(paneHeights.img >= 280 && paneHeights.txt >= 280, `720x450 compare panes collapsed: ${JSON.stringify(paneHeights)}`)
        const dialogLines = await ev(`(() => { const el=document.querySelector('[role=dialog] section[aria-label="对照识别文本"] .preview-content'); const lh=parseFloat(getComputedStyle(el).lineHeight)||24; return el.clientHeight/lh })()`)
        assert.ok(dialogLines >= 8, `720x450 compare text collapsed to ${dialogLines.toFixed(1)} lines`)
        assert.ok(await ev("document.querySelector('[role=dialog] [data-comparison-image] img').getBoundingClientRect().width >= 240"), '720x450 compare page image too small')
      } else {
        const imageCol = await ev("document.querySelector('[role=dialog] [data-comparison-image]').getBoundingClientRect().width")
        const textCol = await ev("document.querySelector('[role=dialog] section[aria-label=\"对照识别文本\"]').getBoundingClientRect().width")
        assert.ok(textCol >= 600 && textCol >= imageCol, `1280x600 compare text too narrow: ${textCol} vs image ${imageCol}`)
      }
      await key('Escape', 'Escape')
      await wait("!document.querySelector('[role=dialog]')")
      console.log(JSON.stringify({ shortViewport: `${width}x${height}`, motion, readableLines: Number(readable.lines.toFixed(1)), editorLines: Number(editorLines.toFixed(1)), workspaceScrolls: readable.workspaceScrolls }))
    }
      }
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, sid)

    // Real keyboard input on a focused horizontal scroller: it scrolls the table
    // and does not page; a non-interactive focus still pages.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid)
    await navigate()
    await wait("document.querySelector('td[rowspan=\"2\"]')")
    assert.equal(await ev("document.querySelector('.safe-preview-html').getAttribute('tabindex')"), '0')
    const scrollerInfo = await ev(`(() => {
      const els = [document.querySelector('.preview-content'), ...document.querySelectorAll('.preview-content .safe-preview-html, .preview-content pre')]
      const el = els.find(e => e && e.scrollWidth > e.clientWidth)
      if (!el) return { found: false, candidates: els.map(e => e && ({ tag: e.tagName, cls: e.className, sw: e.scrollWidth, cw: e.clientWidth })) }
      el.focus()
      return { found: true, tag: el.tagName, cls: String(el.className), sw: el.scrollWidth, cw: el.clientWidth, active: document.activeElement === el, tab: el.getAttribute('tabindex') }
    })()`)
    assert.ok(scrollerInfo.found, `no horizontal scroller: ${JSON.stringify(scrollerInfo)}`)
    console.log(JSON.stringify({ scrollerInfo }))
    const scrollBefore = await ev("document.activeElement.scrollLeft")
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, sid)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, sid)
    await sleep(250)
    const scrollAfter = await ev("document.activeElement.scrollLeft")
    assert.ok(scrollAfter > scrollBefore + 10, `ArrowRight did not scroll the table (${scrollBefore} → ${scrollAfter})`)
    assert.equal(await ev("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 1 / 97 页')"), true, 'ArrowRight on a focused table paged instead of scrolling')
    await ev("document.activeElement?.blur()")
    await key('ArrowRight', 'ArrowRight')
    await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 2 / 97 页')")
    console.log(JSON.stringify({ keyboardWideTable: 'passed' }))

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid)
    await navigate('workbench-97.pdf', 97)
    await wait("document.querySelector('.content-preview h1')?.textContent==='第97页'")
    await click('源码')
    assert.equal(await ev("document.querySelectorAll('ul[role=\"list\"] .content-preview').length"), 1)
    await navigate('second.pdf')
    await wait("document.querySelector('.content-preview h1')?.textContent==='第二文件'")
    holdRead = true
    await openFileSheet()
    await ev(`(() => { const matches=[...document.querySelectorAll('[data-slot="sheet-content"] li button')].filter(b=>b.textContent.includes('workbench-97.pdf')); if(matches.length!==1) throw new Error('missing workbench row'); matches[0].click() })()`)
    const heldDeadline = Date.now() + 15000
    while (!held && Date.now() < heldDeadline) await sleep(50)
    assert.ok(held, 'old file request did not reach transport')
    await selectFile('second.pdf')
    await wait("document.querySelector('.content-preview h1')?.textContent==='第二文件'")
    await cdp.send('Fetch.continueRequest', { requestId: held.requestId }, sid)
    const completionDeadline = Date.now() + 15000
    while (!completed.has(held.networkId) && Date.now() < completionDeadline) await sleep(50)
    assert.ok(completed.has(held.networkId), 'late old response did not finish')
    await ev('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await wait("document.querySelector('.content-preview h1')?.textContent==='第二文件'")
    assert.deepEqual(failures, [])
    assert.deepEqual(external, [])
    const after = snapshot()
    assert.equal(committed, expectedEdits.length)
    assert.equal(expectedEdits.at(-1), source)
    assertTargetHistory(before, after, source, expectedEdits, startedAt, Date.now())
    assert.deepEqual(fileDigests(), filesBefore)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    console.log(JSON.stringify({ writesAndReadback: 'passed', emptyReload: 'passed', lateFile: 'passed', capturesAndOtherData: 'unchanged', revisions: committed + 1, root }))
  }
} catch (error) {
  primaryError = error
  console.error('Primary failure:', error)
} finally {
  // Each acquired resource gets its own cleanup attempt. Never pass absent
  // handles to the shared helper, and never mask the original assertion.
  const cleanup = async (name, action) => {
    try { await action() }
    catch (error) { cleanupErrors.push({ name, error: errorDetail(error) }); console.error('Cleanup failure:', name, error) }
  }
  await cleanup('failure screenshot', async () => {
    if (primaryError && sessionId && cdp?.socket.readyState === WebSocket.OPEN) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      writeFileSync(join(root, 'failure.png'), Buffer.from(shot.data, 'base64'))
    }
  })
  await cleanup('cdp', () => cdp?.close())
  const stop = async name => {
    const state = owned.get(name)
    if (!state?.child) return
    assert.equal(state.stopAttempted, false, 'stop once per acquired handle')
    state.stopAttempted = true
    try { await stopOwnedChild(state.child); state.confirmed = true }
    catch (error) {
      const result = error.stopResult
      state.stopResult = result
      state.confirmed = result?.brand === 'isolated-local-services.stop' && result.version === 1 && result.termination === 'confirmed'
      throw error
    }
  }
  await cleanup('chrome', () => stop('chrome'))
  const chromeStopped = !owned.has('chrome') || owned.get('chrome').confirmed
  await cleanup('profile', () => { if (profile && chromeStopped) rmSync(profile, { recursive: true, force: true }) })
  await cleanup('server', () => stop('server'))
  // Release local references independently even when termination is unknown.
  // This neither signals nor retries ownership and never earns exit credit.
  for (const [name, state] of owned) {
    const child = state.child
    if (!child || state.confirmed) continue
    const releaseErrors = []
    const record = error => releaseErrors.push(error)
    child.on('error', record)
    const streams = [...new Set(child.stdio ?? [])].filter(Boolean)
    for (const stream of streams) stream.on('error', record)
    await cleanup(name + ' IPC', () => { if (child.connected) child.disconnect() })
    for (const [index, stream] of streams.entries()) await cleanup(name + ' stdio ' + index, () => stream.destroy())
    await cleanup(name + ' unref', () => child.unref())
    await new Promise(resolve => setImmediate(resolve))
    for (const error of releaseErrors) cleanupErrors.push({ name: name + ' release event', error: errorDetail(error) })
    // Leave collectors on released handles until close; they hold no loop ref.
    child.once('close', () => {
      child.off('error', record)
      for (const stream of streams) stream.off('error', record)
    })
  }
  await cleanup('database', () => db?.close())
  await cleanup('log', () => { if (root) {
    writeFileSync(join(root, 'server.log'), log.join(''))
    writeFileSync(join(root, 'outcome.json'), JSON.stringify({ primaryError: primaryError?.stack, primary: errorDetail(primaryError), cleanupErrors, root, profile, chromeStopped, policy: 'retain synthetic root/logs for external archive; reclaim only after all attempted acquisitions confirmed', owned: Object.fromEntries([...owned].map(([name, state]) => [name, { attempted: state.attempted, pid: state.child?.pid, stopAttempted: state.stopAttempted, confirmed: state.confirmed, stopResult: state.stopResult }])) }, null, 2))
  } })
  process.off('SIGINT', serveSignal)
  process.off('SIGTERM', serveSignal)
}
if (primaryError || cleanupErrors.length) process.exitCode = 1
