import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { initializeDb, schema as s } from '../../../db/client'
import { CURRENT_TITLES, createCurrentQualificationAssessmentReader } from '../../../lib/roster/current-qualification'
import { listCurrentQualified, listCurrentQualifiedWithCandidatesAndWitnesses } from '../../../lib/roster/current-qualified-query'
import { createTargetCurrentCandidateReader } from '../../../lib/roster/current-candidates-target'
import { createTargetRecognizedWitnessReader } from '../../../lib/roster/recognized-witness-target'
import { readTargetIdentityKeyVariants } from '../../../lib/roster/current-identity-keys'
import { readQueryCoverage, readQueryCoverageBatch } from '../../../lib/roster/query-assessment'
import { currentWorkbookValues } from '../../../lib/roster/current-workbook-presentation'
import { writeCurrentWorkbook, writeCurrentWorkbookWithCandidates } from '../../../lib/roster/current-workbook'
import { writeNewCollectionTarget } from '../../../lib/platform/collection-target-command'
import { platformResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'

const roots: string[] = [], dbs: ReturnType<typeof initializeDb>[] = []
const at = Date.parse('2026-11-14T04:00:00Z')
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.$client.close(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(count = 12) {
  const dir = mkdtempSync(join(tmpdir(), 'assessment-batch-')); roots.push(dir)
  const db = initializeDb({ dbPath: join(dir, 'native.sqlite'), create: true }); dbs.push(db)
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const e = db.insert(s.enterprise).values({ name: `分块企业${i}`, nameNorm: `分块企业${i}`, usccNorm: `SYNTHETIC-BATCH-${i}`, district: i % 2 ? '鄞州区' : '海曙区' }).returning().get(); ids.push(e.id)
    db.insert(s.enterpriseAlias).values({ enterpriseId: e.id, name: `分块曾用名${i}`, nameNorm: `分块曾用名${i}`, verificationStatus: 'confirmed', sourceKind: 'manual' }).run()
    for (const [index, title] of CURRENT_TITLES.entries()) {
      const r = db.insert(s.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: title, nameRaw: e.name }).returning().get()
      const event = db.insert(s.recordEvent).values({ recordId: r.id, eventType: i % 4 === 0 && index === 0 ? 'nurture' : 'award', year: i % 3 === 0 ? 2020 : 2025, batchSeq: 1 }).returning().get()
      db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'jxj/synthetic-batch.pdf', page: 2, listNo: i + 1 }).run()
    }
    if (i % 5 === 0) db.insert(s.enterpriseFactRevision).values({ enterpriseId:e.id, factId:1, revision:1, status:'confirmed', fact:{kind:i % 10 === 0 ? 'cancelled':'moved_out',source:{reference:'合成正式来源',statement:'明确生效'},effective:{precision:'day',value:'2026-01-01'}},action:'assert',actor:{type:'agent',id:'batch-test'},basis:'合成确认依据',createdAt:'2026-01-02T00:00:00Z' }).run()
  }
  return { db, ids, dir }
}
it('keeps full three-title snapshots and workbook cells exact with bounded input reads and fresh commits', () => {
  const { db, ids } = fixture(24), reader = createCurrentQualificationAssessmentReader(db.$client)
  const keys = readTargetIdentityKeyVariants(db.$client, 'queries')
  for (const title of CURRENT_TITLES) {
    db.$client.exec('BEGIN')
    try {
      const expected = ids.map(id => reader.readWorkbook(id, at, title, keys))
      const actual = reader.readWorkbookBatch(ids, at, title, keys)
      expect(actual).toEqual(expected)
      const scoped = reader.readWorkbookRowsBatch(ids, at, title, keys)
      expect(scoped.every(read => read.snapshot.titles.length === 1 && read.snapshot.titles[0]?.titleCode === title)).toBe(true)
      expect(scoped.map(read => read.rows[0])).toEqual(expected.map(read => read.rows.find(row => row.assessment?.titleCode === title)))
      expect(scoped.map(read => read.workbookPublished)).toEqual(expected.map(read => read.workbookPublished))
      expect(actual.map(r => JSON.stringify(r.snapshot))).toEqual(expected.map(r => JSON.stringify(r.snapshot)))
      expect(actual.map((r, i) => currentWorkbookValues(title, r.rows.find(row => row.assessment?.titleCode === title)!, i + 1, r.workbookPublished)))
        .toEqual(expected.map((r, i) => currentWorkbookValues(title, r.rows.find(row => row.assessment?.titleCode === title)!, i + 1, r.workbookPublished)))
      expect([...reader.readEffectiveTitles(ids, at, title)]).toEqual(ids.map(id => [id, reader.readEffectiveTitle(id, title, at).effectiveStatus]))
    } finally { db.$client.exec('ROLLBACK') }
  }
  const first = ids[1]!
  db.$client.prepare('UPDATE record_event SET year=2020 WHERE record_id IN (SELECT id FROM record WHERE enterprise_id=?)').run(first)
  db.$client.exec('BEGIN')
  try { expect(reader.readEffectiveTitles([first], at, 'little_giant').get(first)).toBe('expired') } finally { db.$client.exec('ROLLBACK') }
})
it('preserves three-title filters counts options and pagination on a compact consumer matrix', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  // 24 rows retain a nonempty second page and every fixture status/identity partition.
  const { db } = fixture(24), candidates = createTargetCurrentCandidateReader(db), witnesses = createTargetRecognizedWitnessReader(db)
  for (const titleCode of CURRENT_TITLES) for (const filter of [{ page:2, pageSize:7 }, { q:'曾用名1', district:'鄞州区', pageSize:10 }, { status:'expired' as const, pageSize:10 }, { status:'terminated' as const }, { recognitionFrom:'2025-01-01', recognitionTo:'2025-12-31', validYear:2028 }]) {
    const request = { titleCode, ...filter }
    expect(listCurrentQualified(db.$client, request)).toEqual(listCurrentQualifiedWithCandidatesAndWitnesses(db.$client, request, candidates, witnesses))
  }
})
it('preserves cross-block pagination and real export cells through the native consumer', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  // Production candidate blocks hold 128 IDs. Keep the first ID in the second
  // block effective and assert it survives both list hydration and XLSX output.
  const { db, ids, dir } = fixture(129), candidates = createTargetCurrentCandidateReader(db), witnesses = createTargetRecognizedWitnessReader(db)
  const request = { titleCode: 'specialized_sme' as const, sort: 'id_asc' as const, page: 2, pageSize: 60 }
  const listed = listCurrentQualified(db.$client, request)
  expect(listed).toEqual(listCurrentQualifiedWithCandidatesAndWitnesses(db.$client, request, candidates, witnesses))
  expect(listed.rows.map(row => row.name)).toContain('分块企业128')
  const file = join(dir, 'batch.xlsx'), oracle = join(dir, 'single.xlsx')
  const actual = await writeCurrentWorkbook(db.$client, 'specialized_sme', file, () => {})
  const expected = await writeCurrentWorkbookWithCandidates(db.$client, 'specialized_sme', oracle, () => {}, candidates)
  const { dataVersion: actualVersion, ...actualSummary } = actual
  const { dataVersion: expectedVersion, ...expectedSummary } = expected
  expect(actualSummary).toEqual(expectedSummary)
  expect(actualVersion).not.toBe(expectedVersion)
  const sheets = async (path: string) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path); return wb.worksheets.map(sheet => ({ name:sheet.name, rows:sheet.getSheetValues() })) }
  const actualSheets = await sheets(file)
  expect(actualSheets).toEqual(await sheets(oracle))
  expect(actualSheets[0]!.rows.filter(Array.isArray).map(row => row[2])).toContain('分块企业128')
  expect(ids).toHaveLength(129)
})
it('preserves per-title query limits ordering and fresh metadata through batched coverage', () => {
  const { db, ids } = fixture(2)
  for (let i = 0; i < 110; i++) {
    const evidence: PlatformLiveQueryResult = { source:'queryBusList',status:'no_record',effectiveConditions:{name:'分块企业1',combination:'and'},titleScope:{mode:'selected',rdjb:[i % 2 ? '2':'3']},queriedAt:new Date(at + i * 1000).toISOString(),completedAt:new Date(at + i * 1000 + 100).toISOString(),rows:[],pages:[{source:'queryBusList',rdjb:i % 2 ? '2':'3',page:1,status:'success',fetchedCount:0,declaredTotal:0,error:null}],fetchedCount:0,declaredTotal:0,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50} }
    writeNewCollectionTarget(db,{queryText:JSON.stringify(platformResultToImport(evidence)),evidenceText:JSON.stringify(evidence),createdAt:evidence.completedAt!,assignments:[]})
  }
  const scopes = ids.flatMap(enterpriseId => CURRENT_TITLES.map(titleCode => ({ enterpriseId, titleCode, direction:'missing_in_miit' as const })))
  for (const variants of [undefined, readTargetIdentityKeyVariants(db.$client,'queries')]) {
    const actual = readQueryCoverageBatch(db, scopes, variants)
    for (const scope of scopes) expect(actual.get(scope.enterpriseId)?.get(scope.titleCode)).toEqual(readQueryCoverage(db, scope, variants))
    expect(actual.get(ids[1]!)?.get('specialized_sme')).toMatchObject({truncated:true})
    expect(actual.get(ids[1]!)?.get('specialized_sme')?.sources).toHaveLength(50)
  }
})

