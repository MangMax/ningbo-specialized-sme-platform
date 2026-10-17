#!/usr/bin/env node
/** Functional acceptance only: fresh synthetic DB/files, private Chrome profile, no visual CI.
 * pnpm build && node scripts/verify-ocr-preview.mjs
 * node scripts/verify-ocr-preview.mjs --serve  (manual T3/oil-ui inspection; Ctrl-C stops)
 * Chrome CDP follows the repository's isolated-browser verification workflow and allows
 * actual prefers-reduced-motion emulation, which the T3 preview appearance tool lacks.
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, 15000)
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
  for (const file of ['workbench-97.pdf', 'second.pdf']) {
    const response = await fetch(`${base}/api/pdf-pages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, dpi: 72 }) })
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
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        if (await ev(expression)) return
        await sleep(60)
      }
      throw new Error(`Condition timed out: ${expression}`)
    }
    const click = label => ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!b || b.disabled) throw new Error('Button unavailable: '+${JSON.stringify(label)}); b.click(); })()`)
    const fill = async (selector, value) => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
      return ev(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Input missing'); Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    }
    const navigate = async (file = 'workbench-97.pdf', page = 1) => {
      await cdp.send('Page.navigate', { url: `${base}/ocr?file=${file}&page=${page}` }, sid)
      await wait(`document.querySelector('[aria-label="当前文件与页号"]')?.textContent.includes('第 ${page} 页 /') && document.querySelector('ul[role="list"] li')`)
    }
    await cdp.send('Runtime.enable', {}, sid)
    await cdp.send('Page.enable', {}, sid)
    await cdp.send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
    const requests = [], failures = [], external = [], completed = new Set()
    let failWrite = false, failRead = false, held = null, holdRead = false
    cdp.onEvent = m => {
      if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') completed.add(m.params.requestId)
      if (m.method !== 'Fetch.requestPaused') return
      const { requestId, request } = m.params
      const url = new URL(request.url)
      const api = url.pathname === '/api/ocr-results'
      if (api) requests.push({ method: request.method, url: request.url, body: request.postData })
      if (!request.url.startsWith(base)) external.push(request.url)
      if (api && holdRead && request.method === 'GET' && url.searchParams.get('file') === 'workbench-97.pdf') { held = { requestId, networkId: m.params.networkId }; holdRead = false; return }
      const fail = api && ((failWrite && request.method === 'POST') || (failRead && request.method === 'GET'))
      cdp.send(fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId, ...(fail ? { errorReason: 'Failed' } : {}) }, sid).catch(e => failures.push(String(e)))
    }
    await cdp.send('Network.enable', {}, sid)
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid)
    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: false }, sid)
      for (const motion of ['no-preference', 'reduce']) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] }, sid)
        await navigate()
        await wait("document.querySelector('td[rowspan=\"2\"]')?.textContent === '宁波甲企业'")
        await wait("[...document.querySelectorAll('ul[role=list] li img')].some(img=>img.complete && img.naturalWidth>0)")
        assert.equal(await ev("matchMedia('(prefers-reduced-motion: reduce)').matches"), motion === 'reduce')
        assert.equal(await ev("document.querySelectorAll('ul[role=\"list\"] .content-preview').length"), 1)
        assert.equal(await ev("!!document.querySelector('.content-preview script,.content-preview iframe,.content-preview img') || !!window.__ocrExecuted"), false)
        const writesBefore = requests.filter(r => r.method !== 'GET').length
        await click('查看源码')
        await wait("document.querySelector('.content-preview pre')?.textContent.includes('<table>')")
        await click('复制原文')
        await wait("document.body.innerText.includes('已复制原文')")
        assert.equal(await ev('navigator.clipboard.readText()'), source)
        await click('深色主题')
        assert.equal(await ev("document.querySelector('.content-preview').dataset.theme"), 'dark')
        await click('渲染预览')
        await wait("document.querySelector('td[rowspan=\"2\"]')")
        // Long tables scroll locally at both widths; their container receives a real scroll.
        assert.equal(await ev("(() => { const el=[...document.querySelectorAll('.safe-preview-html')].find(e=>e.scrollWidth>e.clientWidth); if(!el)return false; el.scrollLeft=200; return el.scrollLeft>0; })()"), true)
        await ev("document.querySelector('[aria-label=\"放大看第 1 页\"]').click()")
        await wait("document.querySelector('[role=dialog] td[rowspan=\"2\"]')")
        await wait("[...document.querySelectorAll('[role=dialog] img')].some(img=>img.complete && img.naturalWidth>0)")
        if (motion === 'reduce') {
          assert.deepEqual(await ev("[...document.querySelectorAll('[data-slot=dialog-overlay],[role=dialog]')].flatMap(e=>e.getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({name:a.animationName,property:a.transitionProperty,target:a.effect.target.outerHTML.slice(0,400)})))"), [], 'comparison dialog still animates under reduce')
        }
        await ev("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='查看源码').click()")
        await wait("document.querySelector('[role=dialog] pre')")
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid)
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid)
        await wait("!document.querySelector('[role=dialog]')")
        if (motion === 'reduce') {
          assert.deepEqual(await ev("[...document.querySelectorAll('[data-slot=dialog-overlay]')].flatMap(e=>e.getAnimations().filter(a=>a.playState==='running').map(a=>a.animationName))"), [], 'comparison close still animates under reduce')
        }
        assert.equal(requests.filter(r => r.method !== 'GET').length, writesBefore)
        assert.deepEqual(snapshot(), before, 'display-only operations mutated data')
        assert.deepEqual(fileDigests(), filesBefore, 'display-only operations mutated source/page images')
        await click('编辑')
        await wait("document.activeElement?.tagName==='TEXTAREA'")
        assert.equal(await ev("document.querySelector('textarea').value"), source)
        if (motion === 'reduce') {
          assert.equal(await ev("document.querySelector('ul[role=\"list\"] li').getAnimations({subtree:true}).some(a=>a.playState==='running')"), false)
        }
        await fill('textarea', source + '\n校对草稿')
        await ev("[...document.querySelectorAll('li button')].find(b=>b.textContent.includes('second.pdf')).click()")
        await wait("document.body.innerText.includes('未保存')")
        assert.equal(await ev("document.querySelector('textarea').value"), source + '\n校对草稿')
        await click('取消')
        await wait("document.activeElement?.textContent.trim()==='编辑'")
        console.log(JSON.stringify({ width, motion, displayAndCancel: 'passed' }))
      }
    }
    // Both write and readback failure paths use real UI and intercepted transport failures.
    await click('编辑')
    await fill('textarea', source + '\n已校对')
    failWrite = true
    await click('保存')
    await wait("document.body.innerText.includes('保存失败') && !document.querySelector('textarea').readOnly")
    assert.equal(await ev("document.querySelector('textarea').value"), source + '\n已校对')
    failWrite = false; failRead = true
    await click('保存')
    await wait("document.body.innerText.includes('已提交') && document.body.innerText.includes('读回失败') && !document.querySelector('textarea').readOnly")
    failRead = false
    await click('保存')
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('保存完成')")
    await navigate()
    await wait("document.body.innerText.includes('已校对')")
    await click('编辑'); await fill('textarea', ''); await click('保存')
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('空结果') && document.body.innerText.includes('正文为空')")
    await navigate()
    await wait("document.body.innerText.includes('正文为空')")
    // Restore the synthetic target so final before/after comparison covers every other field.
    await click('编辑'); await fill('textarea', source); await click('保存')
    await wait("!document.querySelector('textarea') && document.body.innerText.includes('宁波甲企业')")
    await navigate('workbench-97.pdf', 97)
    await wait("document.querySelector('.content-preview h1')?.textContent==='第97页'")
    await click('查看源码')
    assert.equal(await ev("document.querySelectorAll('ul[role=\"list\"] .content-preview').length"), 1)
    await navigate('second.pdf')
    await wait("document.querySelector('.content-preview h1')?.textContent==='第二文件'")
    holdRead = true
    await ev("[...document.querySelectorAll('li button')].find(b=>b.textContent.includes('workbench-97.pdf')).click()")
    const heldDeadline = Date.now() + 15000
    while (!held && Date.now() < heldDeadline) await sleep(50)
    assert.ok(held, 'old file request did not reach transport')
    await ev("[...document.querySelectorAll('li button')].find(b=>b.textContent.includes('second.pdf')).click()")
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
