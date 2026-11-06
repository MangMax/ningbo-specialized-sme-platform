import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { useDb, schema as s } from '../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'facts-export-307-'))
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
  expect(job.progress).toEqual({done:7,total:7})
  expect(job.percent).toBe(100)
  const download = await fetch(url(job.result.artifact.downloadUrl), { headers })
  expect(download.status).toBe(200)
  expect(download.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  expect(download.headers.get('content-disposition')).toContain('.xlsx')
  const bytes = Buffer.from(await download.arrayBuffer()), wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as any)
  expect(job.result.snapshotStartedAt).toBe('2026-11-04T12:00:00.000Z')
  expect(wb.worksheets.map(sheet=>sheet.name)).toEqual(['有效企业','已到期','已注销（吊销）','已迁出','未认定','口径说明'])
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
let mode = ''
async function startService() {
  const cwd = resolve(import.meta.dirname, '..'), port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore','pipe','pipe'], env: { ...process.env, ENTERPRISE_FACT_CONSUMER_SOURCE: mode, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${join(dir,'clock.mjs')}`, NUXT_BUILD_DIR: join(dir,'build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: token, NUXT_FILES_DIR: join(dir,'files'), NUXT_INCOMING_DIR: join(dir,'incoming') } })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(url('/api/jobs/kinds'), { timeoutMs: 60000, child }) } catch (e) { await service.stop(); throw new Error(String(e) + output) }
}
beforeAll(async () => {
  // Test-only process preload: same asOf in HTTP executors and export workers.
  // Timers still use real elapsed time; no application clock seam is introduced.
  writeFileSync(join(dir,'clock.mjs'), `const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-11-04T12:00:00.000Z'])) } static now() { return 1793793600000 } };`)
  await startService()
}, 90000)
afterAll(async () => { if (service) await service.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

async function get(path: string) {
  const response = await fetch(url(path), { headers })
  expect(response.status, path).toBe(200)
  return response.json() as Promise<any>
}
let sequence = 0
async function command(id: number, change: object) {
  const current = await get(`/api/roster/enterprises/${id}/facts`)
  const request = { expectedVersion: current.version, idempotencyKey: `acceptance-${++sequence}`, actor: {type:'agent',id:'synthetic-307'}, basis:'合成正式通知核实', ...change }
  const root = `/api/roster/enterprises/${id}/facts`
  const preflight = await fetch(url(root+'/preflight'), {method:'POST',headers,body:JSON.stringify(request)})
  expect(preflight.status).toBe(200)
  const plan = await preflight.json()
  const response = await fetch(url(root+'/commit'), {method:'POST',headers,body:JSON.stringify({request,planHash:plan.planHash})})
  expect(response.status).toBe(200)
  return response.json() as Promise<any>
}
const fact = { kind:'moved_out', source:{reference:'synthetic:notice:307',statement:'明确迁出宁波，目的地未载明'}, observed:{precision:'day',value:'2026-11-04'}, effective:{precision:'year',value:'2024'}, city:null }
async function assertion(id: number, changes = {}, confirmed = true) {
  const result = await command(id, {action:'assert',fact:{...fact,...changes}})
  if (confirmed) await command(id, {action:'confirm',factId:result.factId})
  return result.factId as number
}
function sheetRows(wb: ExcelJS.Workbook, name: string) {
  const sheet = wb.getWorksheet(name)!
  return Array.from({length:sheet.rowCount-1},(_,i)=>sheet.getRow(i+2).values as any[])
}
function contents(wb: ExcelJS.Workbook) {
  return Object.fromEntries(['有效企业','已到期','已注销（吊销）','已迁出','未认定'].map(name=>[name,sheetRows(wb,name).map(r=>({name:r[2],note:r[11]}))]))
}
it('independent facts survive HTTP async export and whole effect-reader legacy fallback with retained lifecycle readback', async () => {
  const cases = ['已迁出','已注销','待确认事实','未知生效','未来生效','已撤回','已替换']
  const ids = cases.map(name=>candidate(name,[{eventType:'award',year:2026,batchSeq:1}]).enterprise.id)
  const before = await workbook('before-independent-facts')
  const baseline = await snapshot()
  await assertion(ids[0]!)
  await assertion(ids[1]!,{kind:'cancelled',source:{reference:'synthetic:notice:cancelled',statement:'正式注销'}})
  await assertion(ids[2]!,{},false)
  await assertion(ids[3]!,{effective:{precision:'unknown',value:null}})
  await assertion(ids[4]!,{effective:{precision:'year',value:'2028'}})
  const withdrawn = await assertion(ids[5]!); await command(ids[5]!,{action:'withdraw',factId:withdrawn})
  const replaced = await assertion(ids[6]!)
  const replacement = await command(ids[6]!,{action:'replace',factId:replaced,fact:{...fact,kind:'moved_in',source:{reference:'synthetic:notice:in',statement:'明确迁入宁波，原城市未载明'}}})
  await command(ids[6]!,{action:'confirm',factId:replacement.factId})
  const factsBefore = await Promise.all(ids.map(id=>get(`/api/roster/enterprises/${id}/facts`)))
  expect(factsBefore[5].facts.map((f:any)=>f.status)).toEqual(['withdrawn'])
  expect(factsBefore[6].facts.map((f:any)=>f.status)).toEqual(['replaced','confirmed'])
  const fresh = await workbook('independent-facts')
  expect(fresh.job.result.counts).toEqual({eligible:5,pending:0,excluded:2})
  const businessNote = '逐出处公布名见公布名称列；现用名见企业名称列；已确认曾用名仅见该列'
  expect(contents(fresh.wb)).toEqual({
    有效企业:[...['待确认事实','未知生效','未来生效'].map(name=>({name,note:'排除事实证据或生效时间不完整，仅备注，不改变正式资格；'+businessNote})),...['已撤回','已替换'].map(name=>({name,note:businessNote}))],
    已到期:[], '已注销（吊销）':[{name:'已注销',note:businessNote}], 已迁出:[{name:'已迁出',note:businessNote}], 未认定:[],
  })
  expect(fresh.job.result.statusCounts).toEqual({effective:5,expired:0,terminated:1,moved_out:1,unrecognized:0})
  // Unconfirmed, unknown and future exclusions remain visible diagnostics only.
  for (const name of ['待确认事实','未知生效','未来生效']) {
    const row = sheetRows(fresh.wb,'有效企业').find(row=>row[2]===name)!
    expect(row[13]).toBe('有效企业')
    expect(row[15]).toContain('排除事实证据或生效时间不完整，仅备注，不改变正式资格')
  }

  async function snapshot() {
    const list = await get('/api/roster/current-enterprises?titleCode=little_giant&q=已&pageSize=200')
    const details = await Promise.all(ids.map(id=>get(`/api/roster/enterprises/${id}`)))
    return {list,details}
  }
  const modern = await snapshot()
  expect(modern.list.snapshotStartedAt).toBe('2026-11-04T12:00:00.000Z')
  for (const detail of modern.details) expect(detail.qualificationAssessment.asOf).toBe('2026-11-04T12:00:00.000Z')
  expect(modern.list.total).toBe(2)
  expect(modern.list.rows.map((r:any)=>r.enterpriseId ?? r.id)).toEqual([ids[5],ids[6]])
  expect(modern.details.map(d=>d.qualificationAssessment.titles.find((t:any)=>t.titleCode==='little_giant').group)).toEqual(['excluded','excluded','eligible','eligible','eligible','eligible','eligible'])
  await service.stop(); mode='legacy'; await startService()
  const legacy = await workbook('legacy-facts')
  expect(contents(legacy.wb)).toEqual(contents(before.wb))
  expect(legacy.job.result.snapshotStartedAt).toBe(before.job.result.snapshotStartedAt)
  expect(legacy.job.result.counts).toEqual({eligible:7,pending:0,excluded:0})
  expect(contents(legacy.wb)).toEqual({有效企业:cases.map(name=>({name,note:businessNote})),已到期:[],'已注销（吊销）':[],已迁出:[],未认定:[]})
  const fallback = await snapshot()
  expect(fallback).toEqual(baseline)
  expect(fallback.details.map(d=>d.qualificationAssessment.titles.find((t:any)=>t.titleCode==='little_giant').group)).toEqual(Array(7).fill('eligible'))
  expect(fallback.list.total).toBe(4) // q=已: migrated, cancelled, withdrawn, replaced
  expect(await Promise.all(ids.map(id=>get(`/api/roster/enterprises/${id}/facts`)))).toEqual(factsBefore)
  // Rollback changes effects, not command availability or the existing ID/history contract.
  await assertion(ids[0]!,{kind:'registration_status',effective:{precision:'unknown',value:null}},false)
  const retained = await get(`/api/roster/enterprises/${ids[0]}/facts`)
  expect(retained.facts).toHaveLength(2)
  expect(retained.facts[0]).toEqual(factsBefore[0].facts[0])
  expect(retained.history).toHaveLength(factsBefore[0].history.length+1)
  const refs = [{enterpriseId:ids[0],factId:factsBefore[0].facts[0].factId,revision:2,kind:'moved_out'}]
  const decisionResponse = await fetch(url('/api/roster/decision-lifecycle/commands'),{method:'POST',headers,body:JSON.stringify({enterpriseId:ids[0],titleCode:'specialized_sme',direction:'missing_in_miit',action:'replace',expectedCurrentId:null,idempotencyKey:'fallback-pinned-reference',actor:{type:'agent',id:'synthetic-307'},basis:'合成核实',ruleVersion:'manual-v1',effectiveAt:'2026-01-01T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'platform_stale',measureCode:'none',verificationStatus:'confirmed',factReferences:refs}})})
  expect(decisionResponse.status).toBe(200)
  const saved = await decisionResponse.json()
  const pinned = await get('/api/roster/decision-lifecycle/'+saved.versionId)
  expect(pinned.factReferences).toEqual(refs)
  await command(ids[0]!,{action:'withdraw',factId:refs[0]!.factId})
  expect((await get('/api/roster/decision-lifecycle/'+saved.versionId)).factReferences).toEqual(refs)
  const evidenceDir = process.env.FACTS_307_EVIDENCE_DIR
  if (evidenceDir) {
    writeFileSync(join(evidenceDir,'new-facts.xlsx'),fresh.bytes)
    writeFileSync(join(evidenceDir,'legacy-facts.xlsx'),legacy.bytes)
    writeFileSync(join(evidenceDir,'http-observations.json'),JSON.stringify({before:before.job,modern,job:fresh.job,contents:contents(fresh.wb),fallback,legacyJob:legacy.job,legacyContents:contents(legacy.wb),factsBefore,retained,pinned},null,2))
  }
  expect((await get(`/api/roster/enterprises/${ids[0]}`)).qualificationAssessment.titles.find((t:any)=>t.titleCode==='little_giant').group).toBe('eligible')
}, 120000)
