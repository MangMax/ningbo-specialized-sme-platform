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
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { reserveLoopbackPort, stopOwnedChild, waitForChromeDevTools, waitForHttp } from './lib/isolated-local-services.mjs'

const root = mkdtempSync(join(tmpdir(), 'ocr-preview-48-'))
const fixture = spawnSync('uv', ['run', 'scripts/fixtures/ocr-preview.py', root], { encoding: 'utf8' })
assert.equal(fixture.status, 0, fixture.stderr)
const port = await reserveLoopbackPort()
const base = `http://127.0.0.1:${port}`
const log = []
const server = spawn(process.execPath, ['.output/server/index.mjs'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: join(root, 'roster.db'),
    NUXT_DB_READONLY: '0', NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'),
    NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', b => log.push(String(b)))
server.stderr.on('data', b => log.push(String(b)))
let chrome, cdp
const db = new Database(join(root, 'roster.db'))
const source = readFileSync(join(root, 'source.md'), 'utf8')
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
class Cdp {
  seq = 0; pending = new Map(); onEvent = () => {}
  constructor(socket) {
    this.socket = socket
    socket.addEventListener('message', event => {
      const m = JSON.parse(event.data)
      if (!m.id) { this.onEvent(m); return }
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id); clearTimeout(p.timer)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
}
try {
  await waitForHttp(`${base}/ocr`, { child: server })
  // Warm app migrations/reference seeds before measuring read-only interactions.
  const files = await fetch(`${base}/api/files`)
  assert.equal(files.status, 200, await files.text())
  // Derived page images only. No OCR job or import is invoked.
  // 200 DPI is an existing API option (72–600) and gives the A4 fixture enough
  // pixels for a 2x display without changing the server contract.
  for (const file of ['workbench-97.pdf', 'second.pdf']) {
    const response = await fetch(`${base}/api/pdf-pages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, dpi: 200 }) })
    assert.equal(response.status, 200, await response.text())
  }
  console.log(JSON.stringify({ base, root, manual: `${base}/ocr?file=workbench-97.pdf&page=1` }))
  if (process.argv.includes('--serve')) {
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  } else {
    const before = snapshot()
    const filesBefore = fileDigests()
    const chromePath = process.env.CHROME_BIN ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
    assert.ok(chromePath, 'Set CHROME_BIN')
    const profile = mkdtempSync(join(tmpdir(), 'ocr-preview-chrome-'))
    chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
    const version = await waitForChromeDevTools(chrome, profile)
    cdp = new Cdp(new WebSocket(version.webSocketDebuggerUrl))
    await new Promise((resolve, reject) => { cdp.socket.addEventListener('open', resolve, { once: true }); cdp.socket.addEventListener('error', reject, { once: true }) })
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
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
      console.error('Timeout state', await ev(`JSON.stringify({active:document.activeElement?.outerHTML.slice(0,700),rows:[...document.querySelectorAll('ul[role="list"]>li')].map(e=>e.id),page:document.querySelector('[aria-label="当前文件与页号"]')?.innerText,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(d=>d.innerText.slice(0,500)),buttons:[...document.querySelectorAll('[role="dialog"] button')].map(b=>({text:b.textContent.trim(),aria:b.getAttribute('aria-label'),disabled:b.disabled})),alerts:[...document.querySelectorAll('[role="alert"],[role="status"]')].map(e=>e.textContent)})`))
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
      await wait(`!document.querySelector('textarea')`)
    }

    await cdp.send('Runtime.enable', {}, sid)
    await cdp.send('Page.enable', {}, sid)
    await cdp.send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
    const requests = [], failures = [], external = [], completed = new Set()
    const downloads = [], finishedDownloads = new Set()
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: join(root, 'downloads'), eventsEnabled: true })
    let failWrite = false, failRead = false, held = null, holdRead = false
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
      const fail = api && ((failWrite && request.method === 'POST') || (failRead && request.method === 'GET'))
      cdp.send(fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId, ...(fail ? { errorReason: 'Failed' } : {}) }, sid).catch(e => failures.push({ error: String(e), url: request.url, networkId: m.params.networkId }))
    }
    await cdp.send('Network.enable', {}, sid)
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${base}/api/ocr-results*`, requestStage: 'Request' }] }, sid)

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

        const writesBefore = requests.filter(r => r.method !== 'GET').length
        await click('源码')
        await wait("document.querySelector('.content-preview pre')?.textContent.includes('<table>')")
        assert.ok(await ev("parseFloat(getComputedStyle(document.querySelector('.content-preview pre')).fontSize) >= 14"), 'source font below 14px')
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
        // Long tables scroll locally at both widths; the hint is visible.
        assert.equal(await ev("(() => { const el=[document.querySelector('.preview-content'),...document.querySelectorAll('.preview-content .safe-preview-html,.preview-content pre')].find(e=>e && e.scrollWidth>e.clientWidth); if(!el)return false; el.scrollLeft=200; return el.scrollLeft>0; })()"), true)
        assert.equal(await ev("!!document.querySelector('[data-ocr-horizontal-hint]')"), true)

        // Edit keeps raw Markdown, uses >=14px, and keeps save/cancel in the bar.
        await click('编辑', '[aria-label="翻页与页操作"]')
        await wait("document.activeElement?.tagName==='TEXTAREA'")
        assert.equal(await ev("document.querySelector('textarea').value"), source)
        assert.ok(await ev("parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize) >= 14"), 'editor font below 14px')
        assert.equal(await ev(`!!document.querySelector('[aria-label="翻页与页操作"] button')`), true)
        if (motion === 'reduce') {
          assert.equal(await ev("document.querySelector('ul[role=\"list\"] li').getAnimations({subtree:true}).some(a=>a.playState==='running')"), false)
        }
        await fill('textarea', source + '\n校对草稿')
        await selectFile('second.pdf')
        await wait("document.body.innerText.includes('未保存')")
        assert.equal(await ev("document.querySelector('textarea').value"), source + '\n校对草稿')
        assert.equal(await ev("new URL(location.href).searchParams.get('file')"), 'workbench-97.pdf')
        await cancel()
        assert.equal(await ev("document.activeElement?.getAttribute('aria-label')"), '编辑')
        assert.equal(await ev("document.activeElement?.closest('[aria-label=\"翻页与页操作\"]') !== null"), true)

        // Compare dialog: layout-aware copy, in-dialog paging, source/wrap, Esc focus.
        // On mobile the image pane is a tab; switch to it so the real entry is visible.
        if (width === 390) {
          await click('页图', '[data-slot="tabs-list"]')
          await wait("getComputedStyle(document.querySelector('section[aria-label=\"当前页页图\"]')).display !== 'none'")
        }
        await ev("document.querySelector('[aria-label=\"放大看第 1 页\"]').click()")
        await wait("document.querySelector('[role=dialog]')")
        await wait("[...document.querySelectorAll('[role=dialog] img')].some(img=>img.complete && img.naturalWidth>0)")
        assert.equal(await ev("document.querySelector('[role=dialog] td[rowspan=\"2\"]')?.textContent === '宁波甲企业'"), true)
        assert.equal(await ev("document.querySelector('[role=dialog] [role=dialog]') === null"), true)
        if (width === 390) assert.equal(await ev("document.querySelector('[role=dialog]').innerText.includes('上方是页图，下方是识别文本')"), true)
        else assert.equal(await ev("document.querySelector('[role=dialog]').innerText.includes('左侧是页图，右侧是识别文本')"), true)
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
        assert.equal(await ev("document.activeElement?.getAttribute('aria-label')"), '放大看第 1 页')
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
        await openFilters()
        await fill('[aria-label="实际页号或范围"]', '50-60')
        await applyFilters()
        await wait("document.body.innerText.includes('没有命中页')")
        assert.equal(await ev("(document.body.innerText.match(/清除页筛选/g) || []).length"), 1)
        await click('清除页筛选')
        await wait("document.querySelector('[aria-label=\"当前文件与页号\"]').innerText.includes('第 1 / 97 页')")

        // Jump to a page with content and verify pane scroll reset without page scroll.
        await ev("document.querySelector('.preview-content').scrollTop = 120")
        await click('跳转实际页号')
        await wait("document.querySelector('input[aria-label=\"跳转实际页号\"]')")
        await fill('input[aria-label="跳转实际页号"]', '4')
        await click('跳转', '[data-slot="popover-content"]')
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

        if (width === 390) {
          await click('页图', '[data-slot="tabs-list"]')
          await wait("getComputedStyle(document.querySelector('section[aria-label=\"当前页页图\"]')).display !== 'none'")
          assert.equal(await ev("getComputedStyle(document.querySelector('section[aria-label=\"当前页识别文本\"]')).display"), 'none')
          await click('对照', '[data-slot="tabs-list"]')
          await wait("getComputedStyle(document.querySelector('section[aria-label=\"当前页页图\"]')).display !== 'none' && getComputedStyle(document.querySelector('section[aria-label=\"当前页识别文本\"]')).display !== 'none'")
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
    await wait("document.body.innerText.includes('保存失败') && !document.querySelector('textarea').readOnly")
    assert.equal(await ev("document.querySelector('textarea').value"), source + '\n已校对')
    failWrite = false; failRead = true
    await save()
    await wait("document.body.innerText.includes('已提交') && document.body.innerText.includes('读回失败') && !document.querySelector('textarea').readOnly")
    failRead = false
    await save()
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('保存完成')")
    await navigate()
    await wait("document.body.innerText.includes('已校对')")
    await edit(); await fill('textarea', ''); await save()
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('空结果') && document.body.innerText.includes('正文为空')")
    await navigate()
    await wait("document.body.innerText.includes('正文为空')")
    // Restore the synthetic target so final before/after comparison covers every other field.
    await edit(); await fill('textarea', source); await save()
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('宁波甲企业')")

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

    // 200% browser zoom is approximated by halving the CSS viewport (720x450),
    // which is how browser zoom reflows layout. It is not a @2x screenshot.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 450, deviceScaleFactor: 1, mobile: false }, sid)
    await navigate()
    await wait("document.querySelector('td[rowspan=\"2\"]')")
    assert.equal(await ev('document.documentElement.scrollWidth <= innerWidth + 1'), true, '200% horizontal overflow')
    assert.equal(await ev('document.documentElement.scrollHeight <= innerHeight + 1'), true, '200% vertical scroll')
    assert.equal(await ev(`(() => { const r=document.querySelector('footer[aria-label="翻页与页操作"]').getBoundingClientRect(); return r.bottom <= innerHeight + 1 })()`), true, '200% bottom bar off-screen')
    await edit()
    assert.ok(await ev("parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize) >= 14"), '200% editor font below 14px')
    await cancel()
    console.log(JSON.stringify({ zoom: '720x450 CSS viewport (~200% reflow)', passed: true }))

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
    const oldTarget = before.ocr_result.find(r => r.file_id === 1 && r.page_no === 1)
    const newTarget = after.ocr_result.find(r => r.file_id === 1 && r.page_no === 1)
    assert.equal(newTarget.raw, oldTarget.raw)
    assert.equal(newTarget.markdown, oldTarget.markdown)
    // Explicit save updates channel/time, while every other row/table remains byte-for-byte equal.
    after.ocr_result[after.ocr_result.indexOf(newTarget)] = oldTarget
    assert.deepEqual(after, before)
    assert.deepEqual(fileDigests(), filesBefore)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    console.log(JSON.stringify({ writesAndReadback: 'passed', emptyReload: 'passed', lateFile: 'passed', rawAndOtherData: 'unchanged', root }))
  }
} finally {
  cdp?.socket.close()
  await stopOwnedChild(chrome)
  await stopOwnedChild(server)
  db.close()
  writeFileSync(join(root, 'server.log'), log.join(''))
}
