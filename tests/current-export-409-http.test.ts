import { CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION } from '../lib/roster/current-qualification'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import type ExcelJS from 'exceljs'
import { currentExport409Fixture } from './helpers/current-export-409'
import { B409, B409_TAIL_NAMES, HEADERS_409, X409 } from './fixtures/current-export-409'
import { readCurrentQualificationAssessment } from '../lib/roster/current-qualification'

const f = currentExport409Fixture()
beforeAll(() => f.start(), 60000)
afterAll(() => f.close())
it('X409 canonical termination overrides an independent unresolved subject fact in real Excel', async () => {
  const target = f.candidate(X409.name)
  f.decision(target.enterprise.id, 'deregistered')
  f.decision(target.enterprise.id, 'moved_out', { titleCode: 'innovative_sme', direction: 'missing_in_miit', basis: null })
  f.candidate(X409.eligible)
  f.candidate(X409.pending, [{ eventType: 'award', year: null, batchSeq: 1 }])
  const before = f.businessDigest()
  const shared = readCurrentQualificationAssessment(f.db.$client, target.enterprise.id)
  expect(shared.titles.map(t => t.titleCode).sort()).toEqual(['innovative_sme','little_giant','specialized_sme'])
  expect(shared.titles.find(t => t.titleCode === 'specialized_sme')).toMatchObject({group:'excluded',subject:{status:'terminated'}})
  expect(f.businessDigest()).toBe(before)
  const { wb, job } = await f.workbook('X409-first-guarded-red')
  expect(wb.worksheets.map(s => s.name)).toEqual(['有效企业','待确认','排除明细','口径说明'])
  expect(job.result.total).toBe(3)
  for (const sheet of wb.worksheets.slice(0,3)) expect(sheet.getRow(1).values).toEqual([undefined,...HEADERS_409])
  const names = (sheet: string) => wb.getWorksheet(sheet)!.getRows(2,Math.max(0,wb.getWorksheet(sheet)!.rowCount-1))?.map(r => r.getCell(2).value) ?? []
  expect(names('有效企业')).toEqual([X409.eligible])
  expect(names('待确认')).toContain(X409.pending)
  expect(f.businessDigest()).toBe(before)
  // Unique intended RED: all real protocol/oracle/read-only controls above precede this assertion.
  expect(names('排除明细'), 'X409_TARGET_CANONICAL_EXCLUDED').toEqual([X409.name])
  expect(names('待确认')).toEqual([X409.pending])
  expect(job.result.counts).toEqual({eligible:1,pending:1,excluded:1})
}, 30000)