it('bounds foundation SQL by block and retains merged ancestor exclusions without auditing every observation', () => {
  const { db, ids } = fixture(40)
  const trace: string[] = [], prepare = db.$client.prepare.bind(db.$client)
  vi.spyOn(db.$client, 'prepare').mockImplementation(text => {
    const statement = prepare(text)
    const all = statement.all.bind(statement), get = statement.get.bind(statement)
    vi.spyOn(statement, 'all').mockImplementation((...args) => { trace.push(text); return all(...args) })
    vi.spyOn(statement, 'get').mockImplementation((...args) => { trace.push(text); return get(...args) })
    return statement
  })
  const reader = createCurrentQualificationAssessmentReader(db.$client)
  db.$client.exec('BEGIN')
  try {
    trace.length = 0
    reader.readEffectiveTitles(ids, at, 'innovative_sme')
    const foundation = trace.filter(text => /from ["`]?(?:enterprise|record|enterprise_alias|enterprise_fact_revision|stored_file)["`]?(?:\s|$)/i.test(text))
    expect(foundation.length).toBeLessThanOrEqual(10)
    expect(foundation.filter(text => /from ["`]?record["`]?(?:\s|$)/i.test(text))).toHaveLength(3)
  } finally { db.$client.exec('ROLLBACK') }
  db.insert(s.enterpriseMerge).values({ fromEnterpriseId:ids[0]!,intoEnterpriseId:ids[1]!,basis:'合成归并',recordedAt:'2026-11-14T00:00:00Z' }).run()
  db.$client.exec('BEGIN')
  try {
    expect(reader.readEffectiveTitles([ids[0]!,ids[1]!],at,'specialized_sme')).toEqual(new Map([[ids[0]!, 'terminated'],[ids[1]!, 'terminated']]))
    expect(reader.readWorkbookBatch([ids[0]!],at,'specialized_sme')).toEqual([reader.readWorkbook(ids[0]!,at,'specialized_sme')])
  } finally { db.$client.exec('ROLLBACK') }
  trace.length = 0
  expect(listCurrentQualified(db.$client,{titleCode:'little_giant',pageSize:2}).rows.length).toBeGreaterThan(0)
  expect(trace.some(text => text.includes('candidate_scope_rdjb') && text.includes(' is not '))).toBe(false)
})
