import { resetExportRows } from './fixtures/reset-rows'
import { readDevelopmentDiscovery } from './fixtures/specialized-export'
import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { CURRENT_RULE_VERSION } from '../../../lib/roster/current-qualification'
import { businessIdentity, expectedBusinessIdentity } from './fixtures/specialized-export'
import { reviewCurrentExportDecision, confirmCurrentExportExclusion } from '../fixtures/qualification-decisions'
import { mkdtempSync, rmSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import ExcelJS from 'exceljs'
import { newJobId } from '../../../layers/core/lib/job'
import { createHash } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'export-117-'))
const dbPath = join(dir, 'synthetic.db'), db = initializeDb({ create: true,  dbPath })
let servicePid: number
let service: { baseUrl: string; stop: () => Promise<void>; diagnostics: () => unknown }
const requestErrors = channel('undici:request:error')
function logRequestError(message: unknown) {
  const { request, error } = message as { request: { origin: string; path: string; method: string }; error: { code?: string; name: string } }
  if (String(request.origin) === service?.baseUrl) {
    console.error('little-giant request error', { method: request.method, path: request.path.split('?')[0], name: error.name, code: error.code })
  }
}
requestErrors.subscribe(logRequestError)
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
  await readDevelopmentDiscovery()
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore','pipe','pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir,'build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: token, NUXT_FILES_DIR: join(dir,'files'), NUXT_INCOMING_DIR: join(dir,'incoming') } })
  servicePid = child.pid!
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child), diagnostics: () => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, output }) }
  try { await waitForHttp(url('/api/jobs/kinds'), { timeoutMs: 60000, child }) } catch (e) { await service.stop(); throw new Error(String(e) + output) }
}
beforeAll(startService, 90000)
beforeEach(() => resetExportRows(db.$client))
// Emit the assertion at failure time: a later workflow deadline may prevent
// Vitest's end-of-run summary and JSON reporter from being written.
afterEach(context => {
  if (context.task.result?.state === 'fail') {
    console.error('little-giant immediate failure', context.task.name, context.task.result.errors)
    console.error('little-giant app state', service.diagnostics())
  }
})
afterAll(async () => { requestErrors.unsubscribe(logRequestError); if (service) await service.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
it('HTTP提交到六表文件', async () => {
  const { enterprise } = candidate('新认定')
  const { wb, job, bytes } = await workbook('fresh')
  expect(wb.worksheets.map(w => w.name)).toEqual(['有效企业','已到期','已注销（吊销）','已迁出','未认定','口径说明'])
  expect(businessIdentity(rows(wb,'有效企业')[0]!)).toEqual(expectedBusinessIdentity(db,enterprise.id))
  expect(job.result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  expect(job.result.artifact.size).toBe(bytes.length)
  expect(job.result.dataVersion).toMatch(/^sha256:/)
})
function rows(wb: ExcelJS.Workbook, sheet: string) {
  return wb.getWorksheet(sheet)!.getRows(2, Math.max(0,wb.getWorksheet(sheet)!.rowCount-1))?.map(row => row.values as any[]) ?? []
}
function decision(enterpriseId: number, reasonCode: 'moved_out'|'moved_in'|'deregistered'|'renamed'|'pending_review'|'other', extra: Record<string,unknown> = {}) {
  const decision = db.insert(s.differenceReason).values({enterpriseId,titleCode:'little_giant',direction:'extra_in_miit',status:'confirmed_reason',reasonCode,verificationStatus:'confirmed',lifecycleAction:'replace',basis:'人工确认合成主体事实',effectiveAt:'2025-01-01T00:00:00Z',recordedAt:new Date().toISOString(),...extra} as any).returning().get()
  reviewCurrentExportDecision(db,decision)
  return decision
}
function executorPid() {
  const line = execFileSync('ps',['-Ao','pid=,ppid=,args='],{encoding:'utf8'}).split('\n').find(line => Number(line.trim().split(/\s+/)[1]) === servicePid && line.includes('/current-export-worker.mjs'))
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
    expect(cancelledJob.state).toBe('cancelled');expect(cancelledJob.result.ruleVersion).toBe(CURRENT_RULE_VERSION)
    expect(existsSync(join(dbPath+'.exports',first.jobId+'.part'))).toBe(false)
    expect((await fetch(url('/api/job-artifacts/'+first.jobId),{headers})).status).toBe(404)
    const failed = await json(await submit('killed-executor'))
    process.kill(await executor(),'SIGKILL')
    const failure = await terminal(failed.jobId)
    expect(failure.state).toBe('failed'); expect(failure.error).toContain('中断');expect(failure.result.ruleVersion).toBe(CURRENT_RULE_VERSION)
    expect(existsSync(join(dbPath+'.exports',failed.jobId+'.part'))).toBe(false)
    expect((await fetch(url('/api/job-artifacts/'+failed.jobId),{headers})).status).toBe(404)
  } finally { try {process.kill(pid,'SIGCONT')} catch {} }
},30000)
it('万行快照与普通请求响应', async () => {
  db.transaction(() => {for(let i=0;i<10000;i++) candidate('资源合成'+i)})
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
    if(['done','failed','cancelled'].includes(active.state)) break
    await new Promise(r=>setTimeout(r,10))
  }
  expect(active.state, 'snapshot must still be active before mutation: '+JSON.stringify(active)).toBe('running')
  expect(active.progress.done).toBeGreaterThanOrEqual(100)
  expect(active.progress.done).toBeLessThan(active.progress.total)
  const changed=await fetch(url('/api/roster/decision-lifecycle/commands'),{method:'POST',headers,body:JSON.stringify({enterpriseId:last.enterprise.id,titleCode:'little_giant',direction:'extra_in_miit',action:'replace',expectedCurrentId:null,idempotencyKey:'snapshot-change',actor:{type:'agent',id:'test'},basis:'隔离SQLite当前事实更新',ruleVersion:'manual-v1',effectiveAt:'2026-01-01T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'moved_out',verificationStatus:'confirmed',measureCode:'mark_moved_out'}})})
  expect(changed.status).toBe(200)
  const version=await changed.json()
  reviewCurrentExportDecision(db,db.select().from(s.differenceReason).where(eq(s.differenceReason.id,version.versionId)).get()!)
  await confirmCurrentExportExclusion(service.baseUrl,headers,last.enterprise.id,'snapshot-typed-exclusion')
  const latencies:number[]=[]
  for(let i=0;i<4;i++) for(const path of [listPath,detailPath,'/api/files?limit=20']) {
    const t=performance.now(), response=await fetch(url(path));await response.arrayBuffer()
    latencies.push(performance.now()-t);expect(response.status).toBe(200)
  }
  expect(Math.max(...latencies)).toBeLessThan(2000)
  const job=await terminal(id);expect(job.state,JSON.stringify(job)).toBe('done')
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await (await fetch(url(job.result.artifact.downloadUrl),{headers})).arrayBuffer()) as any)
  expect(rows(wb,'有效企业').some(r=>r[2]==='快照末项')).toBe(true)
  expect(rows(wb,'有效企业').filter(r=>String(r[2]).startsWith('资源合成'))).toHaveLength(10000)
  for(const [sheet,key] of [['有效企业','effective'],['已到期','expired'],['已注销（吊销）','terminated'],['已迁出','moved_out'],['未认定','unrecognized']]) expect(wb.getWorksheet(sheet!)!.rowCount-1).toBe(job.result.statusCounts[key!])
  expect(job.result.executor.peakRssBytes).toBeLessThan(512*1024*1024)
  // The complete 10,000-row snapshot and responsiveness checks above are finished.
  // Remove only that stress fixture after its job is terminal; later cases and
  // the independent next execution still retain the changed subject and its facts.
  db.transaction(() => {
    db.$client.prepare("delete from record where enterprise_id in (select id from enterprise where name like '资源合成%')").run()
    db.$client.prepare("delete from enterprise where name like '资源合成%'").run()
  })
  // A new execution observes the complete typed exclusion, without caching the earlier qualification.
  const next=await workbook('after-snapshot-change')
  expect(rows(next.wb,'已迁出').some(r=>r[2]==='快照末项')).toBe(true)
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
function businessDigest() {
  const hash=createHash('sha256')
  for(const table of ['enterprise','record','record_event','record_evidence','enterprise_alias','platform_collection','platform_business_observation','difference_reason','record_correspondence','enterprise_fact_revision']) for(const row of db.$client.prepare('select * from '+table+' order by id').iterate()) hash.update(JSON.stringify(row))
  for (const { name } of db.$client.prepare("select name from sqlite_master where type='table' and name like 'platform_%' order by name").all() as Array<{ name: string }>) {
    hash.update(name)
    for (const row of db.$client.prepare(`select * from "${name}" order by rowid`).iterate()) hash.update(JSON.stringify(row))
  }
  for(const row of db.$client.prepare('select * from enterprise_fact_receipt order by idempotency_key').iterate()) hash.update(JSON.stringify(row))
  return hash.digest('hex')
}
it('空工作簿与下载取消', async () => {
  db.delete(s.record).where(eq(s.record.titleCode,'innovative_sme')).run()
  const response=await fetch(url('/api/jobs'),{method:'POST',headers,body:JSON.stringify({kind:'current-roster-export',params:{titleCode:'innovative_sme',clientRequestId:'empty'}})})
  expect(response.status).toBe(202)
  const job=await terminal((await json(response)).jobId);expect(job.state).toBe('done')
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await (await fetch(url(job.result.artifact.downloadUrl),{headers})).arrayBuffer()) as any)
  expect(wb.worksheets.map(w=>w.name)).toEqual(['有效企业','已到期','已注销（吊销）','已迁出','未认定','口径说明'])
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
  const before=businessDigest()
  const response=await submit('unknown-cycle'),id=(await json(response)).jobId
  let active:any
  for(let i=0;i<500;i++) {active=await json(await fetch(url('/api/jobs/'+id)));if(active.state==='running' && active.progress.done>=100)break;await new Promise(r=>setTimeout(r,10))}
  expect(active.result.ruleVersion).toBe(CURRENT_RULE_VERSION)
  expect(active.result.snapshotId).toBe(id)
  const job=await terminal(id);expect(job.state).toBe('done')
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await (await fetch(url(job.result.artifact.downloadUrl),{headers})).arrayBuffer()) as any)
  const effective = rows(wb,'有效企业')
  expect(effective.map(r=>[r[2],r[3]]).sort()).toEqual([
    ['未知复核周期','TEST-未知复核周期'],['同年恢复顺序不明','TEST-同年恢复顺序不明'],
  ].sort())
  expect(rows(wb,'已到期').map(r=>r[2])).toEqual([])
  for (const [name,firstYear] of [['未知复核周期',y-1],['同年恢复顺序不明',y-4]] as const) {
    const row=effective.find(r=>r[2]===name)!
    expect(row[6]).toBe(String(firstYear))
    expect(String(row[14])).toContain('小巨人原认定或复核通过资格保留；不按认定年龄自动到期，适用正式期间、同周期失败及已确认处置另行裁定')
    expect(String(row[7])).toContain('复核未通过')
    expect(String(row[12])).toContain('《synthetic.xlsx》，附件：名单')
  }
  expect(businessDigest()).toBe(before)
  expect(job.result.snapshotId).toBe(id)
},30000)
it('OpenAPI任务与受控下载发现', async () => {
  const response=await Promise.resolve(new Response(JSON.stringify(await readDevelopmentDiscovery())));expect(response.status).toBe(200)
  const spec=await json(response)
  expect(spec.paths['/api/roster/exports/current/little-giant'].post.security).toEqual([{bearerAuth:[]}])
  expect(spec.paths['/api/jobs/kinds'].get.responses['200']).toBeDefined()
  const kinds = await fetch(url('/api/jobs/kinds'))
  expect(kinds.status).toBe(200)
  expect((await kinds.json()).kinds).toContainEqual(expect.objectContaining({ kind: 'current-roster-export', status: 'ready' }))
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
    expect(failed.result.ruleVersion).toBe(CURRENT_RULE_VERSION)
  } finally {rmSync(root,{force:true});renameSync(backup,root)}
  const retry=await json(await submit('storage-retry',{regenerateOf:failed.id}))
  expect((await terminal(retry.jobId)).state).toBe('done')
},90000)
