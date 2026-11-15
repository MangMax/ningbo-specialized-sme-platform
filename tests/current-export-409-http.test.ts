import { submitSyntheticRecognizedCollection } from './helpers/qualification-native-source'
import { submitNativePlatformQuery } from './helpers/native-platform-fixture'
import { CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION } from '../lib/roster/current-qualification'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import type ExcelJS from 'exceljs'
import { schema } from '../db/client'
import { currentExport409Fixture } from './helpers/current-export-409'
import { B409, B409_TAIL_NAMES, HEADERS_409, X409 } from './fixtures/current-export-409'
import { readCurrentQualificationAssessment } from '../lib/roster/current-qualification'

const f = currentExport409Fixture()
const headers409 = [...HEADERS_409,'有效状态','有效期及排除依据','资料缺口与来源备注']
const sheets409 = ['有效企业','已到期','已注销（吊销）','已迁出','未认定','口径说明']
beforeAll(() => f.start(), 60000)
afterAll(() => f.close())
it('X409 canonical termination overrides an independent unresolved subject fact in real Excel', async () => {
  await f.resetBusiness()
  const target = f.candidate(X409.name)
  f.decision(target.enterprise.id, 'deregistered')
  f.decision(target.enterprise.id, 'moved_out', { titleCode: 'innovative_sme', direction: 'missing_in_miit', basis: null })
  // Legacy decisions remain diagnostic; complete typed facts own current exclusion.
  const legacyOnly = readCurrentQualificationAssessment(f.db.$client,target.enterprise.id).titles.find(t => t.titleCode === 'specialized_sme')!
  expect(legacyOnly).toMatchObject({ group:'eligible',effectiveQualification:{status:'effective'},subject:{status:'not_established'} })
  expect(f.db.$client.prepare('select distinct reason_code as reasonCode from difference_reason where enterprise_id=? order by reason_code').all(target.enterprise.id)).toEqual([{reasonCode:'deregistered'},{reasonCode:'moved_out'}])
  for (const [factId,kind,reference] of [[1,'cancelled','synthetic registry cancellation'],[2,'moved_out','']] as const) {
    f.db.insert(schema.enterpriseFactRevision).values({enterpriseId:target.enterprise.id,factId,revision:1,status:'confirmed',fact:{kind,source:{reference,statement:'literal synthetic registry statement'},effective:{precision:'day',value:'2025-01-01'},observed:{precision:'day',value:'2025-01-01'},city:null},action:'assert',actor:{type:'agent',id:'X409'},basis:'independently verified synthetic fact',createdAt:'2025-01-01T00:00:00Z'}).run()
  }
  f.candidate(X409.eligible)
  f.candidate(X409.pending, [{ eventType: 'award', year: null, batchSeq: 1 }])
  const before = f.businessDigest()
  const shared = readCurrentQualificationAssessment(f.db.$client, target.enterprise.id)
  expect(shared.titles.map(t => t.titleCode).sort()).toEqual(['innovative_sme','little_giant','specialized_sme'])
  expect(shared.titles.find(t => t.titleCode === 'specialized_sme')).toMatchObject({group:'excluded',effectiveQualification:{status:'terminated'},subject:{status:'terminated'}})
  expect(f.businessDigest()).toBe(before)
  const { wb, job } = await f.workbook('X409-first-guarded-red')
  expect(wb.worksheets.map(s => s.name)).toEqual(sheets409)
  expect(job.result.total).toBe(3)
  for (const sheet of wb.worksheets.slice(0,5)) expect(sheet.getRow(1).values).toEqual([undefined,...headers409])
  const names = (sheet: string) => wb.getWorksheet(sheet)!.getRows(2,Math.max(0,wb.getWorksheet(sheet)!.rowCount-1))?.map(r => r.getCell(2).value) ?? []
  expect(names('有效企业')).toEqual([X409.eligible])
  expect(names('已到期')).toEqual([X409.pending])
  expect(wb.getWorksheet('已到期')!.getCell('G2').value).toBe('原认定年份待核第1批认定')
  expect(wb.getWorksheet('已到期')!.getCell('O2').value).toContain('认定或复核周期资料不完整')
  expect(f.businessDigest()).toBe(before)
  expect(names('已注销（吊销）'), 'X409_TARGET_CANONICAL_EXCLUDED').toEqual([X409.name])
  expect(names('未认定')).toEqual([]); expect(names('已迁出')).toEqual([])
  expect(wb.getWorksheet('已注销（吊销）')!.getCell('O2').value).toContain('排除事实证据或生效时间不完整，仅备注')
  expect(job.result.counts).toEqual({eligible:1,pending:0,excluded:2})
  expect(job.result.statusCounts).toEqual({effective:1,expired:1,terminated:1,moved_out:0,unrecognized:0})
}, 30000)

