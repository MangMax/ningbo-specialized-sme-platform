import { mkdtempSync, rmSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import ExcelJS from 'exceljs'
import { newJobId } from '../lib/job'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { useDb, schema as s } from '../db/client'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'export-117-'))
const dbPath = join(dir, 'synthetic.db'), db = useDb({ dbPath })
let service: { baseUrl: string; stop: () => Promise<void> }
const token = 'synthetic-export-token'
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
const url = (path: string) => service.baseUrl + path
const json = (r: Response): Promise<any> => r.json()
const submit = (key: string, extra = {}) => fetch(url('/api/roster/exports/current/little-giant'), { method: 'POST', headers, body: JSON.stringify({ clientRequestId: key, ...extra }) })
async function terminal(id: string) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const job = await json(await fetch(url('/api/jobs/' + id)))
    if (['done','failed','cancelled'].includes(job.state)) return job
    await new Promise(r => setTimeout(r, 30))
  }
  throw new Error('job did not finish: ' + id)
}
async function workbook(key: string) {
  const response = await submit(key)
  expect(response.status).toBe(202)
  const accepted = await json(response)
  expect(response.headers.get('location')).toBe('/api/jobs/' + accepted.jobId)
  const job = await terminal(accepted.jobId)
  expect(job.state, JSON.stringify(job)).toBe('done')
  const download = await fetch(url(job.result.artifact.downloadUrl), { headers })
  expect(download.status).toBe(200)
  expect(download.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  expect(download.headers.get('content-disposition')).toContain('.xlsx')
  const bytes = Buffer.from(await download.arrayBuffer()), wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as any)
  return { wb, job, bytes }
}
function candidate(name: string, events: Array<{ eventType: 'award'|'review'|'nurture'|'maintain'; year: number|null; decidedYear?: number|null; reviewOutcome?: 'passed'|'failed'|null; batchSeq?: number|null }> = [{ eventType: 'award', year: new Date().getFullYear(), batchSeq: 1 }], titleCode = 'little_giant') {
  const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: 'TEST-' + name, district: '鄞州区', city: '宁波市' }).returning().get()
  const record = db.insert(s.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode, nameRaw: name }).returning().get()
  for (const e of events) {
    const event = db.insert(s.recordEvent).values({ recordId: record.id, ...e }).returning().get()
    db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'jxj/announcement/synthetic.xlsx', attachment: '名单', listNo: enterprise.id }).run()
  }
  return { enterprise, record }
}
async function startService() {
  const cwd = resolve(import.meta.dirname, '..'), port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore','pipe','pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir,'build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: token, NUXT_FILES_DIR: join(dir,'files'), NUXT_INCOMING_DIR: join(dir,'incoming') } })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(url('/api/jobs/kinds'), { timeoutMs: 60000, child }) } catch (e) { await service.stop(); throw new Error(String(e) + output) }
}
beforeAll(startService, 90000)
afterAll(async () => { if (service) await service.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
it('HTTP提交到四表文件', async () => {
  const { enterprise } = candidate('新认定')
  const { wb, job, bytes } = await workbook('fresh')
  expect(wb.worksheets.map(w => w.name)).toEqual(['有效企业','待确认','排除明细','口径说明'])
  expect(wb.getWorksheet('有效企业')!.getRow(2).getCell(2).value).toBe(String(enterprise.id))
  expect(wb.getWorksheet('有效企业')!.getRow(2).getCell(4).value).toBe('新认定')
  expect(job.result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  expect(job.result.artifact.size).toBe(bytes.length)
  expect(job.result.dataVersion).toMatch(/^sha256:/)
})
function rows(wb: ExcelJS.Workbook, sheet: string) {
  return wb.getWorksheet(sheet)!.getRows(2, Math.max(0,wb.getWorksheet(sheet)!.rowCount-1))?.map(row => row.values as any[]) ?? []
}
it('对应周期、复核年份与同年冲突', async () => {
  const y = new Date().getFullYear()
  candidate('复核延续',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'passed'}])
  candidate('失败恢复',[{eventType:'award',year:y-5,batchSeq:1},{eventType:'review',year:y-5,batchSeq:1,decidedYear:y-2,reviewOutcome:'failed'},{eventType:'award',year:y-1,batchSeq:2}])
  candidate('旧周期晚失败',[{eventType:'award',year:y-5,batchSeq:1},{eventType:'award',year:y-1,batchSeq:2},{eventType:'review',year:y-5,batchSeq:1,decidedYear:y,reviewOutcome:'failed'}])
  candidate('本周期失败',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'failed'}])
  candidate('已到复核年',[{eventType:'award',year:y-3,batchSeq:1}])
  candidate('复核结论缺年',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,reviewOutcome:'passed'}])
  candidate('同年冲突',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'failed'},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y-1,reviewOutcome:'passed'}])
  candidate('培育非资格',[{eventType:'nurture',year:y}])
  const {wb} = await workbook('cycles')
  const names = (sheet: string) => rows(wb,sheet).map(r => r[4])
  expect(names('有效企业')).toEqual(expect.arrayContaining(['复核延续','失败恢复','旧周期晚失败']))
  expect(names('排除明细')).toEqual(expect.arrayContaining(['本周期失败','培育非资格']))
  expect(names('待确认')).toEqual(expect.arrayContaining(['已到复核年','复核结论缺年','同年冲突']))
  expect(rows(wb,'有效企业').find(r => r[4] === '失败恢复')![9]).toBe(String(y-5))
  expect(rows(wb,'待确认').find(r => r[4] === '同年冲突')![13]).toContain('冲突')
})
function decision(enterpriseId: number, reasonCode: 'moved_out'|'moved_in'|'deregistered'|'renamed'|'pending_review'|'other', extra: Record<string,unknown> = {}) {
  return db.insert(s.differenceReason).values({enterpriseId,titleCode:'little_giant',direction:'extra_in_miit',status:'confirmed_reason',reasonCode,verificationStatus:'confirmed',lifecycleAction:'replace',basis:'人工确认合成主体事实',effectiveAt:'2025-01-01T00:00:00Z',recordedAt:new Date().toISOString(),...extra} as any).returning().get()
}
it('迁入、更名与旧解释缺口', async () => {
  const renamed = candidate('迁入更名现名')
  db.update(s.record).set({nameRaw:'迁入更名旧名'}).where(eq(s.record.id,renamed.record.id)).run()
  db.insert(s.enterpriseAlias).values({enterpriseId:renamed.enterprise.id,name:'迁入更名旧名',nameNorm:'迁入更名旧名',sourceKind:'manual',verificationStatus:'confirmed'}).run()
  decision(renamed.enterprise.id,'moved_in',{movedInTitleCode:'little_giant'})
  const out = candidate('已确认外迁'); decision(out.enterprise.id,'moved_out')
  const deregistered = candidate('已确认注销'); decision(deregistered.enterprise.id,'deregistered')
  const returned = candidate('迁出后迁回'); const old = decision(returned.enterprise.id,'moved_out',{recordedAt:'2025-01-01T00:00:00Z'})
  decision(returned.enterprise.id,'moved_in',{previousId:old.id,effectiveAt:'2026-01-01T00:00:00Z',movedInTitleCode:'little_giant'})
  const legacy = candidate('旧缺码前提变化'); decision(legacy.enterprise.id,'moved_out',{lifecycleAction:null,basis:null,reasonNote:'缺码无法查询'})
  const unknown = candidate('未确认旧名链'); db.update(s.record).set({nameRaw:'未经核实原名'}).where(eq(s.record.id,unknown.record.id)).run()
  const migrant = candidate('迁入无资格依据',[]); decision(migrant.enterprise.id,'moved_in',{movedInTitleCode:'little_giant',movedInYear:new Date().getFullYear()})
  const review = candidate('更新待审核'); decision(review.enterprise.id,'pending_review',{measureCode:'follow_review'})
  const other = candidate('其他称号不冒充',[]); candidate('其他称号独立',[{eventType:'award',year:new Date().getFullYear()}],'specialized_sme')
  db.insert(s.record).values({enterpriseId:other.enterprise.id,source:'jxj',titleCode:'innovative_sme',nameRaw:'其他称号不冒充'}).run()
  const {wb} = await workbook('identity')
  const eligible = rows(wb,'有效企业'), pending = rows(wb,'待确认'), excluded = rows(wb,'排除明细')
  const rename = eligible.find(r => r[4] === '迁入更名现名')!
  expect(rename[5]).toBe('迁入更名旧名'); expect(rename[6]).toBe('迁入更名旧名')
  expect(rename[13]).toContain('迁入'); expect(rename[13]).toContain('现已更名'); expect(rename[13]).not.toContain('未见宁波')
  expect(eligible.map(r => r[4])).toEqual(expect.arrayContaining(['迁出后迁回','更新待审核']))
  expect(excluded.map(r => r[4])).toEqual(expect.arrayContaining(['已确认外迁','已确认注销']))
  expect(pending.map(r => r[4])).toEqual(expect.arrayContaining(['旧缺码前提变化','未确认旧名链','迁入无资格依据','其他称号不冒充']))
  expect(pending.find(r => r[4] === '迁入无资格依据')![13]).toContain('#108')
  expect(pending.find(r => r[4] === '未确认旧名链')![12]).toBe('尚未完成公布匹配核实')
  expect([...eligible,...pending,...excluded].some(r => r[4] === '其他称号独立')).toBe(false)
})
it('去重、重生成与鉴权', async () => {
  const again = await json(await submit('fresh'))
  const list = await json(await fetch(url('/api/jobs?kind=current-roster-export')))
  expect(list.rows.filter((j:any) => j.params.clientRequestId === 'fresh')).toHaveLength(1)
  expect(list.rows.find((j:any) => j.id === again.jobId).state).toBe('done')
  const regenerated = await json(await submit('regenerated',{regenerateOf:again.jobId}))
  expect(regenerated.jobId).not.toBe(again.jobId)
  const job = await terminal(regenerated.jobId)
  expect(job.params.regenerateOf).toBe(again.jobId)
  expect((await submit('regenerated',{regenerateOf:job.id})).status).toBe(409)
  for (const body of [{clientRequestId:'bad',asOf:'2025-01-01'},{clientRequestId:'bad',titleCode:'innovative_sme'},{}]) {
    expect((await fetch(url('/api/roster/exports/current/little-giant'),{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(400)
  }
  expect((await fetch(url('/api/roster/exports/current/little-giant'),{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401)
  for (const auth of [{},{authorization:'Bearer wrong'}]) expect((await fetch(url(job.result.artifact.downloadUrl),{headers:auth as Record<string,string>})).status).toBe(401)
  expect((await fetch(url('/api/job-artifacts/not-a-path'),{headers})).status).toBe(400)
  const duplicateBytes = Buffer.from(await (await fetch(url(job.result.artifact.downloadUrl),{headers})).arrayBuffer())
  expect(createHash('sha256').update(duplicateBytes).digest('hex')).toBe(job.result.artifact.sha256)
  expect(JSON.stringify(job)).not.toContain(dir)
})
it('产物过期与缺失', async () => {
  const {job} = await workbook('expiry')
  const expired = {...job.result,artifact:{...job.result.artifact,expiresAt:'2000-01-01T00:00:00Z'}}
  db.update(s.job).set({result:expired}).where(eq(s.job.id,job.id)).run()
  const read = await json(await fetch(url('/api/jobs/' + job.id)))
  expect(read.state).toBe('done'); expect(read.result.artifact.availability).toBe('expired')
  expect((await fetch(url(job.result.artifact.downloadUrl),{headers})).status).toBe(410)
  expect(existsSync(join(dbPath+'.exports',job.id+'.xlsx'))).toBe(false)
  const missing = (await workbook('missing')).job
  rmSync(join(dbPath+'.exports',missing.id+'.xlsx'))
  expect((await json(await fetch(url('/api/jobs/' + missing.id)))).result.artifact.availability).toBe('missing')
  expect((await fetch(url(missing.result.artifact.downloadUrl),{headers})).status).toBe(404)
})
function executorPid() {
  const line = execFileSync('ps',['-Ao','pid=,args='],{encoding:'utf8'}).split('\n').find(line => line.includes(dir) && line.includes('/current-export-worker.mjs'))
  return line ? Number(line.trim().split(/\s+/)[0]) : null
}
async function executor() {
  const deadline = Date.now()+5000
  while (Date.now()<deadline) { const pid=executorPid(); if(pid) return pid; await new Promise(r=>setTimeout(r,10)) }
  throw new Error('owned executor not found')
}
it('阻塞执行、背压、取消与失败', async () => {
  db.transaction(() => { for(let i=0;i<3000;i++) candidate('资源合成'+i) })
  const first = await json(await submit('blocked-running'))
  const pid = await executor(); process.kill(pid,'SIGSTOP')
  const queued: string[]=[]
  try {
    const started = performance.now(), secondResponse = await submit('blocked-queued')
    const elapsed = performance.now()-started
    expect(secondResponse.status).toBe(202); expect(elapsed).toBeLessThan(1000)
    const second = await json(secondResponse); queued.push(second.jobId)
    const state = await json(await fetch(url('/api/jobs/'+second.jobId)))
    expect(state.state).toBe('queued'); expect(state.percent).toBeNull()
    for(let i=0;i<7;i++) { const r=await submit('capacity-'+i); expect(r.status).toBe(202); queued.push((await json(r)).jobId) }
    expect((await submit('over-capacity')).status).toBe(429)
    expect((await json(await submit('blocked-queued'))).jobId).toBe(second.jobId)
    for(const id of queued) {
      expect((await fetch(url('/api/jobs/'+id),{method:'DELETE',headers})).status).toBe(200)
      expect((await terminal(id)).state).toBe('cancelled')
      expect((await fetch(url('/api/job-artifacts/'+id),{headers})).status).toBe(404)
    }
    expect((await fetch(url('/api/jobs/'+first.jobId),{method:'DELETE',headers})).status).toBe(202)
    const cancelledJob=await terminal(first.jobId)
    expect(cancelledJob.state).toBe('cancelled');expect(cancelledJob.result.ruleVersion).toBe('current-roster-116-v5')
    expect(existsSync(join(dbPath+'.exports',first.jobId+'.part'))).toBe(false)
    expect((await fetch(url('/api/job-artifacts/'+first.jobId),{headers})).status).toBe(404)
    const failed = await json(await submit('killed-executor'))
    process.kill(await executor(),'SIGKILL')
    const failure = await terminal(failed.jobId)
    expect(failure.state).toBe('failed'); expect(failure.error).toContain('中断');expect(failure.result.ruleVersion).toBe('current-roster-116-v5')
    expect(existsSync(join(dbPath+'.exports',failed.jobId+'.part'))).toBe(false)
    expect((await fetch(url('/api/job-artifacts/'+failed.jobId),{headers})).status).toBe(404)
    writeFileSync('/tmp/spec117-controlled-timing.json',JSON.stringify({environment:process.version,resourceFixtureRows:3000,stoppedExecutorSubmitMs:elapsed,limit:9},null,2))
  } finally { try {process.kill(pid,'SIGCONT')} catch {} }
},30000)
it('万行快照与普通请求响应', async () => {
  db.transaction(() => {for(let i=3000;i<10000;i++) candidate('资源合成'+i)})
  const last = candidate('快照末项')
  const listPath='/api/roster/enterprises?pageSize=20', detailPath='/api/roster/enterprises/'+last.enterprise.id
  for(const path of [listPath,detailPath]) expect((await fetch(url(path))).status).toBe(200)
  const start=performance.now(), accepted=await submit('large-snapshot'), submitMs=performance.now()-start
  expect(accepted.status).toBe(202);expect(submitMs).toBeLessThan(1000)
  const id=(await json(accepted)).jobId
  let active:any
  for(let i=0;i<500;i++) {
    active=await json(await fetch(url('/api/jobs/'+id)))
    if(active.state==='running' && active.progress.done>=100) break
    await new Promise(r=>setTimeout(r,10))
  }
  expect(active.state).toBe('running');expect(active.progress.done).toBeLessThan(active.progress.total)
  const changed=await fetch(url('/api/roster/decision-lifecycle/commands'),{method:'POST',headers,body:JSON.stringify({enterpriseId:last.enterprise.id,titleCode:'little_giant',direction:'extra_in_miit',action:'replace',expectedCurrentId:null,idempotencyKey:'snapshot-change',actor:{type:'agent',id:'test'},basis:'隔离SQLite当前事实更新',ruleVersion:'manual-v1',effectiveAt:'2026-01-01T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'moved_out',verificationStatus:'confirmed',measureCode:'mark_moved_out'}})})
  expect(changed.status).toBe(200)
  const latencies:number[]=[]
  for(let i=0;i<4;i++) for(const path of [listPath,detailPath,'/api/files?limit=20']) {
    const t=performance.now(), response=await fetch(url(path));await response.arrayBuffer()
    latencies.push(performance.now()-t);expect(response.status).toBe(200)
  }
  expect(Math.max(...latencies)).toBeLessThan(2000)
  const job=await terminal(id);expect(job.state,JSON.stringify(job)).toBe('done')
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await (await fetch(url(job.result.artifact.downloadUrl),{headers})).arrayBuffer()) as any)
  expect(rows(wb,'有效企业').some(r=>r[4]==='快照末项')).toBe(true)
  expect(rows(wb,'有效企业').filter(r=>String(r[4]).startsWith('资源合成'))).toHaveLength(10000)
  for(const [sheet,key] of [['有效企业','eligible'],['待确认','pending'],['排除明细','excluded']]) expect(wb.getWorksheet(sheet!)!.rowCount-1).toBe(job.result.counts[key!])
  expect(job.result.executor.peakRssBytes).toBeLessThan(512*1024*1024)
  writeFileSync('/tmp/spec117-performance.json',JSON.stringify({environment:process.version,resourceFixtureRows:10000,totalCandidates:job.result.total,counts:job.result.counts,executionMs:Date.parse(job.finishedAt)-Date.parse(job.startedAt),submitMs,ordinaryRequestMs:latencies,executor:job.result.executor,dataVersion:job.result.dataVersion},null,2))
  // A new execution observes the changed decision, without caching old qualification.
  const next=await workbook('after-snapshot-change')
  expect(rows(next.wb,'排除明细').some(r=>r[4]==='快照末项')).toBe(true)
  expect(next.job.result.dataVersion).not.toBe(job.result.dataVersion)
},60000)
it('重启保留与中断清理', async () => {
  const finished=await workbook('persistent')
  await service.stop()
  const interruptedId=newJobId()
  db.insert(s.job).values({id:interruptedId,kind:'current-roster-export',params:{titleCode:'little_giant',clientRequestId:'interrupted'},state:'running',progress:{done:1,total:20}}).run()
  writeFileSync(join(dbPath+'.exports',interruptedId+'.part'),'incomplete')
  writeFileSync(join(dbPath+'.exports',interruptedId+'.xlsx'),'unpublished-orphan')
  await startService()
  const interrupted=await json(await fetch(url('/api/jobs/'+interruptedId)))
  expect(interrupted.state).toBe('failed');expect(interrupted.error).toContain('重启')
  for(let i=0;i<100 && (existsSync(join(dbPath+'.exports',interruptedId+'.part')) || existsSync(join(dbPath+'.exports',interruptedId+'.xlsx')));i++) await new Promise(r=>setTimeout(r,10))
  expect(existsSync(join(dbPath+'.exports',interruptedId+'.part'))).toBe(false)
  expect(existsSync(join(dbPath+'.exports',interruptedId+'.xlsx'))).toBe(false)
  expect((await fetch(url('/api/job-artifacts/'+interruptedId),{headers})).status).toBe(404)
  const restored=await json(await fetch(url('/api/jobs/'+finished.job.id)))
  expect(restored.state).toBe('done');expect(restored.result.artifact.availability).toBe('available')
  const bytes=Buffer.from(await (await fetch(url(restored.result.artifact.downloadUrl),{headers})).arrayBuffer())
  expect(bytes.equals(finished.bytes)).toBe(true)
  expect((await json(await submit('persistent'))).jobId).toBe(finished.job.id)
},90000)
it('文本、身份、缺项与业务只读', async () => {
  const formula=candidate('=HYPERLINK("https://invalid.example","合成")')
  db.update(s.enterprise).set({usccNorm:'001234567890123456'}).where(eq(s.enterprise.id,formula.enterprise.id)).run()
  const long='超长😀名称'.repeat(30);candidate(long)
  const a=candidate('同名甲'),b=candidate('同名乙')
  for(const c of [a,b]) {db.update(s.enterprise).set({name:'同名企业',nameNorm:'同名企业'}).where(eq(s.enterprise.id,c.enterprise.id)).run();db.update(s.record).set({nameRaw:'同名企业'}).where(eq(s.record.id,c.record.id)).run()}
  const partial=candidate('首次补充缺口',[{eventType:'award',year:new Date().getFullYear()-5},{eventType:'award',year:new Date().getFullYear()}])
  const oldEvent=db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,partial.record.id)).all()[0]!
  db.delete(s.recordEvidence).where(eq(s.recordEvidence.recordEventId,oldEvent.id)).run()
  for(const status of ['failed','no_record'] as const) {
    const c=candidate('查询'+status)
    db.insert(s.platformQuery).values({interface:'recognized_list',queryKey:c.enterprise.usccNorm!,rdjb:'3',titleCode:'little_giant',queriedAt:new Date().toISOString(),status,rawResponse:'=FORMULA()'}).run()
  }
  const sourceBefore=businessDigest()
  const {wb}=await workbook('safe-full')
  const eligible=rows(wb,'有效企业')
  const text=eligible.find(r=>r[4]===formula.enterprise.name)!
  expect(text[3]).toBe('001234567890123456');expect(text[4]).toBe('=HYPERLINK("https://invalid.example","合成")')
  expect(eligible.find(r=>r[4]===long)![4]).toBe(long)
  expect(eligible.filter(r=>r[4]==='同名企业').map(r=>r[2])).toEqual([String(a.enterprise.id),String(b.enterprise.id)])
  expect(eligible.find(r=>r[4]==='首次补充缺口')![9] ?? null).toBeNull()
  expect(eligible.map(r=>r[4])).toEqual(expect.arrayContaining(['查询failed','查询no_record']))
  expect(businessDigest()).toBe(sourceBefore)
},30000)
function businessDigest() {
  const hash=createHash('sha256')
  for(const table of ['enterprise','record','record_event','record_evidence','enterprise_alias','platform_query','platform_relation','difference_reason','record_correspondence']) for(const row of db.$client.prepare('select * from '+table+' order by id').iterate()) hash.update(JSON.stringify(row))
  return hash.digest('hex')
}
it('空工作簿与下载取消', async () => {
  db.delete(s.record).where(eq(s.record.titleCode,'innovative_sme')).run()
  const response=await fetch(url('/api/jobs'),{method:'POST',headers,body:JSON.stringify({kind:'current-roster-export',params:{titleCode:'innovative_sme',clientRequestId:'empty'}})})
  expect(response.status).toBe(202)
  const job=await terminal((await json(response)).jobId);expect(job.state).toBe('done')
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await (await fetch(url(job.result.artifact.downloadUrl),{headers})).arrayBuffer()) as any)
  expect(wb.worksheets.map(w=>w.name)).toEqual(['有效企业','待确认','排除明细','口径说明'])
  expect(job.result.counts).toEqual({eligible:0,pending:0,excluded:0})
  expect(job.progress).toEqual({done:0,total:0});expect(job.percent).toBe(100)
  expect(wb.getWorksheet('有效企业')!.rowCount).toBe(1)
  const abort=new AbortController();const pending=fetch(url(job.result.artifact.downloadUrl),{headers,signal:abort.signal});abort.abort();await expect(pending).rejects.toThrow()
  const bytes=Buffer.from(await (await fetch(url(job.result.artifact.downloadUrl),{headers})).arrayBuffer())
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.result.artifact.sha256)
})
it('未知周期、同年恢复与执行版本', async () => {
  const y=new Date().getFullYear()
  candidate('未知复核周期',[{eventType:'award',year:y-1,batchSeq:1},{eventType:'review',year:null,decidedYear:y,reviewOutcome:'failed'}])
  candidate('同年恢复顺序不明',[{eventType:'award',year:y-4,batchSeq:1},{eventType:'review',year:y-4,batchSeq:1,decidedYear:y,reviewOutcome:'failed'},{eventType:'award',year:y,batchSeq:2}])
  const response=await submit('unknown-cycle'),id=(await json(response)).jobId
  let active:any
  for(let i=0;i<500;i++) {active=await json(await fetch(url('/api/jobs/'+id)));if(active.state==='running' && active.progress.done>=100)break;await new Promise(r=>setTimeout(r,10))}
  expect(active.result.ruleVersion).toBe('current-roster-116-v5')
  expect(active.result.snapshotId).toBe(id)
  const job=await terminal(id);expect(job.state).toBe('done')
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await (await fetch(url(job.result.artifact.downloadUrl),{headers})).arrayBuffer()) as any)
  expect(rows(wb,'待确认').map(r=>r[4])).toEqual(expect.arrayContaining(['未知复核周期','同年恢复顺序不明']))
  expect(rows(wb,'待确认').find(r=>r[4]==='同年恢复顺序不明')![13]).toContain('冲突')
  expect(job.result.snapshotId).toBe(id)
},30000)
it('决定撤回、前提失效与候选引用', async () => {
  const withdrawn=candidate('撤回旧外迁'),previous=decision(withdrawn.enterprise.id,'moved_out',{recordedAt:'2025-01-01T00:00:00Z'})
  decision(withdrawn.enterprise.id,'moved_out',{lifecycleAction:'withdraw',previousId:previous.id})
  const replaced=candidate('替代旧外迁'),head=decision(replaced.enterprise.id,'moved_out',{recordedAt:'2025-01-01T00:00:00Z'})
  decision(replaced.enterprise.id,'pending_review',{previousId:head.id,measureCode:'follow_review'})
  const premise=candidate('现有代码旧按名查询')
  const query=db.insert(s.platformQuery).values({interface:'business_list',queryKey:'name:'+premise.enterprise.nameNorm,rdjb:'3',titleCode:'little_giant',queriedAt:new Date().toISOString(),status:'failed'}).returning().get()
  const stale=decision(premise.enterprise.id,'moved_out',{evidenceQueryId:query.id})
  const terminalGap=candidate('终止能力待确认');decision(terminalGap.enterprise.id,'other',{reasonNote:'正式取消/终止资格，但现有模型无对应周期终止事件'})
  const identity=candidate('统代冲突');db.update(s.record).set({usccRaw:'DIFFERENT-ID'}).where(eq(s.record.id,identity.record.id)).run()
  for(const status of ['退回','待审核']) {
    const c=candidate('申请状态'+status)
    const q=db.insert(s.platformQuery).values({interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:'3',titleCode:'little_giant',queriedAt:new Date().toISOString(),status:'success'}).returning().get()
    db.insert(s.platformRelation).values({queryId:q.id,sequenceNo:1,enterpriseId:c.enterprise.id,status,declareKind:'update',verificationStatus:'confirmed',matchBasis:'uscc'}).run()
  }
  const unconfirmed=candidate('未确认对应边',[{eventType:'maintain',year:new Date().getFullYear()}])
  db.update(s.record).set({source:'miit'}).where(eq(s.record.id,unconfirmed.record.id)).run()
  const edge=db.insert(s.recordCorrespondence).values({edgeKey:'synthetic-candidate',type:'event_process',role:'award',eventId:db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,unconfirmed.record.id)).get()!.id,enterpriseId:unconfirmed.enterprise.id,titleCode:'little_giant',status:'candidate',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:new Date().toISOString()}).returning().get()
  const {wb}=await workbook('decision-scope')
  expect(rows(wb,'有效企业').map(r=>r[4])).toEqual(expect.arrayContaining(['撤回旧外迁','替代旧外迁','申请状态退回','申请状态待审核']))
  const pending=rows(wb,'待确认')
  expect(pending.map(r=>r[4])).toEqual(expect.arrayContaining(['现有代码旧按名查询','终止能力待确认','统代冲突','未确认对应边']))
  expect(pending.find(r=>r[4]==='现有代码旧按名查询')![14]).toContain('decision:'+stale.id)
  expect(pending.find(r=>r[4]==='未确认对应边')![14]).toContain('correspondence:'+edge.id)
},30000)
it('Excel超限明确失败', async () => {
  const c=candidate('超'.repeat(33000))
  try {
    const response=await submit('cell-limit');expect(response.status).toBe(202)
    const job=await terminal((await json(response)).jobId)
    expect(job.state).toBe('failed');expect(job.error).toContain('Excel')
    expect((await fetch(url('/api/job-artifacts/'+job.id),{headers})).status).toBe(404)
    expect(existsSync(join(dbPath+'.exports',job.id+'.part'))).toBe(false)
  } finally {
    const events=db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId,c.record.id)).all()
    for(const event of events) db.delete(s.recordEvidence).where(eq(s.recordEvidence.recordEventId,event.id)).run()
    db.delete(s.recordEvent).where(eq(s.recordEvent.recordId,c.record.id)).run();db.delete(s.record).where(eq(s.record.id,c.record.id)).run();db.delete(s.enterprise).where(eq(s.enterprise.id,c.enterprise.id)).run()
  }
},30000)
it('OpenAPI任务与受控下载发现', async () => {
  const response=await fetch(url('/_openapi.json'));expect(response.status).toBe(200)
  const spec=await json(response)
  expect(spec.paths['/api/roster/exports/current/little-giant'].post.security).toEqual([{bearerAuth:[]}])
  expect(spec.paths['/api/jobs'].post.requestBody.content['application/json'].schema.properties.kind.enum).toContain('current-roster-export')
  expect(spec.paths['/api/job-artifacts/{id}'].get.security).toEqual([{bearerAuth:[]}])
  expect(spec.paths['/api/job-artifacts/{id}'].get.responses['200'].content['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].schema.format).toBe('binary')
})
it('产物存储错误不泄露路径', async () => {
  await workbook('storage-prior')
  const root=dbPath+'.exports',backup=root+'.backup'
  renameSync(root,backup);writeFileSync(root,'not-a-directory')
  let failed:any
  try {
    const response=await submit('storage-error');expect(response.status).toBe(202)
    failed=await terminal((await json(response)).jobId)
    expect(failed.state).toBe('failed');expect(JSON.stringify(failed)).not.toContain(dir)
    expect(failed.result.ruleVersion).toBe('current-roster-116-v5')
  } finally {rmSync(root,{force:true});renameSync(backup,root)}
  const retry=await json(await submit('storage-retry',{regenerateOf:failed.id}))
  expect((await terminal(retry.jobId)).state).toBe('done')
},30000)
it('平台单独候选不遗漏且不冒充已确认资格', async () => {
  const c=db.insert(s.enterprise).values({name:'仅平台识别候选',nameNorm:'仅平台识别候选',usccNorm:'PLATFORM-CANDIDATE-117'}).returning().get()
  const q=db.insert(s.platformQuery).values({interface:'recognized_list',queryKey:c.usccNorm!,rdjb:'3',titleCode:'little_giant',queriedAt:new Date().toISOString(),status:'success'}).returning().get()
  const r=db.insert(s.platformRelation).values({queryId:q.id,sequenceNo:1,enterpriseId:c.id,status:'认定通过',verificationStatus:'confirmed',matchBasis:'uscc'}).returning().get()
  const {wb}=await workbook('platform-only')
  const pending=rows(wb,'待确认').find(row=>row[4]==='仅平台识别候选')!
  expect(pending[2]).toBe(String(c.id));expect(pending[14]).toContain('platform-relation:'+r.id)
  expect(rows(wb,'有效企业').some(row=>row[4]==='仅平台识别候选')).toBe(false)
},30000)
