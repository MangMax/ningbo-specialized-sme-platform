import { commitRecordCorrespondences, preflightRecordCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { createRuntimeSchema } from '../../../db/create-runtime'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../db/schema'
import { listCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query'
import { writeCurrentWorkbook } from '../../../layers/sme-roster/lib/roster/current-workbook'
import ExcelJS from 'exceljs'
import { prepareCurrentReader, readCurrentQualificationAssessment } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { qualificationFileFixture } from '../fixtures/qualification-matrix'
import { readExportWorkbook } from '../../support/read-workbook'

const handles: Database.Database[] = []
const directories: string[] = []
const qualificationFixtures: ReturnType<typeof qualificationFileFixture>[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const fixture of qualificationFixtures.splice(0)) fixture.close()
  for (const db of handles.splice(0)) if (db.open) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function consumerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cover363-consumer-'))
  const sqlite = new Database(join(dir, 'synthetic.sqlite'))
  handles.push(sqlite); directories.push(dir)
  sqlite.pragma('foreign_keys=ON')
  createRuntimeSchema(sqlite)
  const db = drizzle(sqlite)
  for (const [offset, title] of ['innovative_sme', 'specialized_sme', 'little_giant'].entries()) {
    for (let n = 1; n <= 4; n++) {
      const id = offset * 4 + n
      const name = n === 1 ? '=1+1' : n === 2 ? 'Zeta\n企业😀' : `候选${id}`
      db.insert(s.enterprise).values({ id, name, nameNorm: name, usccNorm: String(id).padStart(18, '0'), district: n === 2 ? '海曙区' : '鄞州区', city: '宁波市' }).run()
      db.insert(s.record).values({ id, enterpriseId: id, titleCode: title, source: 'jxj', nameRaw: name }).run()
      db.insert(s.recordEvent).values({ id, recordId: id, eventType: n === 4 ? 'nurture' : 'award', year: n === 3 ? 2020 : 2026, batchSeq: 1 }).run()
      db.insert(s.recordEvidence).values({ id, recordEventId: id, sourceFile: 'jxj/announcement/synthetic363.pdf', attachment: '名单\n附件', listNo: id, page: 7 }).run()
    }
  }
  return { db: sqlite, dir }
}

const titles = [
  { title: 'innovative_sme', rdjb: '1' },
  { title: 'specialized_sme', rdjb: '2' },
  { title: 'little_giant', rdjb: '3' },
] as const

// in 2026, +1 also awarded 2026, +2 awarded 2020, +3 nurture only.
// Lower-title 2020 awards expire annually; giant 11 retains original recognition
// and is included in both lower titles without fabricating their history.
const consumerOracle = {
  innovative_sme: { candidates: [1,2,3,4,5,6,7,8,9,10,11,12], eligible: [1,2,5,6,9,10,11], expired: [3], unrecognized: [4,7,8,12] },
  specialized_sme: { candidates: [5,6,7,8,9,10,11,12], eligible: [5,6,9,10,11], expired: [7], unrecognized: [8,12] },
  little_giant: { candidates: [9,10,11,12], eligible: [9,10,11], expired: [], unrecognized: [12] },
}
it.each(titles)('fixed-time list literals preserve qualification filters options witnesses basis and references for $title', ({ title }) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), first = title === 'innovative_sme' ? 1 : title === 'specialized_sme' ? 5 : 9
  const oracle = consumerOracle[title], ids = oracle.eligible
  const filters = [
    {}, { page: 2, pageSize: 1 }, { q: '=1+1', district: '鄞州区' }, { q: String(first).padStart(18, '0') },
    { district: '不存在' }, { sort: 'name_desc' as const }, { sort: 'name_asc' as const }, { page: 4, pageSize: 1 },
    { recognitionFrom: '2026-01-01', recognitionTo: '2026-12-31' },
    { recognitionFrom: '2026-06-01', recognitionTo: '2026-12-31' },
    { validYear: 2026 }, { maintenanceYear: 2026 }, { maintenanceYear: 2026, maintenanceBatch: 1 },
  ]
  const read = () => filters.map(filter => listCurrentQualified(f.db, { titleCode: title, ...filter }))
  const covered = read()
  const all = covered[0]!
  expect(all).toMatchObject({ total: ids.length, uncertainTotal: 0, titleCode: title, ruleVersion: 'current-roster-116-v14', snapshotStartedAt: '2026-10-26T00:00:00.000Z', options: { recognitionYears: title === 'little_giant' ? [2020, 2026] : [2026], validYears: [], maintenanceYears: [], maintenanceBatchesByYear: {} } })
  expect(all.rows.map(row => row.enterpriseId)).toEqual(ids)
  expect(all.rows[0]).toMatchObject({ name: '=1+1', uscc: String(first).padStart(18, '0'), district: '鄞州区', group: 'eligible', firstYear: 2026, publishedNames: ['=1+1'], aliases: [], publication: '已见本称号宁波公布记录', basis: `event:${first}@1 award 2026/1 结论年:`, reviews: '', references: [`evidence:${first} jxj/announcement/synthetic363.pdf 名单\n附件 序号:${first}`], recognition: { precision: 'year', year: 2026 }, matchedValidYears: [], matchedMaintenance: [] })
  expect(all.rows[0]!.qualificationWitnesses).toEqual([{ cycle: { originYear: 2026, batchSeq: 1 }, awardEventId: first, recognition: { precision: 'year', year: 2026 }, matchedValidYear: null, matchedMaintenance: null, correspondenceId: null, conditionQueryId: null }])
  expect(covered[1]).toMatchObject({ total: ids.length, page: 2, pageSize: 1, rows: [{ enterpriseId: first + 1 }] })
  expect(covered[2]!.rows.map(row => row.enterpriseId)).toEqual(ids.filter(id => id % 4 === 1))
  expect(covered[3]!.rows.map(row => row.enterpriseId)).toEqual([first])
  expect(covered[4]).toMatchObject({ total: 0, rows: [] })
  expect(covered[5]!.rows.map(row => row.enterpriseId)).toEqual([...ids.filter(id => id % 4 === 3), ...ids.filter(id => id % 4 === 2), ...ids.filter(id => id % 4 === 1)])
  expect(covered[6]!.rows.map(row => row.enterpriseId)).toEqual([...ids.filter(id => id % 4 === 1), ...ids.filter(id => id % 4 === 2), ...ids.filter(id => id % 4 === 3)])
  expect(covered[7]).toMatchObject({ total: ids.length, rows: ids.length > 3 ? [{ enterpriseId: ids[3] }] : [] })
  // Recognition filters require own-title witnesses; inherited grants do not fabricate them.
  expect(covered[8]).toMatchObject({ total: 2, uncertainTotal: title === 'little_giant' ? 0 : ids.length - 2 })
  expect(covered[8]!.rows.map(row => row.enterpriseId)).toEqual([first, first + 1])
  expect(covered[9]).toMatchObject({ total: 0, uncertainTotal: title === 'little_giant' ? 2 : ids.length, rows: [] })
  for (const result of covered.slice(10)) expect(result).toMatchObject({ total: 0, uncertainTotal: 0, rows: [] })
  expect(JSON.stringify(all)).not.toMatch(/rawFields|rawResponse|workbookFacts/)
})
it.each(titles)('fixed-time workbook literals preserve all sheets columns text and dataVersion for $title', async ({ title }) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), first = title === 'innovative_sme' ? 1 : title === 'specialized_sme' ? 5 : 9
  const run = async (name: string) => {
    const progress: unknown[] = [], path = join(f.dir, name)
    const result = await writeCurrentWorkbook(f.db, title, path, (...args) => progress.push(args))
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path)
    return { result, progress, workbook }
  }
  const covered = await run('native.xlsx')
  const oracle = consumerOracle[title]
  expect(covered.result).toMatchObject({ total: oracle.candidates.length, counts: { eligible: oracle.eligible.length, pending: 0, excluded: oracle.candidates.length - oracle.eligible.length }, generatedAt: '2026-10-26T00:00:00.000Z', snapshotStartedAt: '2026-10-26T00:00:00.000Z', ruleVersion: 'current-roster-116-v14' })
  // Hash independently from public full assessment scoped to the requested title
  // and ExcelJS's real text cells, never from writer rows or its returned digest.
  const hash = createHash('sha256').update(JSON.stringify(['current-export-assessment-title-v3', 'enterprise-qualification-807-v7', 'current-roster-116-v14', 2026, title]) + '\n')
  for (const [group, sheetName, ids] of [['effective', '有效企业', oracle.eligible], ['expired', '已到期', oracle.expired], ['unrecognized', '未认定', oracle.unrecognized]] as const) {
    const sheet = covered.workbook.getWorksheet(sheetName)!
    expect(sheet.rowCount).toBe(ids.length + 1)
    for (const [index, id] of ids.entries()) {
      const full = readCurrentQualificationAssessment(f.db, id, Date.parse('2026-10-26T00:00:00Z'))
      const { titles: allTitles, snapshotId: _fullDigest, ...scope } = full
      const selected = allTitles.filter(item => item.titleCode === title)
      expect(selected[0]!.effectiveQualification!.status).toBe(group)
      expect(scope).toMatchObject({ enterpriseId: id, assessmentVersion: 'enterprise-qualification-807-v7', ruleVersion: 'current-roster-116-v14' })
      const sourceTitle = id <= 4 ? 'innovative_sme' : id <= 8 ? 'specialized_sme' : 'little_giant'
      const source = allTitles.find(item => item.titleCode === sourceTitle)!
      expect(source.evidence).toEqual([{ eventId: id, revision: 1, eventType: id % 4 === 0 ? 'nurture' : 'award', year: id % 4 === 3 ? 2020 : 2026, batchSeq: 1, decidedYear: null, reviewOutcome: null, evidenceIds: [id] }])
      expect(source.sourceVersions).toEqual([{ evidenceId: id, eventId: id, sourceFile: 'jxj/announcement/synthetic363.pdf', storedFileId: null, sha256: null, bytes: null, removedAt: null, capturedRevision: null, capturedSha256: null }])
      if (group === 'effective' && sourceTitle !== title) {
        expect(selected[0]!.evidence).toEqual([])
        expect(selected[0]!.effectiveQualification!.localRuleBasis).toContain(sourceTitle === 'little_giant'
          ? '按有效小巨人资格计入；实际支撑称号：小巨人'
          : '按有效专精特新中小企业资格计入；实际支撑称号：专精特新中小企业')
      }
      const snapshotId = createHash('sha256').update(JSON.stringify([scope, selected])).digest('hex')
      const values = Array.from({ length: 15 }, (_, column) => sheet.getRow(index + 2).getCell(column + 1).value)
      expect(values[0]).toBe(String(index + 1))
      expect(values[1]).toBe(id % 4 === 1 ? '=1+1' : id % 4 === 2 ? 'Zeta\n企业😀' : `候选${id}`)
      expect(values[2]).toBe(String(id).padStart(18, '0'))
      values[13] ??= ''; values[14] ??= ''
      hash.update(JSON.stringify([group, id, scope, snapshotId, values]) + '\n')
    }
  }
  expect(covered.result.dataVersion).toBe('sha256:' + hash.digest('hex'))
  expect(covered.progress).toEqual([[0, oracle.candidates.length, '2026-10-26T00:00:00.000Z']])
  expect(covered.workbook.worksheets.map(sheet => sheet.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
  expect(covered.workbook.worksheets.map(sheet => sheet.rowCount)).toEqual([oracle.eligible.length + 1, oracle.expired.length + 1, 1, 1, oracle.unrecognized.length + 1, 9])
  const headers = ['序号', '企业名称', '统一社会信用代码', '区县', '称号', '首次认定年份', '认定及复核情况', '公布名称', '已确认曾用名', '公布对应情况', '情况说明', '来源及页码', '有效状态', '有效期及排除依据', '资料缺口与来源备注']
  for (const sheet of covered.workbook.worksheets.slice(0, 5)) {
    expect(sheet.getRow(1).values).toEqual([undefined, ...headers])
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 1 })
    sheet.eachRow(row => row.eachCell(cell => { expect(cell.type).not.toBe(ExcelJS.ValueType.Formula); expect(typeof cell.value).toBe('string') }))
  }
  const eligible = covered.workbook.getWorksheet('有效企业')!
  expect(eligible.getCell('B2').value).toBe('=1+1')
  expect(eligible.getCell('C2').value).toBe(String(first).padStart(18, '0'))
  expect(eligible.getCell('B3').value).toBe('Zeta\n企业😀')
  expect(eligible.getCell('F2').value).toBe('2026')
  expect(eligible.getCell('L2').value).toContain('名单\n附件')
  expect(eligible.getCell('L2').value).toContain(`名单序号${first}`)
  expect(eligible.getCell('L2').value).toContain('第7页')
  expect(eligible.autoFilter).toBe(`A1:O${oracle.eligible.length + 1}`)
  expect(covered.workbook.getWorksheet('已到期')!.getCell('B2').value).toBe(title === 'little_giant' ? null : `候选${first + 2}`)
  expect(covered.workbook.getWorksheet('未认定')!.getCell('B2').value).toBe(`候选${first + 3}`)
  expect(f.db.inTransaction).toBe(false)
})
it('both consumers read a native readonly file without changing database bytes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), path = f.db.name
  f.db.close()
  const before = readFileSync(path), readonly = new Database(path, { readonly: true, fileMustExist: true }); handles.push(readonly)
  expect(listCurrentQualified(readonly, { titleCode: 'innovative_sme' })).toMatchObject({ total: 7, rows: [1,2,5,6,9,10,11].map(enterpriseId => ({ enterpriseId })) })
  expect(await writeCurrentWorkbook(readonly, 'innovative_sme', join(f.dir, 'readonly.xlsx'), () => {})).toMatchObject({ total: 12, counts: { eligible: 7, pending: 0, excluded: 5 } })
  expect(readFileSync(path).equals(before)).toBe(true)
})
it('confirmed recognized witness preserves positive options filters and source pointers', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), db = drizzle(f.db, { schema: s }), stamp = '2026-10-25T00:00:00Z'
  const rawFields = { id: 'synthetic363-recognized', qymc:'=1+1',tyshxydm:'000000000000000001', rddqrq: '2028-11-20', whpc: '2025-2' }
  const seeded = submitNativePlatformQuery(db, { interface: 'recognized_list', queryKey: '000000000000000001', rdjb: '1', titleCode: 'innovative_sme', queriedAt: stamp, status: 'success', collectionEvidence: {
    source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and', rddqrq: '2028', whpcyear: '2025', whpc: '2' },
    titleScope: { mode: 'selected', rdjb: ['1'] }, queriedAt: stamp, completedAt: stamp,
    rows: [rawFields], pages: [{ source: 'queryBusList', rdjb: '1', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error:null }],
    fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
  }, relations:[{ sequenceNo:1,relationKey:rawFields.id,enterpriseId:1,usccRaw:'000000000000000001',nameRaw:'=1+1',rawFields,verificationStatus:'confirmed',matchBasis:'uscc' }] })
  const request = { idempotencyKey: 'cover363-recognized', sourceIdentity: 'synthetic/cover363', actor: { type: 'agent' as const, id: 'synthetic363' }, basis: 'Synthetic confirmed event and recognized row', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_recognized' as const, eventId: 1, relationId: seeded.relationIds[0]!, role: 'recognized_corrob' as const } }] }
  const plan = preflightRecordCorrespondences(db, request)
  commitRecordCorrespondences(db, request, plan.planHash)
  const filters = [{}, { validYear: 2028, maintenanceYear: 2025 }, { validYear: 2029 }, { maintenanceYear: 2025, maintenanceBatch: 2 }]
  const read = () => filters.map(filter => listCurrentQualified(f.db, { titleCode: 'innovative_sme', ...filter }))
  const covered = read()
  expect(covered[0]).toMatchObject({ total: 7, options: { recognitionYears: [2026], validYears: [2028], maintenanceYears: [2025], maintenanceBatchesByYear: {} } })
  expect(covered[1]).toMatchObject({ total: 1, rows: [{ enterpriseId: 1, matchedValidYears: [2028], matchedMaintenance: [{ year: 2025, batch: null }] }] })
  expect(covered[1]!.rows[0]!.qualificationWitnesses).toEqual([{ cycle: { originYear: 2026, batchSeq: 1 }, awardEventId: 1, recognition: { precision: 'year', year: 2026 }, matchedValidYear: 2028, matchedMaintenance: { year: 2025, batch: null }, correspondenceId: 1, conditionQueryId: 1 }])
  expect(covered[1]!.rows[0]!.references).toEqual(['evidence:1 jxj/announcement/synthetic363.pdf 名单\n附件 序号:1', 'platform-relation:1 query:1', 'correspondence:1@2 confirmed'])
  expect(covered[2]).toMatchObject({ total: 0, rows: [] })
  expect(covered[3]).toMatchObject({ total: 0, rows: [] })
})
it('confirmed alias filtering preserves identity references and excludes pending aliases', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), db = drizzle(f.db)
  db.insert(s.enterpriseAlias).values({ id: 1, enterpriseId: 1, name: '原公布名称', nameNorm: '原公布名称', sourceKind: 'manual', verificationStatus: 'confirmed' }).run()
  db.insert(s.enterpriseAlias).values({ id: 2, enterpriseId: 2, name: '原公布名称', nameNorm: '原公布名称', sourceKind: 'manual', verificationStatus: 'pending' }).run()
  const read = () => listCurrentQualified(f.db, { titleCode: 'innovative_sme', q: '原公布名称', district: '鄞州区' })
  const covered = read()
  expect(covered).toMatchObject({ total: 1, rows: [{ enterpriseId: 1, aliases: ['原公布名称'], references: ['evidence:1 jxj/announcement/synthetic363.pdf 名单\n附件 序号:1', 'alias:1@1'] }] })
})