it('E409 full title exports retain platform failures missing records and unrecognized reviews beyond page one', async () => {
  await f.resetBusiness()
  const titlePaths = {little_giant:'little-giant',specialized_sme:'specialized-sme',innovative_sme:'innovative-sme'} as const
  for (const [title,path] of Object.entries(titlePaths)) {
    const valid=f.candidate('E409-'+title,undefined,title)
    const failedQuery = submitNativePlatformQuery(f.db,{interface:'business_list',queryKey:'name:'+valid.enterprise.name,titleCode:title,rdjb:title==='innovative_sme'?'1':title==='specialized_sme'?'2':'3',queriedAt:'2026-01-01T00:00:00Z',status:'failed',rawResponse:'synthetic E409 failed platform response'})
    const pending=f.candidate('P409-'+title,[{eventType:'review',year:2022,batchSeq:1,decidedYear:null,reviewOutcome:null}],title)
    const failed=f.candidate('F409-'+title,[{eventType:'review',year:2022,batchSeq:1,decidedYear:2025,reviewOutcome:'failed'}],title)
    const absent=f.candidate('N409-'+title,undefined,title)
    // The source USCC condition requires an 18-character original input.
    absent.enterprise.usccNorm='SYNTHETIC'+String(absent.enterprise.id).padStart(9,'0')
    f.db.$client.prepare('update enterprise set uscc_norm=? where id=?').run(absent.enterprise.usccNorm,absent.enterprise.id)
    const missingQuery = submitSyntheticRecognizedCollection(f.db,{rdjb:title==='innovative_sme'?'1':title==='specialized_sme'?'2':'3',queriedAt:'2026-01-01T00:00:00Z',conditions:{uscc:absent.enterprise.usccNorm!},rows:[]})
    for (const [enterprise, queryId, queryStatus] of [[valid.enterprise, failedQuery.queryId, 'failed'], [absent.enterprise, missingQuery.queryId, 'no_record']] as const) {
      const snapshot = readCurrentQualificationAssessment(f.db.$client, enterprise.id)
      expect(snapshot.enterpriseId).toBe(enterprise.id)
      expect(snapshot.titles.map(item => item.titleCode)).toEqual(['little_giant','specialized_sme','innovative_sme'])
      const selected = snapshot.titles.find(item => item.titleCode === title)!
      expect(selected).toMatchObject({ titleCode: title, group: 'eligible', officialQualification: { group: 'eligible' } })
      expect(selected.platform.observations).toContainEqual(expect.objectContaining({ queryId, queryStatus, titleCode: title, applicability: 'at_or_before_as_of' }))
      expect(f.db.$client.prepare('select id,query_key as queryKey,title_code as titleCode,status from platform_collection where id=?').get(queryId)).toEqual({ id: queryId, queryKey: queryStatus === 'failed' ? 'name:' + enterprise.name : enterprise.usccNorm, titleCode: title, status: queryStatus })
    }
    // The final candidate is beyond default query page size. Export accepts no page filters.
    for(let i=0;i<26;i++) f.candidate('Q409-'+title+'-'+i,undefined,title)
    const accepted=await fetch(f.url('/api/roster/exports/current/'+path),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'E409-'+title})})
    expect(accepted.status).toBe(202)
    const job=await f.terminal((await accepted.json()).jobId); expect(job.state,JSON.stringify(job)).toBe('done')
    const {wb}=await f.download(job)
    const names=(sheet:string)=>wb.getWorksheet(sheet)!.getRows(2,Math.max(0,wb.getWorksheet(sheet)!.rowCount-1))?.map(r=>r.getCell(2).value)??[]
    expect(names('有效企业')).toEqual([valid.enterprise.name,absent.enterprise.name,...Array.from({length:26},(_,i)=>'Q409-'+title+'-'+i)])
    for (const empty of ['已到期','已注销（吊销）','已迁出']) expect(names(empty)).toEqual([])
    expect(names('未认定')).toEqual([pending.enterprise.name,failed.enterprise.name])
    expect(wb.worksheets.map(sheet=>sheet.name)).toEqual(sheets409)
    expect(job.result.counts).toEqual({eligible:28,pending:0,excluded:2})
    expect(job.result.statusCounts).toEqual({effective:28,expired:0,terminated:0,moved_out:0,unrecognized:2})
    expect(job.result.total).toBe(Object.values(job.result.counts).reduce((a:any,b:any)=>a+b,0))
    expect(wb.worksheets.slice(0,5).reduce((n,s)=>n+s.rowCount-1,0)).toBe(job.result.total)
    expect(wb.worksheets.slice(0,5).every(s=>s.getRow(1).cellCount===15)).toBe(true)
  }
},30000)