it('E409 full title exports retain platform failure missing records and pending beyond page one', async () => {
  const titlePaths = {little_giant:'little-giant',specialized_sme:'specialized-sme',innovative_sme:'innovative-sme'} as const
  for (const [title,path] of Object.entries(titlePaths)) {
    const valid=f.candidate('E409-'+title,undefined,title)
    const failedQuery = f.db.$client.prepare(`insert into platform_query(interface,query_key,title_code,rdjb,queried_at,status,created_at) values('business_list',?,?,?,'2026-01-01T00:00:00Z','failed','2026-01-01T00:00:00Z')`).run('name:'+valid.enterprise.name,title,title==='innovative_sme'?'1':title==='specialized_sme'?'2':'3')
    const pending=f.candidate('P409-'+title,[{eventType:'review',year:2022,batchSeq:1,decidedYear:null,reviewOutcome:null}],title)
    const failed=f.candidate('F409-'+title,[{eventType:'review',year:2022,batchSeq:1,decidedYear:2025,reviewOutcome:'failed'}],title)
    const absent=f.candidate('N409-'+title,undefined,title)
    const missingQuery = f.db.$client.prepare(`insert into platform_query(interface,query_key,title_code,rdjb,queried_at,status,created_at) values('recognized_list',?,?,?,'2026-01-01T00:00:00Z','no_record','2026-01-01T00:00:00Z')`).run(absent.enterprise.usccNorm,title,title==='innovative_sme'?'1':title==='specialized_sme'?'2':'3')
    for (const [enterprise, queryId, queryStatus] of [[valid.enterprise, Number(failedQuery.lastInsertRowid), 'failed'], [absent.enterprise, Number(missingQuery.lastInsertRowid), 'no_record']] as const) {
      const snapshot = readCurrentQualificationAssessment(f.db.$client, enterprise.id)
      expect(snapshot.enterpriseId).toBe(enterprise.id)
      expect(snapshot.titles.map(item => item.titleCode)).toEqual(['little_giant','specialized_sme','innovative_sme'])
      const selected = snapshot.titles.find(item => item.titleCode === title)!
      expect(selected).toMatchObject({ titleCode: title, group: 'eligible', officialQualification: { group: 'eligible' } })
      expect(selected.platform.observations).toContainEqual(expect.objectContaining({ queryId, queryStatus, titleCode: title, applicability: 'at_or_before_as_of' }))
      expect(f.db.$client.prepare('select id,query_key as queryKey,title_code as titleCode,status from platform_query where id=?').get(queryId)).toEqual({ id: queryId, queryKey: queryStatus === 'failed' ? 'name:' + enterprise.name : enterprise.usccNorm, titleCode: title, status: queryStatus })
    }
    // The final candidate is beyond default query page size. Export accepts no page filters.
    for(let i=0;i<26;i++) f.candidate('Q409-'+title+'-'+i,undefined,title)
    const accepted=await fetch(f.url('/api/roster/exports/current/'+path),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'E409-'+title})})
    expect(accepted.status).toBe(202)
    const job=await f.terminal((await accepted.json()).jobId); expect(job.state,JSON.stringify(job)).toBe('done')
    const {wb}=await f.download(job)
    const names=(sheet:string)=>wb.getWorksheet(sheet)!.getRows(2,Math.max(0,wb.getWorksheet(sheet)!.rowCount-1))?.map(r=>r.getCell(2).value)??[]
    expect(names('有效企业')).toEqual(expect.arrayContaining([valid.enterprise.name,absent.enterprise.name,'Q409-'+title+'-25']))
    expect(names('待确认')).toContain(pending.enterprise.name)
    expect(names('排除明细')).toContain(failed.enterprise.name)
    expect(job.result.total).toBe(Object.values(job.result.counts).reduce((a:any,b:any)=>a+b,0))
    expect(wb.worksheets.slice(0,3).reduce((n,s)=>n+s.rowCount-1,0)).toBe(job.result.total)
    expect(wb.worksheets.slice(0,3).every(s=>s.getRow(1).cellCount===12)).toBe(true)
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