it.each(['innovative_sme', 'specialized_sme', 'little_giant'] as const)('native qualified query and parsed workbook preserve platform-only candidates for %s', async title => {
  const f = qualificationFileFixture()
  qualificationFixtures.push(f)
  prepareCurrentReader(f.sqlite)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-05T04:00:00Z'))
  const formal = f.formal('正式候选', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { title })
  const rdjb = { innovative_sme: '1', specialized_sme: '2', little_giant: '3' }[title]
  for (const id of [20, 21, 22]) {
    const name = '候选企业' + id
    const enterprise = f.db.insert(s.enterprise).values({ id, name, nameNorm: name, usccNorm: 'SYNTHETIC468-' + id }).returning().get()
    const stamp = '2026-10-01T00:00:00Z'
    const rawFields = { id: 'native468-' + id, qymc: name, tyshxydm: enterprise.usccNorm!, rdjb }
    const collectionEvidence = {
      source: 'queryBusList' as const, status: 'success' as const,
      effectiveConditions: { combination: 'and' as const, name },
      titleScope: { mode: 'selected' as const, rdjb: [rdjb] },
      queriedAt: stamp, completedAt: stamp, rows: [rawFields],
      pages: [{ source: 'queryBusList' as const, rdjb, page: 1, status: 'success' as const, fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
      fetchedCount: 1, declaredTotal: 1, completeness: 'complete' as const, fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
    }
    submitNativePlatformQuery(f.db, {
      interface: 'recognized_list', queryKey: 'name:' + name, titleCode: title, rdjb, queriedAt: stamp, status: 'success', collectionEvidence,
      relations: [{ sequenceNo: 1, relationKey: rawFields.id, enterpriseId: id === 20 ? null : id, nameRaw: name, usccRaw: rawFields.tyshxydm, rawFields, verificationStatus: 'confirmed', matchBasis: 'uscc' }],
    })
  }
  expect(listCurrentQualified(f.sqlite, { titleCode: title, page: 1, pageSize: 1 })).toMatchObject({ total: 1, rows: [{ enterpriseId: formal.enterprise.id }] })
  const path = join(f.sqlite.name, '..', 'candidate468-' + title + '.xlsx')
  const summary = await writeCurrentWorkbook(f.sqlite, title, path, () => {})
  const workbook = await readExportWorkbook(readFileSync(path))
  const names = workbook.worksheets.filter(sheet => sheet.name !== '口径说明').flatMap(sheet => (sheet.getRows(2, sheet.rowCount - 1) ?? []).map(row => row.getCell(2).value))
  expect(summary).toMatchObject({ total: 4, counts: { eligible: 1, pending: 0, excluded: 3 } })
  expect(names).toEqual(['正式候选', '候选企业20', '候选企业21', '候选企业22'])
})
