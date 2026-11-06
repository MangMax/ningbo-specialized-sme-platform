#!/usr/bin/env node
/**
 * RL-10 的**真浏览器验收**:`nuxt build` → 起 `.output/server/index.mjs` → 真 Chrome
 * 按**桌面 1440×900 与窄屏 390×844** 各量一遍 → 点进去、跳过去、退回来。
 *
 * ── 为什么必须真浏览器 ──────────────────────────────────────────────────
 * 这一票要证的不是「某函数返回了 8」,而是三件只有真浏览器才成立的事:
 *  ① 台账/详情面板上**真的画出了**页码,并且它是一个**可点的链接**;
 *  ② 点下去**真的打开了那一页**(页图 `<img>` 的 `naturalWidth > 0` —— 图真的解码了,
 *     不是占位符);③ 从预览**返回**后台账的筛选与展开位置**原样还在**。
 * vitest 跑在裸 node 下(`environment: 'node'`),没有排版引擎、没有导航,量不出这些。
 *
 * 单元测试守「决定」,这个脚本守页码与返回链的浏览器事实;Chrome 走 CDP,
 * 连接用 Node 24 内置 `WebSocket`,零新依赖。
 *
 * ── 断言「会红」的自检(必须先做)──────────────────────────────────────
 * 这些断言**不是**只要页面能打开就绿。两种复原缺陷的红都实测过:
 *  ① **数据侧复原**:把 `--db` 指向**补页码之前**的库(每行 `page` 都是 NULL),
 *     `① 面板出现「第 8 页」链接` 与 `② 页图 p008 加载出来` 立刻红 —— 证明断言不是空转;
 *  ② **代码侧复原**:把 `RosterEnterprisePanel.vue` 里的 `<NuxtLink :to="pageHref(v)">`
 *     换回 `<span>第 {{ v.page }} 页</span>`,`①` 的 href 断言立刻红。
 *  没做这一步的验收,绿灯只说明「页面打开了」,不说明「这个功能在」。
 *
 * 上述为历史作者陈述，pin bc764574 / blob 229ec5be，本次未复跑历史库。
 * 历史复原须从该 pin 提取脚本，并另行提供隔离来源根和 SQLite 一致快照；
 * 当前入口不再接受 --db 或环境业务路径，不执行历史库复原。
 * 当前用法: node scripts/verify-evidence-page-jump.mjs [--skip-build] [--port 0]
 * 当前默认原文 reader 与派生页图是两个独立 oracle。
 * --oracle-control 仅运行合成 DOM 灵敏度控制，不代表应用通过。
 * --fault 为受控反例（见 faults）；预期非零，不能充当正常验收。
 * 退出码:0 = 所选 lane 通过;1 = 断言/环境失败;130/143 = 信号退出。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'
import archiver from 'archiver'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { reserveLoopbackPort, spawnOwnedChild, stopOwnedChild, waitForHttp, waitForChromeDevTools } from './lib/isolated-local-services.mjs'

const args = process.argv.slice(2)
const option = (key, fallback) => {
  const i = args.indexOf(`--${key}`)
  if (i < 0) return fallback
  assert(args[i + 1] && !args[i + 1].startsWith('--'), `Missing --${key} value`)
  return args[i + 1]
}
const PDF = 'jxj/announcement/2026/evidence-eight.pdf'
const WORD = 'jxj/announcement/2026/evidence-word.docx'
const NAME = '合成跳页企业'
const RETURN = '/?q=%E5%90%88%E6%88%90%E8%B7%B3%E9%A1%B5%E4%BC%81%E4%B8%9A&expand=204'
const hash = data => createHash('sha256').update(data).digest('hex')
const fault = option('fault', '')
const faults = ['wrong-file', 'page80', 'span', 'return-collapsed', 'return-scroll', 'list-scroll', 'drawer-focus', 'word-failed', 'before-start', 'attach', 'chrome-exit']
assert(!fault || faults.includes(fault), 'Unknown fault')
let root, server, chrome, builder, cdp, db, baseline, sourceHashes, base, interrupted
const failures = []
const children = []
const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = signal
  abort.abort(new Error(signal))
  cdp?.close()
})
function alive(child) { return child && child.exitCode === null && child.signalCode === null }
async function until(label, probe, timeout = 30_000) {
  const end = Date.now() + timeout
  do {
    if (interrupted) throw new Error(interrupted)
    if (await probe()) return
    await sleep(100, undefined, { signal: abort.signal })
  } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}
function own(cmd, argv, env) {
  const child = spawnOwnedChild(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.on('error', error => { failures.push(`spawn: ${error.message}`) })
  child.stdout.on('data', data => process.stdout.write(data))
  child.stderr.on('data', data => process.stderr.write(data))
  console.log(JSON.stringify({ resource: 'child', pid: child.pid, cmd, argv }))
  return child
}
// A legal PDF with xref offsets, eight distinct pages, and an independently
// recognizable magenta square only on page 8. No PDF production helper oracle.
function pdfBytes() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count 8 /Kids [${Array.from({length:8}, (_, i) => `${4+i*2} 0 R`).join(' ')}] >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (let page = 1; page <= 8; page++) {
    const stream = `1 1 1 rg 0 0 400 400 re f\n${page === 8 ? '1 0 1' : '0 1 1'} rg 100 100 200 200 re f\n${page === 8 ? '0 0 0 rg 20 20 40 40 re f' : ''}\n0 0 0 rg BT /F1 20 Tf 30 350 Td (SYNTHETIC PAGE ${page} OF 8) Tj ET\n`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+(page-1)*2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`)
  }
  let text = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((value, i) => { offsets.push(Buffer.byteLength(text)); text += `${i+1} 0 obj\n${value}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('')
  return Buffer.from(text + `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}
async function fixture() {
  mkdirSync(join(root, 'files/jxj/announcement/2026'), { recursive: true })
  mkdirSync(join(root, 'incoming'))
  writeFileSync(join(root, 'curated.json'), '{}')
  writeFileSync(join(root, 'reconcile.json'), '{}')
  writeFileSync(join(root, 'files', PDF), pdfBytes())
  const zip = archiver('zip'); const out = createWriteStream(join(root, 'files', WORD))
  const finished = new Promise((res, rej) => { out.on('close', res); out.on('error', rej); zip.on('error', rej) })
  zip.pipe(out)
  zip.append('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', { name: '[Content_Types].xml' })
  zip.append('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', {name:'_rels/.rels'})
  zip.append('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SYNTHETIC WORD EVIDENCE</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>', {name:'word/document.xml'})
  await zip.finalize(); await finished
  db = new Database(join(root, 'roster.db'))
  migrate(drizzle(db), { migrationsFolder: 'db/migrations' })
  db.exec("INSERT INTO title VALUES ('little_giant','专精特新“小巨人”','national',1),('specialized_sme','专精特新中小企业','municipal',2),('innovative_sme','创新型中小企业','municipal',3)")
  for (const [id, name, file, page] of [[204, NAME, PDF, 8], [6, '合成待核企业', PDF, null], [715, '合成Word企业', WORD, null]]) {
    db.prepare('INSERT INTO enterprise(id,name,name_norm) VALUES(?,?,?)').run(id,name,name)
    db.prepare("INSERT INTO record(id,enterprise_id,title_code,source) VALUES(?,?,'specialized_sme','jxj')").run(id,id)
    db.prepare("INSERT INTO record_event(id,record_id,event_type,year) VALUES(?,?,'award',2026)").run(id,id)
    db.prepare('INSERT INTO record_evidence(id,record_event_id,source_file,attachment,list_no,page) VALUES(?,?,?,\'合成附件\',6,?)').run(id,id,file,page)
  }
  // Real, valid business rows provide scroll extent; no spacer DOM is injected.
  for (let i = 0; i < 24; i++) {
    const id = 1000 + i
    const name = `${NAME}${String(i).padStart(2, '0')}`
    db.prepare('INSERT INTO enterprise(id,name,name_norm) VALUES(?,?,?)').run(id,name,name)
    db.prepare("INSERT INTO record(id,enterprise_id,title_code,source) VALUES(?,?,'specialized_sme','jxj')").run(id,id)
    db.prepare("INSERT INTO record_event(id,record_id,event_type,year) VALUES(?,?,'award',2026)").run(id,id)
    db.prepare("INSERT INTO record_event(id,record_id,event_type,year) VALUES(?,204,'award',?)").run(2000+i,2000+i)
  }
  for (const [index, file] of [PDF, WORD].entries()) {
    const data = readFileSync(join(root, 'files', file))
    db.prepare('INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,source,kind,year,created_at) VALUES(?,?,?,?,?,?,\'jxj\',\'announcement\',2026,\'2026-11-07T00:00:00Z\')').run(index+1,file,file.split('/').at(-1),file.split('.').at(-1),data.length,hash(data))
  }
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('integrity_check', {simple:true}), 'ok')
  sourceHashes = [PDF, WORD].map(file => hash(readFileSync(join(root, 'files', file))))
  baseline = snapshot()
}
function snapshot() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()])
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.pending = new Map(); this.seq = 0
    ws.addEventListener('message', ({data}) => {
      const msg = JSON.parse(data); const p = this.pending.get(msg.id)
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result) }
    })
    ws.addEventListener('close', () => this.rejectAll())
    ws.addEventListener('error', () => this.rejectAll())
  }
  rejectAll() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP closed')) } this.pending.clear() }
  close() { this.rejectAll(); this.ws.close() }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)) }, 10_000)
      this.pending.set(id, {resolve,reject,timer})
      try { this.ws.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})})) }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err) }
    })
  }
}
async function attach(url) {
  const ws = new WebSocket(url)
  try {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => { ws.close(); rej(new Error('CDP attach timeout')) }, 5000)
      ws.addEventListener('open', () => { clearTimeout(timer); res() }, {once:true})
      ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP attach failed')) }, {once:true})
    })
    return new Cdp(ws)
  } catch (error) { ws.close(); throw error }
}
// Scope is the exact source label's evidence container, never a whole-page match.
const row = file => `([...document.querySelectorAll('[data-testid="official-evidence"]')].find(e => [...e.querySelectorAll('p')].some(p => p.textContent.trim() === '原路径：' + ${JSON.stringify(file)})) ?? [...document.querySelectorAll('[data-testid="enterprise-evidence"] li')].find(e => e.querySelector('p[title]')?.getAttribute('title') === ${JSON.stringify(file)}) ?? [...document.querySelectorAll('span')].find(e => e.textContent.trim() === ${JSON.stringify(file)})?.parentElement)`
const link = file => `([...(${row(file)}?.querySelectorAll('a') || [])].filter(a => a.textContent.trim() === '第 8 页'))`
async function page(width, url, task) {
  const {targetId} = await cdp.send('Target.createTarget', {url:'about:blank'})
  let sessionId
  try {
    ;({sessionId} = await cdp.send('Target.attachToTarget', {targetId,flatten:true}))
    const send = (method, params) => cdp.send(method,params,sessionId)
    const ev = async expression => {
      const result = await send('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true})
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const wait = (label, expression) => until(label, () => ev(expression))
    const click = async (expression, beforeDispatch) => {
      let point, previous, stable = 0
      await until('click visible and stable', async () => {
      point = await ev(`(() => { const e = ${expression}; if (!e || !e.matches('a,button,[role=tab]')) throw Error('Expected clickable element'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); if(!r.width || !r.height) throw Error('Not visible'); const x=r.x+r.width/2,y=r.y+r.height/2; return {x,y,hit:e.contains(document.elementFromPoint(x,y))}; })()`)
      stable = point.hit && previous && Math.abs(previous.x-point.x)<0.5 && Math.abs(previous.y-point.y)<0.5 ? stable+1 : 0
      previous=point; return stable>=3
      })
      if (beforeDispatch) await beforeDispatch()
      delete point.hit
      await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
    }
    await send('Emulation.setDeviceMetricsOverride', {width,height:width===390?844:900,deviceScaleFactor:1,mobile:false})
    await send('Page.enable', {})
    await send('Page.navigate', {url:base+url})
    await task({ev,wait,click,send})
  } catch (error) {
    if (sessionId && alive(chrome)) {
      try {
        const screen = await cdp.send('Page.captureScreenshot', {format:'png'},sessionId)
        writeFileSync(join(root, `failure-${width}-${Date.now()}.png`),Buffer.from(screen.data,'base64'))
        const state = await cdp.send('Runtime.evaluate', {expression:'document.body.innerText',returnByValue:true},sessionId)
        console.error('PAGE STATE',state.result.value)
        const observed = await cdp.send('Runtime.evaluate', {expression:`JSON.stringify({url:location.href,scrollY,tableScroll:document.querySelector('[data-testid="enterprise-table-scroll"]')?.scrollTop,active:{tag:document.activeElement?.tagName,id:document.activeElement?.id},disclosures:[...document.querySelectorAll('#record-event-204 button')].map(b=>({text:b.textContent.trim(),expanded:b.getAttribute('aria-expanded')})),saved:sessionStorage.getItem('roster:evidence-preview-return')})`,returnByValue:true},sessionId)
        writeFileSync(join(root, `failure-state-${width}-${Date.now()}.json`),observed.result.value)
        console.error('FAILURE OBSERVATION',observed.result.value)
      } catch (captureError) { console.error('Capture failure',captureError.message) }
    }
    throw error
  } finally {
    if (alive(chrome) && cdp.ws.readyState === WebSocket.OPEN) await cdp.send('Target.closeTarget', {targetId})
  }
}
async function assertLink(ev, expectedReturn) {
  const hits = await ev(`${link(PDF)}.map(a => ({href:a.href,text:a.textContent.trim()}))`)
  assert.equal(hits.length,1,'unique source-scoped clickable page link')
  const url = new URL(hits[0].href)
  assert.equal(url.origin,base); assert.equal(url.pathname,'/preview')
  assert.deepEqual(url.searchParams.getAll('file'),[PDF], 'exact source file')
  assert.deepEqual(url.searchParams.getAll('page'),['8'], 'exact page 8')
  assert.deepEqual(url.searchParams.getAll('back'),[expectedReturn], 'exact return URL')
}
async function original({ev,wait,send}) {
  await wait('original actual 8 / 8', `document.querySelector('[aria-label="当前实际页"]')?.textContent.trim() === '8 / 8'`)
  await wait('original page 8 decoded', `document.querySelector('[aria-label="PDF 第 8 页"] img')?.naturalWidth > 0`)
  assert(await ev(`(() => { const i=document.querySelector('[aria-label="PDF 第 8 页"] img'); const r=i.getBoundingClientRect(); const c=document.createElement('canvas'); c.width=i.naturalWidth;c.height=i.naturalHeight; const x=c.getContext('2d');x.drawImage(i,0,0);const p=x.getImageData(c.width/2,c.height/2,1,1).data; return r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth && p[0]>240 && p[1]<15 && p[2]>240; })()`),'visible page 8 has independent magenta center')
  const shot = await send('Page.captureScreenshot',{format:'png'})
  writeFileSync(join(root,`original-direct-${await ev('innerWidth')}.png`),Buffer.from(shot.data,'base64'))
}
const trigger = `[...document.querySelectorAll('[data-testid="enterprise-name-trigger"]')].find(b=>b.textContent.trim()===${JSON.stringify(NAME)})`
const tableScroll = `document.querySelector('[data-testid="enterprise-table-scroll"]')`
const fullDetail = `[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='完整企业页')`
const noOverflow = 'document.documentElement.scrollWidth <= document.documentElement.clientWidth'
async function checkChain(width) {
  await page(width,RETURN.replace('&expand=204',''),async api => {
    const {ev,wait,click,send} = api
    await wait('real list trigger', `!!${trigger}`)
    assert(await ev(`document.querySelectorAll('[data-testid="enterprise-name-trigger"]').length >= 20 && !document.body.innerText.includes('合成待核企业') && !document.body.innerText.includes('合成Word企业')`),'actual nontrivial filtered result')
    await click(trigger)
    await wait('drawer ready', `!!${fullDetail}`)
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await wait('drawer closed', `!document.querySelector('[role="dialog"]')`)
    if (fault === 'drawer-focus') await ev('document.activeElement.blur()')
    await wait('drawer close restores actual list button focus', `document.activeElement === ${trigger}`)
    await click(trigger)
    await wait('drawer reopened', `!!${fullDetail} && new URL(location.href).searchParams.get('expand')==='204'`)
    // Background list scroll is independently saved by the existing drawer link.
    await ev(`${tableScroll}.scrollTop = 360`)
    const listPosition = await ev(`({y:scrollY,top:${tableScroll}.scrollTop})`)
    assert(listPosition.top > 100, 'nonzero list scroll precondition')
    const listReturn = await ev('location.pathname+location.search')
    const expectedDetail = '/enterprises/204?back=' + encodeURIComponent(listReturn.slice(2))
    assert.equal(await ev(`new URL(${fullDetail}.href).pathname+new URL(${fullDetail}.href).search`),expectedDetail)
    await click(fullDetail)
    await wait('clicked exact detail',`location.pathname+location.search===${JSON.stringify(expectedDetail)}`)
    await detail(api, PDF, 204)
    if (fault === 'wrong-file' || fault === 'page80') await ev(`(() => { const a=${link(PDF)}[0]; const u=new URL(a.href); u.searchParams.set('${fault === 'wrong-file' ? 'file' : 'page'}','${fault === 'wrong-file' ? 'wrong/p008.pdf' : '80'}'); a.href=u.href; })()`)
    if (fault === 'span') await ev(`(() => {const a=${link(PDF)}[0];const s=document.createElement('span');s.textContent=a.textContent;a.replaceWith(s)})()`)
    await assertLink(ev,expectedDetail)
    let position
    await click(`${link(PDF)}[0]`, async () => {
      position = await ev(`({y:scrollY,top:${link(PDF)}[0].getBoundingClientRect().top})`)
      assert(position.y > 100, 'nonzero detail scroll precondition')
      console.log('CHAIN PRECONDITIONS',JSON.stringify({width,listReturn,expectedDetail,listPosition,position}))
    })
    await wait('clicked preview',`location.pathname === '/preview'`)
    const previewUrl = new URL(await ev('location.href'))
    assert.deepEqual(previewUrl.searchParams.getAll('file'),[PDF])
    assert.deepEqual(previewUrl.searchParams.getAll('page'),['8'])
    assert.deepEqual(previewUrl.searchParams.getAll('back'),[expectedDetail])
    const savedPosition = await ev(`JSON.parse(sessionStorage.getItem('roster:evidence-preview-return') || '[]').find(x=>x.back===${JSON.stringify(expectedDetail)})`)
    assert(savedPosition && savedPosition.scrollY > 100, 'real detail click saved nonzero return position')
    assert.equal(savedPosition.scrollY, position.y, 'handler saved independently measured click position')
    await original(api)
    assert(await ev(noOverflow), 'preview no horizontal overflow')
    const shot = await send('Page.captureScreenshot',{format:'png'})
    writeFileSync(join(root,`original-${width}.png`),Buffer.from(shot.data,'base64'))
    if (fault === 'return-collapsed') await ev(`sessionStorage.removeItem('roster:enterprise-detail-open-evidence')`)
    if (fault === 'return-scroll' || fault === 'list-scroll') await ev(`(() => {const key='roster:evidence-preview-return'; const states=JSON.parse(sessionStorage.getItem(key)); sessionStorage.setItem(key,JSON.stringify(states.map(s=>s.back===${JSON.stringify(fault === 'return-scroll' ? expectedDetail : listReturn)}?{...s,scrollY:0,scrollTop:0}:s)))})()`)
    await click(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='返回企业详情')`)
    await wait('return detail URL exact',`location.pathname+location.search === ${JSON.stringify(expectedDetail)}`)
    await wait('returned detail expansion',`${row(PDF)}?.textContent.includes('合成附件')`)
    await assertLink(ev,expectedDetail)
    await wait('detail nonzero position restored',`scrollY>100 && Math.abs(scrollY-${position.y})<5 && Math.abs((${link(PDF)}[0]?.getBoundingClientRect().top ?? -9999)-${position.top})<5`)
    assert(await ev(noOverflow),'returned detail no horizontal overflow')
    // There is no route-return anchor-focus contract. Only drawer close has one.
    await click(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='企业列表' && new URL(a.href).pathname+new URL(a.href).search===${JSON.stringify(listReturn)})`)
    await wait('return list URL exact',`location.pathname+location.search===${JSON.stringify(listReturn)}`)
    await wait('returned selected enterprise drawer',`!!${fullDetail} && document.querySelector('[role="dialog"]')?.textContent.includes('${NAME}')`)
    assert(await ev(`document.querySelectorAll('[data-testid="enterprise-name-trigger"]').length>=20 && !document.body.innerText.includes('合成待核企业') && !document.body.innerText.includes('合成Word企业')`),'returned actual filter results')
    await wait('list nonzero position restored',`${tableScroll}?.scrollTop>100 && Math.abs(${tableScroll}.scrollTop-${listPosition.top})<5 && Math.abs(scrollY-${listPosition.y})<5`)
    // A returned drawer enters with a transform. Measure the settled layout,
    // not a scheduler-dependent frame during its native enter animation.
    const drawerLayout = await ev(`(async () => {
      const drawer=document.querySelector('[role="dialog"][data-testid="enterprise-drawer"]');
      if(!drawer) throw new Error('returned drawer missing before layout gate');
      const sample=()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,right:drawer.getBoundingClientRect().right});
      const before=sample(); let timer;
      const sameDrawer=()=>{if(!drawer.isConnected || document.querySelector('[role="dialog"][data-testid="enterprise-drawer"]')!==drawer) throw new Error('returned drawer replaced during layout gate')};
      try {
        await Promise.race([
          (async()=>{
            await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
            sameDrawer();
            const animations=drawer.getAnimations();
            await Promise.all(animations.map(a=>a.finished));
            await new Promise(requestAnimationFrame);
            sameDrawer();
            if(drawer.getAnimations().some(a=>a.pending || a.playState==='running')) throw new Error('returned drawer animation changed during layout gate');
          })(),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('returned drawer layout gate timed out')),3000)})
        ]);
        return {before,after:sample()};
      } finally {clearTimeout(timer)}
    })()`)
    console.log('RETURNED DRAWER LAYOUT',JSON.stringify({width,...drawerLayout}))
    assert(await ev(`location.pathname+location.search===${JSON.stringify(listReturn)}`),'settled list URL exact')
    assert(await ev(`!!${fullDetail} && document.querySelector('[role="dialog"]')?.textContent.includes('${NAME}')`),'settled selected enterprise drawer')
    assert(await ev(`document.querySelectorAll('[data-testid="enterprise-name-trigger"]').length>=20 && !document.body.innerText.includes('合成待核企业') && !document.body.innerText.includes('合成Word企业')`),'settled actual filter results')
    assert(await ev(`${tableScroll}?.scrollTop>100 && Math.abs(${tableScroll}.scrollTop-${listPosition.top})<5 && Math.abs(scrollY-${listPosition.y})<5`),'settled list nonzero position restored')
    assert(await ev(noOverflow),'returned list no horizontal overflow')
    console.log('CHAIN POSITIONS',JSON.stringify({width,expectedDetail,listReturn,listPosition,position}))
  })
}
async function detail(api, file, eventId) {
  const {wait,click} = api
  const scope = eventId ? `document.querySelector('#record-event-${eventId}')` : 'document'
  await wait('detail event', `[...(${scope}?.querySelectorAll('button') || [])].some(b=>b.textContent.trim()==='来源记录')`)
  await click(`[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()==='来源记录')`)
  await wait('official disclosure', `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='正式文件与已登记出处')`)
  await click(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='正式文件与已登记出处')`)
  await wait('exact evidence row', `${row(file)}?.textContent.includes('合成附件')`)
}
async function checkDetail() {
  await page(1440,'/enterprises/204',async api => { await detail(api, PDF, 204); await assertLink(api.ev,'/enterprises/204') })
  for (const [id,file] of [[6,PDF],[715,WORD]]) await page(1440,`/enterprises/${id}`,async api => {
    await detail(api, file)
    assert.equal(await api.ev(`([...(${row(file)}?.querySelectorAll('a') || [])].filter(a=>/^第\\s*\\d+\\s*页$/.test(a.textContent.trim()))).length`),0)
    if(id===6) assert(await api.ev(`${row(file)}.textContent.includes('页码待核')`))
  })
}
async function checkOther() {
  await page(1440,`/preview?file=${encodeURIComponent(PDF)}`,async ({ev,wait}) => {
    await wait('pending PDF content ready',`document.querySelector('[aria-label="PDF 第 1 页"] img')?.naturalWidth>0`)
    assert(await ev(`document.body.innerText.includes('来源页码待核')`))
  })
  await page(1440,`/preview?file=${encodeURIComponent(PDF)}&page=999`,async ({ev,wait}) => {
    await wait('out of range notice',`document.body.innerText.includes('来源第 999 页不存在。该 PDF 共 8 页')`)
    assert(await ev(`!document.body.innerText.includes('已定位来源第 999 页') && document.querySelector('[aria-label="当前实际页"]')?.textContent.trim() !== '999 / 8'`))
  })
  await page(1440,`/preview?file=${encodeURIComponent(WORD)}&page=5`,async ({ev,wait}) => {
    await wait('Word content ready (not error/loading)',`!!document.querySelector('.preview-ready canvas')`)
    assert(await ev(`document.querySelector('.preview-ready canvas').width > 0 && !document.body.innerText.includes('来源第 5 页') && !document.body.innerText.includes('第 5 页')`),'Word ready without fictional source page')
  })
}
async function oracleControls() {
  await page(1440,'/',async ({ev,send,wait}) => {
    await wait('synthetic control document ready', `location.pathname==='/' && document.readyState==='complete'`)
    const href = '/preview?file=jxj%2Fannouncement%2F2026%2Fevidence-eight.pdf&page=8&back=%2F%3Fq%3D%25E5%2590%2588%25E6%2588%2590%25E8%25B7%25B3%25E9%25A1%25B5%25E4%25BC%2581%25E4%25B8%259A%26expand%3D204'
    const html = `<div data-testid="official-evidence"><p>原路径：jxj/announcement/2026/evidence-eight.pdf</p><p>合成附件</p><a href="${href}">第 8 页</a></div>`
    // DOM-only oracle sensitivity; this is NOT an application acceptance pass.
    await send('Page.stopLoading',{})
    await ev(`document.body.innerHTML=${JSON.stringify(html)}`)
    await assertLink(ev,RETURN)
    if(fault==='wrong-file' || fault==='page80') await ev(`(() => {const a=document.querySelector('a');const u=new URL(a.href);u.searchParams.set('${fault==='wrong-file'?'file':'page'}','${fault==='wrong-file'?'wrong/p008.pdf':'80'}');a.href=u.href})()`)
    if(fault==='span') await ev(`document.querySelector('a').outerHTML='<span>第 8 页</span>'`)
    if(fault==='return-collapsed') {
      await ev(`history.replaceState(null,'',${JSON.stringify(RETURN)}); document.querySelector('[data-testid=official-evidence]').remove()`)
      assert.equal(await ev('location.pathname+location.search'), RETURN, 'negative control preserves exact URL')
    }
    await assertLink(ev,RETURN)
    console.log('PASS synthetic DOM literal link control (not product)')
  })
}
async function derived() {
  const response = await fetch(base+'/api/pdf-pages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({file:PDF,dpi:72}),signal:AbortSignal.timeout(30000)})
  assert.equal(response.status,200,await response.text())
  await page(1440,`/preview?file=${encodeURIComponent(PDF)}&page=8&view=pages`,async ({ev,wait}) => {
    await wait('derived page8 decoded', `[...document.images].some(i=>new URL(i.src).pathname === '/api/files/jxj/announcement/2026/.evidence-eight.pdf.pages/p008.png' && i.naturalWidth>0)`)
    assert(await ev(`(() => {const i=[...document.images].find(i=>new URL(i.src).pathname === '/api/files/jxj/announcement/2026/.evidence-eight.pdf.pages/p008.png');const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;const x=c.getContext('2d');x.drawImage(i,0,0);const p=x.getImageData(c.width*0.1,c.height*0.9,1,1).data;return p[0]<20&&p[1]<20&&p[2]<20})()`),'derived page8 independent black corner marker (cache is grayscale)')
  })
}
async function main() {
  assert(!args.includes('--db'), '--db historical reproduction is not current acceptance; use historical pin only with isolated sources and a consistent SQLite snapshot')
  root = mkdtempSync(join(tmpdir(),'issue-576-'))
  console.log(JSON.stringify({resource:'root',root,mode:args.includes('--oracle-control')?'synthetic DOM oracle control':'synthetic application acceptance',fault}))
  const env = {...process.env, HOST:'127.0.0.1', NITRO_HOST:'127.0.0.1', NUXT_DB_PATH:join(root,'roster.db'), NUXT_DB_READONLY:'1', NUXT_FILES_DIR:join(root,'files'), NUXT_INCOMING_DIR:join(root,'incoming'), NUXT_CURATED_PATH:join(root,'curated.json'), NUXT_RECONCILE_PATH:join(root,'reconcile.json'), NUXT_API_TOKEN:'', NUXT_MCP_TOKEN:''}
  await fixture()
  if (fault === 'before-start') throw new Error('Injected failure before startup')
  if (!args.includes('--skip-build')) {
    builder = own('pnpm',['build'],env)
    await until('build exits',()=>!alive(builder),300_000)
    assert.equal(builder.exitCode,0,'build exit')
  }
  assert(existsSync('.output/server/index.mjs'),'Build required')
  const port = await reserveLoopbackPort(Number(option('port','0')))
  base = `http://127.0.0.1:${port}`
  server = own(process.execPath,['.output/server/index.mjs'],{...env,PORT:String(port),NITRO_PORT:String(port)})
  await until('own server listener',()=> {
    assert(alive(server),'server exited before listener')
    try { return execFileSync('lsof',['-nP','-a','-p',String(server.pid),'-iTCP:'+port,'-sTCP:LISTEN'],{encoding:'utf8'}).includes(`127.0.0.1:${port}`) } catch { return false }
  })
  await waitForHttp(base+'/api/health',{child:server,timeoutMs:15000})
  console.log(JSON.stringify({resource:'listener',pid:server.pid,base}))
  const profile = join(root,'chrome'); mkdirSync(profile)
  const bin = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  chrome = own(bin,['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-gpu','about:blank'],env)
  const version = await waitForChromeDevTools(chrome,profile)
  console.log(JSON.stringify({resource:'private-marker',pid:chrome.pid,marker:readFileSync(join(profile,'DevToolsActivePort'),'utf8')}))
  if(fault==='chrome-exit') { await stopOwnedChild(chrome); await waitForChromeDevTools(chrome,profile) }
  cdp = await attach(fault==='attach' ? new URL('/json/version',version.webSocketDebuggerUrl).href : version.webSocketDebuggerUrl)
  if(args.includes('--oracle-control')) { await oracleControls(); return }
  if(fault==='word-failed') rmSync(join(root,'files',WORD))
  // Each independent scenario reports its own failure; no timeout can become green.
  for(const [name,run] of [['desktop chain',()=>checkChain(1440)],['390 chain',()=>checkChain(390)],['detail evidence',checkDetail],['original reader direct (not click chain)',()=>page(1440,`/preview?file=${encodeURIComponent(PDF)}&page=8`,original)],['390 original reader direct (not click chain)',()=>page(390,`/preview?file=${encodeURIComponent(PDF)}&page=8`,original)],['negative previews',checkOther],['derived cache (separate oracle)',derived]]) {
    try { await run(); console.log('PASS',name) } catch(error) { failures.push(`${name}: ${error.stack}`); console.error('FAIL',name,error.message) }
    if(interrupted) break
  }
}
try { await main() } catch(error) { failures.push(error.stack); console.error(error) }
finally {
  cdp?.close()
  // Nonempty child contract; independent cleanup, including failed startup.
  for(const child of children.reverse()) {
    try { await stopOwnedChild(child); console.log('CLEAN child',child.pid) } catch(error) { failures.push(`cleanup: ${error.stack}`) }
  }
  if(db) {
    try {
      assert.deepEqual(snapshot(),baseline,'all synthetic DB rows unchanged')
      assert.deepEqual([PDF,WORD].map(file=>existsSync(join(root,'files',file)) ? hash(readFileSync(join(root,'files',file))) : null), fault==='word-failed' ? [sourceHashes[0],null] : sourceHashes, 'source bytes unchanged (only explicit Word-failure deletion permitted)')
      console.log('PASS immutable synthetic DB/source')
    } catch(error) { failures.push(error.stack) }
    db.close()
  }
  if(root) {
    try { rmSync(join(root,'chrome'),{recursive:true,force:true}) } catch(error) { failures.push(`profile cleanup: ${error.stack}`) }
    // Retained synthetic artifacts and screenshots are explicitly outside Git.
    writeFileSync(join(root,'result.json'),JSON.stringify({fault,interrupted,failures,children:children.map(c=>({pid:c.pid,exit:c.exitCode,signal:c.signalCode}))},null,2))
    console.log('ARTIFACTS',root)
  }
}
if(failures.length) console.error(failures.join('\n'))
process.exitCode = interrupted ? (interrupted==='SIGINT' ? 130 : 143) : failures.length ? 1 : 0