it('B409 separates three title groups and exhausts 201 public query and Excel members', async () => {
  f.resetBusiness()
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
    ['little_giant','eligible'], ['specialized_sme','pending'], ['innovative_sme','excluded'],
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
  const locatedResponse = await fetch(f.url('/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: 'specialized_sme', q: B409.name })), { headers: f.headers })
  expect(locatedResponse.status).toBe(200)
  const located = await locatedResponse.json()
  expect(located).toMatchObject({ total: 0, rows: [], publishedPending: { requested: true, total: 1 } })
  expect(located.publishedPending.rows.map((row: { enterpriseId: number }) => row.enterpriseId)).toEqual([stable.enterprise.id])
  expect(located.publishedPending.rows[0].qualificationAssessment).toEqual(readCurrentQualificationAssessment(f.db.$client, stable.enterprise.id, Date.parse(located.snapshotStartedAt)))
  const unrequested = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme'), { headers: f.headers })
  expect(unrequested.status).toBe(200)
  expect(await unrequested.json()).toMatchObject({ total: 0, rows: [], publishedPending: { requested: false, rows: [], total: 0 } })

  for (const literal of B409.titles) {
    const accepted = await fetch(f.url('/api/roster/exports/current/' + literal.path), { method: 'POST', headers: f.headers, body: JSON.stringify({ clientRequestId: 'B409-' + literal.title }) })
    expect(accepted.status).toBe(202)
    const job = await f.terminal((await accepted.json()).jobId)
    expect(job.state, JSON.stringify(job)).toBe('done')
    expect(job.params.titleCode).toBe(literal.title)
    expect(job.result.snapshotId).toBe(job.id)
    const { wb } = await f.download(job)
    expect(wb.worksheets.map(sheet => sheet.name)).toEqual(['有效企业','待确认','排除明细','口径说明'])
    expect(job.result.counts).toEqual(literal.counts)
    expect(job.result.total).toBe(literal.title === 'little_giant' ? 201 : 1)
    for (const sheet of wb.worksheets.slice(0,3)) {
      expect(sheet.getRow(1).values).toEqual([undefined, ...HEADERS_409])
      const names = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2).getCell(2).value)
      expect(names).toEqual(sheet.name === literal.sheet ? literal.title === 'little_giant' ? expectedNames : [B409.name] : [])
      for (let i = 2; i <= sheet.rowCount; i++) {
        expect(sheet.getRow(i).cellCount).toBe(12)
        expect(sheet.getRow(i).getCell(5).value).toBe(literal.label)
      }
    }
    const targetRow = wb.getWorksheet(literal.sheet)!.getRow(2)
    expect(targetRow.getCell(7).value).toBe(literal.qualification)
    if (literal.title === 'specialized_sme') expect(targetRow.getCell(11).value).toContain('复核结论/结论年份/批次不完整')
    if (literal.title === 'innovative_sme') expect(targetRow.getCell(11).value).toContain('对应认定周期复核明确不通过，未见后续重新认定恢复')
    expectIndependent409Digest(wb, job.result, literal.title, identityByName)
    expect(f.businessDigest()).toBe(businessBefore)
  }
  expect(f.db.$client.pragma('query_only', { simple: true })).toBe(1)
  expect(f.businessDigest()).toBe(businessBefore)
}, 30000)

function expectIndependent409Digest(wb: ExcelJS.Workbook, result: { generatedAt: string; dataVersion: string }, title: string, identityByName: ReadonlyMap<string, number>) {
  const at = Date.parse(result.generatedAt)
  expect(new Date(at).getUTCFullYear()).toBe(2026)
  const digest = createHash('sha256').update(JSON.stringify(['current-export-assessment-409-v2',QUALIFICATION_ASSESSMENT_VERSION,CURRENT_RULE_VERSION,2026,title]) + '\n')
  for (const [group, sheetName] of [['eligible','有效企业'],['pending','待确认'],['excluded','排除明细']] as const) {
    const sheet = wb.getWorksheet(sheetName)!
    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex++) {
      const values = Array.from({ length: 12 }, (_, c) => sheet.getRow(rowIndex).getCell(c + 1).value)
      const id = identityByName.get(String(values[1]))!
      expect(id).toBeTypeOf('number')
      const snapshot = readCurrentQualificationAssessment(f.db.$client, id, at)
      expect(snapshot.titles.map(item => item.titleCode)).toEqual(['little_giant','specialized_sme','innovative_sme'])
      expect(snapshot).toMatchObject({ enterpriseId: id, asOf: result.generatedAt, ruleVersion: CURRENT_RULE_VERSION, assessmentVersion: QUALIFICATION_ASSESSMENT_VERSION })
      const { titles, snapshotId, ...scope } = snapshot
      expect(snapshotId).toBe(createHash('sha256').update(JSON.stringify([scope,titles])).digest('hex'))
      digest.update(JSON.stringify([group,id,scope,snapshotId,values]) + '\n')
    }
  }
  expect(result.dataVersion).toBe('sha256:' + digest.digest('hex'))
}