it('L409 preserves idempotency rejected filters and authenticated artifact boundaries', async () => {
  const response=await f.submit('L409-dedup'); expect(response.status).toBe(202)
  const id=(await response.json()).jobId
  expect((await (await f.submit('L409-dedup')).json()).jobId).toBe(id)
  const job=await f.terminal(id);expect(job.state).toBe('done')
  expect((await fetch(f.url(job.result.artifact.downloadUrl))).status).toBe(401)
  expect((await f.submit('L409-invalid',{page:1,q:'filtered'})).status).toBe(400)
  expect((await fetch(f.url('/api/roster/exports/current/innovative-sme'),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'L409-dedup'})})).status).toBe(409)
},30000)

it('B409 separates formal title states and exhausts 201 public query and Excel members', async () => {
  await f.resetBusiness()
  const stable = f.candidate(B409.name, B409.award.map(event => ({ ...event })), 'little_giant')
  f.addRecord(stable.enterprise.id, B409.name, B409.pending.map(event => ({ ...event })), 'specialized_sme')
  f.addRecord(stable.enterprise.id, B409.name, B409.failed.map(event => ({ ...event })), 'innovative_sme')
  const tails = B409_TAIL_NAMES.map(name => f.candidate(name, B409.award.map(event => ({ ...event })), 'little_giant'))
  const expectedNames = [B409.name, ...B409_TAIL_NAMES]
  const expectedIds = [stable.enterprise.id, ...tails.map(item => item.enterprise.id)]
  const identityByName = new Map(expectedNames.map((name, index) => [name, expectedIds[index]!]))
  expect(f.db.$client.prepare('select count(*) as n from enterprise').get()).toEqual({ n: 201 })
  expect([f.dbPath, f.dbPath + '-wal'].filter(existsSync).reduce((bytes, file) => bytes + statSync(file).size, 0)).toBeLessThan(64 * 1024 * 1024)
  const businessBefore = f.businessDigest()
  f.db.$client.pragma('query_only = ON')
  const literalSnapshot = readCurrentQualificationAssessment(f.db.$client, stable.enterprise.id, Date.parse(B409.asOf))
  expect(literalSnapshot.titles.map(title => [title.titleCode, title.group])).toEqual([
    ['little_giant','eligible'], ['specialized_sme','excluded'], ['innovative_sme','eligible'],
  ])
  expect(literalSnapshot.titles[0]!.evidence).toContainEqual(expect.objectContaining({ eventType: 'award', year: 2026, batchSeq: 1 }))
  expect(literalSnapshot.titles[1]!.completeness.fieldGaps).toEqual([
    { eventId: literalSnapshot.titles[1]!.evidence[0]!.eventId, field: 'decidedYear', valueState: 'unknown', inputState: 'null' },
    { eventId: literalSnapshot.titles[1]!.evidence[0]!.eventId, field: 'reviewOutcome', valueState: 'unknown', inputState: 'null' },
  ])
  expect(literalSnapshot.titles[2]!.evidence).toContainEqual(expect.objectContaining({ eventType: 'review', year: 2022, decidedYear: 2025, reviewOutcome: 'failed' }))

  // Read each public page independently; never interpret unrequested pending as a census.
  const queryIds: number[] = []
  for (const page of [1, 2]) {
    const response = await fetch(f.url('/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: 'little_giant', sort: 'id_asc', page: String(page), pageSize: '200' })), { headers: f.headers })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ titleCode: 'little_giant', total: 201, page, pageSize: 200, publishedPending: { requested: false, rows: [], total: 0 } })
    expect(result.rows.map((row: { enterpriseId: number }) => row.enterpriseId)).toEqual(page === 1 ? expectedIds.slice(0,200) : expectedIds.slice(200))
    queryIds.push(...result.rows.map((row: { enterpriseId: number }) => row.enterpriseId))
    for (const row of result.rows) expect(row.qualificationAssessment).toEqual(readCurrentQualificationAssessment(f.db.$client, row.enterpriseId, Date.parse(result.snapshotStartedAt)))
  }
  expect(queryIds).toEqual(expectedIds)
  const locatedResponse = await fetch(f.url('/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: 'specialized_sme', status: 'unrecognized', q: B409.name })), { headers: f.headers })
  expect(locatedResponse.status).toBe(200)
  const located = await locatedResponse.json()
  expect(located).toMatchObject({ total: 1, publishedPending: { requested: true, total: 0, rows: [] } })
  expect(located.rows.map((row: { enterpriseId: number }) => row.enterpriseId)).toEqual([stable.enterprise.id])
  expect(located.rows[0].qualificationAssessment).toEqual(readCurrentQualificationAssessment(f.db.$client, stable.enterprise.id, Date.parse(located.snapshotStartedAt)))
  const unrequested = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme'), { headers: f.headers })
  expect(unrequested.status).toBe(200)
  expect(await unrequested.json()).toMatchObject({ total: 0, rows: [], publishedPending: { requested: false, rows: [], total: 0 } })

  // Own review history stays unrecognized; a dated innovative history also activates the accepted local giant rule.
  expect(literalSnapshot.titles[2]!.officialQualification.group).toBe('excluded')
  expect(literalSnapshot.titles[2]!.effectiveQualification!.localRuleBasis!.join('\n')).toContain('按有效小巨人资格计入')
  const titleOracles = [
    {title:'little_giant',path:'little-giant',sheet:'有效企业',label:'专精特新“小巨人”',qualification:'2026年第1批认定',counts:{eligible:201,pending:0,excluded:0},statusCounts:{effective:201,expired:0,terminated:0,moved_out:0,unrecognized:0}},
    {title:'specialized_sme',path:'specialized-sme',sheet:'未认定',label:'专精特新中小企业',qualification:'2022年第1批原认定批次，结论年份待核复核结论待核',counts:{eligible:0,pending:0,excluded:1},statusCounts:{effective:0,expired:0,terminated:0,moved_out:0,unrecognized:1}},
    {title:'innovative_sme',path:'innovative-sme',sheet:'有效企业',label:'创新型中小企业',qualification:'2022年第1批原认定批次，2025年复核未通过',counts:{eligible:1,pending:0,excluded:0},statusCounts:{effective:1,expired:0,terminated:0,moved_out:0,unrecognized:0}},
  ]
  for (const literal of titleOracles) {
    const accepted = await fetch(f.url('/api/roster/exports/current/' + literal.path), { method: 'POST', headers: f.headers, body: JSON.stringify({ clientRequestId: 'B409-' + literal.title }) })
    expect(accepted.status).toBe(202)
    const job = await f.terminal((await accepted.json()).jobId)
    expect(job.state, JSON.stringify(job)).toBe('done')
    expect(job.params.titleCode).toBe(literal.title)
    expect(job.result.snapshotId).toBe(job.id)
    const { wb } = await f.download(job)
    expect(wb.worksheets.map(sheet => sheet.name)).toEqual(sheets409)
    expect(job.result.counts).toEqual(literal.counts)
    expect(job.result.statusCounts).toEqual(literal.statusCounts)
    expect(job.result.total).toBe(literal.title === 'little_giant' ? 201 : 1)
    for (const sheet of wb.worksheets.slice(0,5)) {
      expect(sheet.getRow(1).values).toEqual([undefined, ...headers409])
      const names = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2).getCell(2).value)
      expect(names).toEqual(sheet.name === literal.sheet ? literal.title === 'little_giant' ? expectedNames : [B409.name] : [])
      for (let i = 2; i <= sheet.rowCount; i++) {
        expect(sheet.getRow(i).cellCount).toBe(15)
        expect(sheet.getRow(i).getCell(5).value).toBe(literal.label)
      }
    }
    const targetRow = wb.getWorksheet(literal.sheet)!.getRow(2)
    expect(targetRow.getCell(7).value).toBe(literal.qualification)
    if (literal.title === 'specialized_sme') expect(targetRow.getCell(11).value).toContain('缺少已确认认定及资格依据')
    if (literal.title === 'innovative_sme') expect(targetRow.getCell(11).value).toContain('按有效小巨人资格计入')
    if (literal.title === 'specialized_sme') expect(targetRow.getCell(15).value).toContain('认定或复核周期资料不完整')
    expectIndependent409Digest(wb, job.result, literal.title, identityByName)
    expect(f.businessDigest()).toBe(businessBefore)
  }
  expect(f.db.$client.pragma('query_only', { simple: true })).toBe(1)
  expect(f.businessDigest()).toBe(businessBefore)
}, 30000)

function expectIndependent409Digest(wb: ExcelJS.Workbook, result: { generatedAt: string; dataVersion: string }, title: string, identityByName: ReadonlyMap<string, number>) {
  const at = Date.parse(result.generatedAt)
  expect(new Date(at).getUTCFullYear()).toBe(2026)
  const digest = createHash('sha256').update(JSON.stringify(['current-export-assessment-title-v3',QUALIFICATION_ASSESSMENT_VERSION,CURRENT_RULE_VERSION,2026,title]) + '\n')
  for (const [group, sheetName] of [['effective','有效企业'],['expired','已到期'],['terminated','已注销（吊销）'],['moved_out','已迁出'],['unrecognized','未认定']] as const) {
    const sheet = wb.getWorksheet(sheetName)!
    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex++) {
      const values = Array.from({ length: 15 }, (_, c) => sheet.getRow(rowIndex).getCell(c + 1).value)
      // These two added business-text columns are joined strings; OOXML reads an empty string cell as null.
      values[13] ??= ''; values[14] ??= ''
      const id = identityByName.get(String(values[1]))!
      expect(id).toBeTypeOf('number')
      const snapshot = readCurrentQualificationAssessment(f.db.$client, id, at)
      expect(snapshot.titles.map(item => item.titleCode)).toEqual(['little_giant','specialized_sme','innovative_sme'])
      expect(snapshot).toMatchObject({ enterpriseId: id, asOf: result.generatedAt, ruleVersion: CURRENT_RULE_VERSION, assessmentVersion: QUALIFICATION_ASSESSMENT_VERSION })
      const { titles, snapshotId, ...scope } = snapshot
      expect(snapshotId).toBe(createHash('sha256').update(JSON.stringify([scope,titles])).digest('hex'))
      const selectedTitles=titles.filter(item=>item.titleCode===title)
      expect(selectedTitles).toHaveLength(1)
      const titleSnapshotId=createHash('sha256').update(JSON.stringify([scope,selectedTitles])).digest('hex')
      digest.update(JSON.stringify([group,id,scope,titleSnapshotId,values]) + '\n')
    }
  }
  expect(result.dataVersion).toBe('sha256:' + digest.digest('hex'))
}
