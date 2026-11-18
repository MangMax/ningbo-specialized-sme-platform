import { completeInProcessIntake } from '../imports/fixtures/in-process-intake'
import { createClassifiedFile } from '../../../layers/sme-roster/server/utils/roster-file-classification'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import ExcelJS from 'exceljs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../../../db/schema'
import type { OfficialPublishedRow, RosterImportPayload, RosterImportRecord } from '../../../layers/sme-roster/lib/roster-import-client'
import { preflightRosterImport, commitRosterImport } from '../../../layers/sme-roster/server/utils/roster-import'
import { handleRosterImportRequest } from '../../../layers/sme-roster/server/utils/roster-import-http'
import { handleEvidenceCorrectionRequest } from '../../../layers/sme-roster/server/utils/roster-evidence-correction-api'
import { readCurrentQualificationAssessment, createCurrentQualificationAssessmentReader, readCurrentCandidate, type CurrentTitle } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { writeCurrentWorkbook } from '../../../layers/sme-roster/lib/roster/current-workbook'
import { startHttpFixture } from '../../support/http'
import { minimalPdf } from '../../support/minimal-pdf'
import * as official from '../../../layers/sme-roster/server/utils/official-evidence'
import { assertOfficialPublishedBudget, readOfficialPublishedPresentation, OfficialPublishedPresentationError, type OfficialPublishedFact } from '../../../layers/sme-roster/lib/roster/official-published-presentation'
import { currentWorkbookValues } from '../../../layers/sme-roster/lib/roster/current-workbook-presentation'
import * as receiptRedaction from '../../../layers/sme-roster/server/utils/import-receipt-redaction'
import * as credentialState from '../../../layers/core/server/utils/credential-state'
import { readPublicPublishedNames, getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import { listCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query'

// Retain the original logical per-event page assertions while observing the new
// batch seam. This records real requests and always executes the real reader.
function observePublishedPages() {
  const page = vi.fn(), read = official.listEventsOfficialEvidencePages
  vi.spyOn(official, 'listEventsOfficialEvidencePages').mockImplementation((db, requests, options) => {
    for (const request of requests) page(db, request.eventId, { ...options, ...(request.afterEvidenceId === undefined ? {} : { afterEvidenceId: request.afterEvidenceId }) })
    return read(db, requests, options)
  })
  return page
}

const closes: Array<() => void | Promise<void>> = []
const qualificationYear = 2026
const executionTime = Date.parse('2026-10-25T08:00:00Z')
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(executionTime) })
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of closes.splice(0).reverse()) await close() })
const sourceBytes = minimalPdf({ pages: 1 })
const digest = createHash('sha256').update(sourceBytes).digest('hex')
const uscc = '91330211255994457P'
async function fixture() {
  const dir = mkdtempSync('/tmp/issue355-synthetic-'), filesDir = join(dir, 'files'); mkdirSync(filesDir)
  const sqlite = new Database(join(dir, 'synthetic.sqlite')); sqlite.pragma('foreign_keys=ON')
  closes.push(() => { expect(sqlite.pragma('foreign_key_check')).toEqual([]); sqlite.close() })
  const db = drizzle(sqlite, { schema }); createRuntimeSchema(sqlite)
  // Infrastructure catalog only. Normal domain facts below go through B public commands.
  for (const [index, path] of ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf'].entries()) {
    writeFileSync(join(filesDir, path), sourceBytes)
    createClassifiedFile(db, { id: index + 1, relPath: path, filename: path, ext: 'pdf', bytes: Buffer.byteLength(sourceBytes), sha256: digest, createdAt: 'synthetic' }, { source: 'jxj', kind: 'announcement' })
  }
  const server = await startHttpFixture({ routes: {
    ...Object.fromEntries((['preflight', 'commit'] as const).map(action => ['/import/' + action, (input: Parameters<typeof handleRosterImportRequest>[1]) => handleRosterImportRequest(action, input, { db, apiToken: 'synthetic-355', filesDir, executeImport: async (database, a, request, errors, context) => a === 'preflight' ? preflightRosterImport(database, request, errors, { ...context, filesDir }) : commitRosterImport(database, request, errors, { ...context, filesDir }) })])),
    ...Object.fromEntries((['preflight', 'commit'] as const).map(action => ['/correction/' + action, (input: Parameters<typeof handleRosterImportRequest>[1]) => handleEvidenceCorrectionRequest({ ...input, action }, { db, apiToken: 'synthetic-355', filesDir })])),
    '/exact': input => handleEvidenceCorrectionRequest({ ...input, action: 'get', id: input.query.id, query: { official: 'latest' } }, { db, apiToken: 'synthetic-355' }),
  } }); closes.push(server.close)
  const trace: unknown[] = []; closes.push(() => writeFileSync(join(dir, 'public-commands.json'), JSON.stringify(trace, null, 2)))
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(server.baseUrl + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer synthetic-355', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json(); trace.push({ path, body, status: response.status, result })
    expect(response.status, JSON.stringify(result)).toBe(200)
    return path === '/import/commit' ? await completeInProcessIntake(db, result, body as import('../../../layers/sme-roster/lib/roster-import-client').RosterImportRequest, filesDir) as typeof result : result
  }
  const commit = async (payload: RosterImportPayload, key: string) => {
    const request = { idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: 'synthetic-355', payload }
    const plan = await http('/import/preflight', request); expect(plan.preflight.conflicts).toEqual([])
    const result = await http('/import/commit', { ...request, payload: { ...payload, ...(plan.preflight.officialEvidencePlanHash ? { officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } : {}) } })
    expect(result.status, JSON.stringify(result)).toBe('committed'); return result
  }
  const published = (nameRaw: string | null, file = 1, listNo = 1, extra: Partial<OfficialPublishedRow> = {}): OfficialPublishedRow => ({ nameRaw, usccRaw: uscc, districtRaw: null, declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: '合成公布', docNumber: null, issueDate: null, path: ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf'][file - 1]! }, basis: '合成独立发布依据' }, storedFileId: file, path: ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf'][file - 1]!, sha256: digest, bytes: Buffer.byteLength(sourceBytes), attachment: null, sectionKey: '认定名单', listNo, page: 1, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic-355' }, basis: '合成逐行核实', ...extra })
  const evidence = (row: OfficialPublishedRow) => ({ sourceFile: row.path!, attachment: row.attachment, page: row.page, listNo: row.listNo, publishedRow: row })
  const record = (title: CurrentTitle, events: RosterImportRecord['events'], name = '现用名', code: string | null = uscc): RosterImportRecord => ({ enterprise: { name, uscc: code }, titleCode: title, events })
  const announcement = (records: RosterImportRecord[]): RosterImportPayload => ({ announcement: { sourceDocument: { source: 'jxj', title: '合成公布' }, records } })
  const ids = () => db.select().from(schema.recordEvidence).all()
  const exact = (id: number) => http('/exact?id=' + id)
  const correct = async (id: number, row: OfficialPublishedRow, key: string) => {
    const current = await exact(id)
    const request = { idempotencyKey: key, actor: { type: 'agent', id: 'synthetic-355' }, basis: '合成更正依据', operations: [{ evidenceId: id, eventId: current.eventId, recordId: current.recordId, enterpriseId: current.enterpriseId, expectedVersion: current.version, expectedRowRevision: current.official.row?.revision ?? 0, coordinate: { sourceFile: row.path, attachment: row.attachment, listNo: row.listNo, page: row.page }, publishedRow: row }] }
    const plan = await http('/correction/preflight', request)
    await http('/correction/commit', { request, planHash: plan.planHash })
  }
  return { dir, db, sqlite, commit, published, evidence, record, announcement, ids, exact, correct }
}

it('pairs old and new published names with every independent event and file in fifteen columns', async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [
    { eventType: 'award', year: 2021, batchSeq: 1, evidence: [f.evidence(f.published('2021旧名'))] },
    { eventType: 'review', year: 2021, batchSeq: 1, decidedYear: 2024, reviewOutcome: 'passed', evidence: [f.evidence(f.published('2024新名', 2))] },
  ])]), 'paired')
  const newer = await f.exact(f.ids()[1]!.id)
  await f.commit({ officialEvidenceAppends: [{ eventId: newer.eventId, recordId: newer.recordId, enterpriseId: newer.enterpriseId, expectedVersion: newer.event.revision, evidence: f.evidence(f.published('另一独立公布名', 3)) }] }, 'append')
  await f.commit({ aliases: [{ uscc, name: '独立确认曾用名', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'confirmed' }, { uscc, name: '待核别名', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'pending' }] }, 'aliases')
  const filename = join(f.dir, 'paired.xlsx')
  const result = await writeCurrentWorkbook(f.sqlite, 'specialized_sme', filename, () => {})
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(filename)
  const row = workbook.getWorksheet('有效企业')!.getRow(2)
  expect(result.counts, JSON.stringify(readCurrentCandidate(f.sqlite, newer.enterpriseId, 'specialized_sme', qualificationYear, executionTime))).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  expect(workbook.worksheets.map(s => s.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
  expect(row.cellCount).toBe(15)
  expect(row.getCell(13).value).toBe('有效企业')
  expect(row.getCell(14).value).toBe('默认年度规则：最近一次认定或复核通过 2024 年 + 3 = 2027 年；自 2027 年起到期（仅年份精度）')
  expect(row.getCell(2).value).toBe('现用名')
  const names = String(row.getCell(8).value)
  expect(names.split('\n')).toEqual([
    '2021年第1批认定，《2021公布.pdf》：公布名称："2021旧名"',
    '2021年第1批原认定批次，2024年复核通过，《2024公布.pdf》：公布名称："2024新名"',
    '2021年第1批原认定批次，2024年复核通过，《独立佐证.pdf》：公布名称："另一独立公布名"',
  ])
  expect(row.getCell(9).value).toBe('独立确认曾用名')
  expect(String(row.getCell(11).value)).not.toContain('现已更名')
  expect(row.getCell(12).value).toBe([
    '2021年第1批认定：宁波市经信局公布资料\n《2021公布.pdf》，PDF第1页，名单序号1，公布名称："2021旧名"',
    '2021年第1批原认定批次，2024年复核通过：宁波市经信局公布资料\n《2024公布.pdf》，PDF第1页，名单序号1，公布名称："2024新名"',
    '2021年第1批原认定批次，2024年复核通过：宁波市经信局公布资料\n《独立佐证.pdf》，PDF第1页，名单序号1，公布名称："另一独立公布名"',
  ].join('\n'))
  for (const item of f.ids()) expect((await f.exact(item.id)).official.row.nameRaw).toBe(['2021旧名', '2024新名', '另一独立公布名'][item.id - 1])
})

type Fixture = Awaited<ReturnType<typeof fixture>>
const scope = (f: Fixture) => f.ids().map(item => ({ evidenceId: item.id, eventId: item.recordEventId }))
async function seed(f: Fixture, names: (string | null)[], title: CurrentTitle = 'specialized_sme') {
  await f.commit(f.announcement([f.record(title, [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: names.map((name, i) => f.evidence(f.published(name, 1, i + 1))) }])]), 'seed')
}

it('distinguishes captured null empty whitespace binding unknown and mixed legacy without name fallback', async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: [
    f.evidence(f.published(null, 1, 1)), f.evidence(f.published('', 1, 2)), f.evidence(f.published(' \t旧名\n ', 1, 3)),
    f.evidence(f.published('绑定未核名', 1, 4, { sourceBindingKnown: false })),
    { sourceFile: '2021公布.pdf', attachment: null, page: 1, listNo: 99 },
  ] }])]), 'mixed')
  const ids = f.ids(), facts = readOfficialPublishedPresentation(f.db, scope(f))
  expect([...facts.values()]).toEqual([
    { evidenceId: ids[0]!.id, eventId: ids[0]!.recordEventId, revision: 1, availability: 'captured', nameRaw: null, sourceBindingKnown: true },
    { evidenceId: ids[1]!.id, eventId: ids[1]!.recordEventId, revision: 1, availability: 'captured', nameRaw: '', sourceBindingKnown: true },
    { evidenceId: ids[2]!.id, eventId: ids[2]!.recordEventId, revision: 1, availability: 'captured', nameRaw: ' \t旧名\n ', sourceBindingKnown: true },
    { evidenceId: ids[3]!.id, eventId: ids[3]!.recordEventId, revision: 1, availability: 'captured', nameRaw: '绑定未核名', sourceBindingKnown: false },
    { evidenceId: ids[4]!.id, eventId: ids[4]!.recordEventId, revision: null, availability: 'unknown_legacy', nameRaw: null, sourceBindingKnown: null },
  ])
  for (const item of ids.slice(0, 4)) expect((await f.exact(item.id)).official.row.nameRaw).toBe(facts.get(item.id)!.nameRaw)
  expect((await f.exact(ids[4]!.id)).official).toMatchObject({ availability: 'unknown_legacy', row: null })
  const row = readCurrentCandidate(f.sqlite, 1, 'specialized_sme', qualificationYear, executionTime), before = JSON.stringify(row)
  const values = currentWorkbookValues('specialized_sme', row, 1, facts)
  expect(values[7]).toContain('已捕获出处，名称原值未知')
  expect(values[7]).toContain('公布名称：""')
  expect(values[7]).toContain('公布名称：" \\t旧名\\n "')
  expect(values[7]).toContain('公布名称："绑定未核名"（出处绑定未核实）')
  expect(values[7]).toContain('未逐出处核实')
  expect(values[7]).not.toContain('公布名称："现用名"')
  expect(JSON.stringify(row)).toBe(before)
})

it('labels every all-legacy source and an unknown review conclusion year explicitly', async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [
    { eventType: 'award', year: 2021, batchSeq: 1, evidence: [{ sourceFile: '2021公布.pdf', page: 1, listNo: 1 }] },
    { eventType: 'review', year: 2021, batchSeq: 1, reviewOutcome: 'passed', evidence: [{ sourceFile: '2024公布.pdf', page: 1, listNo: 2 }] },
  ])]), 'legacy')
  const facts = readOfficialPublishedPresentation(f.db, scope(f))
  expect([...facts.values()].map(fact => fact.availability)).toEqual(['unknown_legacy', 'unknown_legacy'])
  const filename = join(f.dir, 'legacy.xlsx'); await writeCurrentWorkbook(f.sqlite, 'specialized_sme', filename, () => {})
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(filename)
  const row = workbook.getWorksheet('已到期')!.getRow(2)
  expect(row.getCell(13).value).toBe('已到期')
  expect(row.getCell(14).value).toBe('默认年度规则：最近一次认定或复核通过 2021 年 + 3 = 2024 年；自 2024 年起到期（仅年份精度）')
  expect(String(row.getCell(8).value).match(/未逐出处核实/g)).toHaveLength(2)
  expect(row.getCell(8).value).toContain('2021年第1批原认定批次，结论年份待核复核通过')
  expect(row.getCell(8).value).not.toContain('2024年复核')
  expect(row.getCell(12).value).toContain('PDF第1页，名单序号2，未逐出处核实')
})

it.each([{ id: 'plain', prefix: '' }, { id: 'historical_diagnostic', prefix: '历史诊断（不参与有效判定）：' }])('removes only inherited rename and migration-scope sentences from Excel while preserving qualifier inputs $id', async ({ prefix }) => {
  const f = await fixture(); await seed(f, ['独立出处原名'])
  const row = readCurrentCandidate(f.sqlite, 1, 'specialized_sme', qualificationYear, executionTime)
  // Formatter input representing the existing qualifier's legacy rename branch.
  // No sidecar/domain fixture is fabricated or written here.
  row.publishedNames = ['旧容器首名']
  row.notes.push(prefix + '已公布，公布名称为旧容器首名；现已更名为现用名', prefix + '迁入资格断言；公布核对范围：synthetic-private-trace', prefix + '仍需保留的业务说明')
  const before = JSON.stringify(row)
  const values = currentWorkbookValues('specialized_sme', row, 1, readOfficialPublishedPresentation(f.db, scope(f)))
  expect(values[7]).toContain('公布名称："独立出处原名"')
  expect(values[7]).not.toContain('旧容器首名')
  expect(values[8]).toBeNull()
  expect(values[10]).not.toContain('现已更名为')
  expect(values[10]).not.toContain('synthetic-private-trace')
  expect(values[10]).not.toContain('迁入资格断言')
  expect(values[10]).toContain('仍需保留的业务说明')
  expect(JSON.stringify(row)).toBe(before)
})

it('deduplicates caller scope and reads each event page once without per-evidence latest calls', async () => {
  const f = await fixture(); await seed(f, Array.from({ length: 51 }, (_, i) => '独立名称' + (i + 1)))
  const other: RosterImportRecord = f.record('specialized_sme', [{ eventType: 'award', year: 2025, batchSeq: 1, evidence: [f.evidence(f.published('另事件名称', 2))] }])
  await f.commit(f.announcement([other]), 'other')
  const selected = scope(f).slice(0, 51), page = observePublishedPages(), latest = vi.spyOn(official, 'readLatestOfficialEvidence')
  const facts = readOfficialPublishedPresentation(f.db, [...selected, ...selected])
  expect(facts.size).toBe(51)
  expect([...facts.values()].map(fact => fact.nameRaw)).toEqual(Array.from({ length: 51 }, (_, i) => '独立名称' + (i + 1)))
  expect(page.mock.calls.map(call => [call[1], call[2]])).toEqual([
    [selected[0]!.eventId, { pageSize: 50, maxBytes: 65536 }],
    [selected[0]!.eventId, { pageSize: 50, maxBytes: 65536, afterEvidenceId: selected[49]!.evidenceId }],
  ])
  expect(latest).not.toHaveBeenCalled()
  expect(facts.has(f.ids()[51]!.id)).toBe(false)
})

it('keeps captured origin facts after a public legal merge retains identity and redirects current ownership', async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType: 'award', year: 2021, batchSeq: 1, evidence: [f.evidence(f.published('2021旧名'))] }], '旧主体名', null)]), 'old')
  const original = await f.exact(f.ids()[0]!.id)
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: [f.evidence(f.published('2024新名', 2))] }])]), 'new')
  await f.commit({ merges: [{ fromEnterpriseId: original.enterpriseId, intoUscc: uscc, note: '合成独立身份核实后归并' }] }, 'merge')
  const facts = readOfficialPublishedPresentation(f.db, scope(f)), exact = await f.exact(original.evidenceId)
  expect([...facts.values()].map(fact => fact.nameRaw)).toEqual(['2021旧名', '2024新名'])
  expect(exact.official.row.capturedEnterpriseId).toBe(original.enterpriseId)
  expect(exact.official.row.currentOwner.enterpriseId).not.toBe(original.enterpriseId)
  expect(f.db.select().from(schema.enterprise).all().some(item => item.id === original.enterpriseId)).toBe(true)
  expect(f.sqlite.prepare('SELECT from_enterprise_id,into_enterprise_id FROM enterprise_merge WHERE from_enterprise_id=?').get(original.enterpriseId)).toEqual({ from_enterprise_id: original.enterpriseId, into_enterprise_id: exact.official.row.currentOwner.enterpriseId })
})

it('isolates sidecar-only changes from enumerable qualification and dataVersion at a fixed time', async () => {
  const f = await fixture(); await seed(f, ['原捕获名'])
  const target = f.ids()[0]!, exact = await f.exact(target.id)
  const before = readCurrentCandidate(f.sqlite, exact.enterpriseId, 'specialized_sme', qualificationYear, executionTime), originalJson = JSON.stringify(before)
  expect(before.group).toBe('eligible')
  expect(Object.getOwnPropertyDescriptor(before, 'workbookFacts')?.enumerable).toBe(false)
  const beforeT2 = readCurrentQualificationAssessment(f.sqlite, exact.enterpriseId, executionTime)
  const beforeEvidence = f.sqlite.prepare('select v.id,v.record_event_id as eventId,v.source_file as sourceFile,v.attachment,v.list_no as listNo,v.page from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id where r.enterprise_id=? and r.title_code=? order by v.id').all(exact.enterpriseId,'specialized_sme')
  const firstFile = join(f.dir, 'before.xlsx'), secondFile = join(f.dir, 'after.xlsx')
  const first = await writeCurrentWorkbook(f.sqlite, 'specialized_sme', firstFile, () => {})
  expect(first.generatedAt).toBe('2026-10-25T08:00:00.000Z')
  const row = f.published('更正后原名', 1, 1, { declaration: { kind: 'existing', sourceDocumentId: exact.official.row.sourceDocumentId, basis: '同一正式公布核实' } })
  await f.correct(target.id, row, 'raw-only')
  const corrected = (await f.exact(target.id)).official.row
  expect(corrected).toMatchObject({ revision: 2, nameRaw: '更正后原名', sha256: digest })
  // Controlled sidecar-only experiment: B correctly increments legacy event.revision.
  // Pin that one legacy input back to baseline, leaving the normal public capture history intact.
  // This is an isolation control, never a suggested business write or capture shortcut.
  f.sqlite.prepare('UPDATE record_event SET revision=? WHERE id=?').run(exact.event.revision, target.recordEventId)
  expect(JSON.stringify(readCurrentCandidate(f.sqlite, exact.enterpriseId, 'specialized_sme', qualificationYear, executionTime))).toBe(originalJson)
  const afterT2 = readCurrentQualificationAssessment(f.sqlite, exact.enterpriseId, executionTime)
  const expectedT2 = structuredClone(beforeT2)
  const selected = expectedT2.titles.find(item => item.titleCode === 'specialized_sme')!
  const sourceVersion = selected.sourceVersions.find(item => item.evidenceId === target.id)!
  expect(sourceVersion.capturedRevision).toBe(1)
  sourceVersion.capturedRevision = 2 // Independent public correction literal, not after-T2 output.
  expect(sourceVersion.capturedSha256).toBe(digest)
  expect(f.sqlite.prepare('select v.id,v.record_event_id as eventId,v.source_file as sourceFile,v.attachment,v.list_no as listNo,v.page from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id where r.enterprise_id=? and r.title_code=? order by v.id').all(exact.enterpriseId,'specialized_sme')).toEqual(beforeEvidence)
  const hashJSON = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const giant = expectedT2.titles.find(item => item.titleCode === 'little_giant')!
  expect(giant.sourceVersions).toEqual([])
  expect(giant.completeness.publishedNames).toEqual([])
  const evidenceInputs = [{ id: 1, eventId: 1, sourceFile: '2021公布.pdf', attachment: null, listNo: 1, page: 1 }]
  const names = [{ evidenceId: 1, availability: 'captured', nameKnown: true }]
  const sources = [{ evidenceId: 1, eventId: 1, sourceFile: '2021公布.pdf', storedFileId: 1, sha256: digest, bytes: Buffer.byteLength(sourceBytes), removedAt: null, capturedRevision: 2, capturedSha256: digest }]
  expect(beforeEvidence).toEqual(evidenceInputs)
  expect(selected.sourceVersions).toEqual(sources)
  expect(selected.completeness.publishedNames).toEqual(names)
  const emptySources = hashJSON([[], [], [], []])
  selected.versions.sources = hashJSON([hashJSON([evidenceInputs, sources, names, []]), emptySources])
  expectedT2.titles.find(item => item.titleCode === 'innovative_sme')!.versions.sources = hashJSON([hashJSON([emptySources, emptySources]), selected.versions.sources])
  const { snapshotId: _oldDigest, titles: expectedTitles, ...expectedScope } = expectedT2
  expectedT2.snapshotId = hashJSON([expectedScope,expectedTitles])
  expect(afterT2).toEqual(expectedT2) // Every unlisted full-T2 path stays byte/structurally equal.
  const second = await writeCurrentWorkbook(f.sqlite, 'specialized_sme', secondFile, () => {})
  expect(second.generatedAt).toBe(first.generatedAt)
  expect(second.counts).toEqual(first.counts); expect(second.ruleVersion).toBe(first.ruleVersion)
  const beforeBook = new ExcelJS.Workbook(); await beforeBook.xlsx.readFile(firstFile)
  const afterBook = new ExcelJS.Workbook(); await afterBook.xlsx.readFile(secondFile)
  const cells = (book: ExcelJS.Workbook) => book.worksheets.map(sheet => Array.from({length:sheet.rowCount},(_,r) => Array.from({length:sheet.columnCount},(_,c) => sheet.getRow(r+1).getCell(c+1).value)))
  const beforeCells = cells(beforeBook), afterCells = cells(afterBook)
  expect(beforeBook.getWorksheet('有效企业')!.getCell('H2').value).toContain('公布名称："原捕获名"')
  expect(beforeBook.getWorksheet('有效企业')!.getCell('L2').value).toContain('公布名称："原捕获名"')
  for (const column of [7,11]) {
    expect(afterCells[0]![1]![column]).toBe(String(beforeCells[0]![1]![column]).replace('原捕获名','更正后原名'))
    beforeCells[0]![1]![column] = afterCells[0]![1]![column]!
  }
  expect(afterCells).toEqual(beforeCells) // H2/L2 alone may change, including all explanation cells.
  const independentVersion = (book: ExcelJS.Workbook, snapshot: typeof beforeT2) => {
    const {titles,snapshotId:_fullSnapshotId,...scope}=snapshot
    const snapshotId = hashJSON([scope,titles.filter(title => title.titleCode === 'specialized_sme')])
    const values=Array.from({length:15},(_,c)=>book.getWorksheet('有效企业')!.getRow(2).getCell(c+1).value)
    // This source-complete fixture has no diagnostic notes. The new O column
    // hashes the empty joined string, which ExcelJS reads as a blank/null cell.
    expect(snapshot.titles.find(title => title.titleCode === 'specialized_sme')!.effectiveQualification!.notes).toEqual([])
    expect(values[14]).toBeNull()
    values[14]=''
    return 'sha256:'+createHash('sha256').update(JSON.stringify(['current-export-assessment-title-v3',QUALIFICATION_ASSESSMENT_VERSION,CURRENT_RULE_VERSION,2026,'specialized_sme'])+'\n')
      .update(JSON.stringify(['effective',exact.enterpriseId,scope,snapshotId,values])+'\n').digest('hex')
  }
  expect(first.dataVersion).toBe(independentVersion(beforeBook,beforeT2))
  expect(second.dataVersion).toBe(independentVersion(afterBook,expectedT2))
  expect(createHash('sha256').update(readFileSync(secondFile)).digest('hex')).not.toBe(createHash('sha256').update(readFileSync(firstFile)).digest('hex'))
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(secondFile)
  expect(workbook.getWorksheet('有效企业')!.getCell('H2').value).toContain('公布名称："更正后原名"')
  expect(workbook.getWorksheet('有效企业')!.getCell('H2').value).not.toContain('原捕获名')
})

it('keeps a public 2021 award without review expired in the 2026 reader and workbook', async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [
    { eventType: 'award', year: 2021, batchSeq: 1, evidence: [f.evidence(f.published('2021独立公布名'))] },
  ])]), '2021-pending-control')
  const evidence = f.ids()[0]!, exact = await f.exact(evidence.id)
  expect(exact.official.row.nameRaw).toBe('2021独立公布名')
  const row = readCurrentCandidate(f.sqlite, exact.enterpriseId, 'specialized_sme', qualificationYear, executionTime)
  expect(row.group).toBe('excluded')
  expect(row.firstYear).toBe(2021)
  const filename = join(f.dir, '2021-pending-control.xlsx')
  const result = await writeCurrentWorkbook(f.sqlite, 'specialized_sme', filename, () => {})
  expect(result.generatedAt).toBe('2026-10-25T08:00:00.000Z')
  expect(result.counts).toEqual({ eligible: 0, pending: 0, excluded: 1 })
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(filename)
  expect(workbook.getWorksheet('有效企业')!.rowCount).toBe(1)
  for (const name of ['已注销（吊销）','已迁出','未认定']) expect(workbook.getWorksheet(name)!.rowCount).toBe(1)
  const pending = workbook.getWorksheet('已到期')!
  expect(pending.rowCount).toBe(2)
  expect(pending.getCell('B2').value).toBe('现用名')
  expect(pending.getCell('F2').value).toBe('2021')
  expect(pending.getCell('H2').value).toBe('2021年第1批认定，《2021公布.pdf》：公布名称："2021独立公布名"')
  expect(pending.getCell('M2').value).toBe('已到期')
  expect(pending.getCell('N2').value).toBe('默认年度规则：最近一次认定或复核通过 2021 年 + 3 = 2024 年；自 2024 年起到期（仅年份精度）')
})

it('redacts only minimal display values and rejects unavailable facts instead of exporting them as legacy', async () => {
  const f = await fixture(); await seed(f, ['Bearer synthetic-private-value'])
  const facts = readOfficialPublishedPresentation(f.db, scope(f)), fact = [...facts.values()][0]!
  expect(fact.nameRaw).toBe('Bearer [REDACTED]')
  expect(Object.keys(fact).sort()).toEqual(['availability', 'eventId', 'evidenceId', 'nameRaw', 'revision', 'sourceBindingKnown'])
  const row = readCurrentCandidate(f.sqlite, 1, 'specialized_sme', qualificationYear, executionTime)
  expect(() => currentWorkbookValues('specialized_sme', row, 1, new Map())).toThrow(OfficialPublishedPresentationError)
  expect(() => currentWorkbookValues('specialized_sme', row, 1, new Map([[fact.evidenceId, { evidenceId: fact.evidenceId, eventId: fact.eventId, revision: null, availability: 'unavailable', nameRaw: null, sourceBindingKnown: null }]]))).toThrow(OfficialPublishedPresentationError)
  vi.spyOn(official, 'listEventsOfficialEvidencePages').mockImplementation(() => { throw new Error('private SQL and Bearer secret') })
  try { readOfficialPublishedPresentation(f.db, scope(f)); expect.unreachable() } catch (error) {
    expect(error).toBeInstanceOf(OfficialPublishedPresentationError)
    expect(error).toMatchObject({ code: 'read_failed' }); expect(String(error)).not.toMatch(/private SQL|Bearer secret/)
  }
  await expect(writeCurrentWorkbook(f.sqlite, 'specialized_sme', join(f.dir, 'failed.xlsx'), () => {})).rejects.toMatchObject({ code: 'read_failed' })
  expect(f.sqlite.inTransaction).toBe(false)
})

it('enforces final UTF8 projection plus formatted-text bytes at and beyond 64KiB', () => {
  const fact: OfficialPublishedFact = { evidenceId: 1, eventId: 1, revision: 1, availability: 'captured', nameRaw: '名', sourceBindingKnown: true }
  const overhead = Buffer.byteLength(JSON.stringify([fact])) + Buffer.byteLength(JSON.stringify(['']))
  expect(() => assertOfficialPublishedBudget([fact], ['a'.repeat(65536 - overhead)])).not.toThrow()
  expect(() => assertOfficialPublishedBudget([fact], ['a'.repeat(65537 - overhead)])).toThrow(OfficialPublishedPresentationError)
})

it('refuses an oversized event page without shrinking or retrying and rolls back the workbook', async () => {
  const f = await fixture(); await seed(f, Array.from({ length: 8 }, () => '名'.repeat(4000)))
  const page = vi.spyOn(official, 'listEventsOfficialEvidencePages')
  expect(() => readOfficialPublishedPresentation(f.db, scope(f))).toThrow('response_limit')
  expect(page).toHaveBeenCalledTimes(1)
  await expect(writeCurrentWorkbook(f.sqlite, 'specialized_sme', join(f.dir, 'page-limit.xlsx'), () => {})).rejects.toMatchObject({ code: 'response_limit' })
  expect(page).toHaveBeenCalledTimes(2); expect(f.sqlite.inTransaction).toBe(false)
  for (const call of page.mock.calls) {
    expect(call[1]).toEqual([{eventId:f.ids()[0]!.recordEventId}])
    expect(call[2]).toEqual({pageSize:50,maxBytes:65536})
  }
})

it('rejects corrupt historical raw fields and oversized legacy scope instead of silently truncating them', async () => {
  const f = await fixture(); await seed(f, ['完整原文'])
  // Explicit historical-corruption boundary, not the normal public capture path.
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET name_raw=?').run('x'.repeat(4000))
  expect([...readOfficialPublishedPresentation(f.db, scope(f)).values()][0]!.nameRaw).toHaveLength(4000)
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET name_raw=?').run('x'.repeat(4001))
  expect(() => readOfficialPublishedPresentation(f.db, scope(f))).toThrow('field_limit')
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET name_raw=?').run('完整原文')
  const eventId = f.ids()[0]!.recordEventId
  // Explicit extreme legacy boundary: A must reject 301 total old evidence before a page.
  const insert = f.sqlite.prepare('INSERT INTO record_evidence(record_event_id,source_file,list_no) VALUES(?,?,?)')
  for (let i = 0; i < 299; i++) insert.run(eventId, 'legacy-boundary.pdf', i + 2)
  expect(readOfficialPublishedPresentation(f.db, [{ evidenceId: 1, eventId }]).size).toBe(1)
  insert.run(eventId, 'legacy-boundary.pdf', 301)
  expect(() => readOfficialPublishedPresentation(f.db, [{ evidenceId: 1, eventId }])).toThrow('source_limit')
})

it('rejects cumulative formatted text even when the complete fact page fits its own budget', async () => {
  const f = await fixture(); await seed(f, ['甲', '乙', '丙'].map(prefix => prefix + '名'.repeat(3000)))
  const facts = readOfficialPublishedPresentation(f.db, scope(f))
  expect(facts.size).toBe(3)
  const row = readCurrentCandidate(f.sqlite, 1, 'specialized_sme', qualificationYear, executionTime)
  expect(() => currentWorkbookValues('specialized_sme', row, 1, facts)).toThrow('response_limit')
  await expect(writeCurrentWorkbook(f.sqlite, 'specialized_sme', join(f.dir, 'text-limit.xlsx'), () => {})).rejects.toMatchObject({ code: 'response_limit' })
  expect(f.sqlite.inTransaction).toBe(false)
})

it('hydrates only the matched sheet after hashing and never repeats deferred-row event reads', async () => {
  const f = await fixture()
  await f.commit(f.announcement([
    f.record('specialized_sme', [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: [f.evidence(f.published('有效公布名', 1, 1))] }], '有效主体', null),
    f.record('specialized_sme', [{ eventType: 'award', year: 2021, batchSeq: 1, evidence: [f.evidence(f.published('待核公布名', 2, 2))] }], '到期待核主体', null),
    f.record('specialized_sme', [{ eventType: 'nurture', year: 2021, batchSeq: 1, evidence: [{ sourceFile: '独立佐证.pdf', listNo: 3, page: 1 }] }], '仅培育主体', null),
  ]), 'groups')
  const owned = createCurrentQualificationAssessmentReader(f.sqlite)
  for (const [index,item] of f.ids().entries()) {
    const enterpriseId=f.db.select().from(schema.record).all().find(record => record.id === f.db.select().from(schema.recordEvent).all().find(event => event.id === item.recordEventId)!.recordId)!.enterpriseId!
    const defaultT2=readCurrentQualificationAssessment(f.sqlite,enterpriseId,executionTime)
    const workbookRead=owned.readWorkbook(enterpriseId,executionTime,'specialized_sme')
    expect(workbookRead.snapshot).toEqual(defaultT2)
    expect(workbookRead.rows.find(row=>row.assessment!.titleCode==='specialized_sme')!.assessment!.group).toBe(owned.readTitle(enterpriseId,'specialized_sme',executionTime).group)
    expect(Object.getOwnPropertyDescriptor(workbookRead.rows.find(row=>row.assessment!.titleCode==='specialized_sme')!,'workbookFacts')?.enumerable).toBe(false)
    const selected=defaultT2.titles.find(title=>title.titleCode==='specialized_sme')!
    expect(selected.group).toBe(['eligible','excluded','excluded'][index])
    expect(selected.effectiveQualification?.status).toBe(['effective','expired','unrecognized'][index])
    expect(selected.sourceVersions.map(source=>source.eventId)).toEqual([item.recordEventId])
    expect(workbookRead.workbookPublished).toEqual(index===2 ? new Map() : new Map([[item.id,{
      evidenceId:item.id,eventId:item.recordEventId,revision:1,availability:'captured',
      nameRaw:['有效公布名','待核公布名'][index],sourceBindingKnown:true,
    }]]))
    if (index===2) {
      expect(selected.evidence).toContainEqual(expect.objectContaining({eventId:item.recordEventId,eventType:'nurture'}))
      expect(selected.completeness.publishedNames).toEqual([])
    }
  }
  // Only this measured workbook run contributes to the page trace below.
  const page = observePublishedPages(), filename = join(f.dir, 'groups.xlsx')
  const result = await writeCurrentWorkbook(f.sqlite, 'specialized_sme', filename, () => {})
  expect(result.counts).toEqual({ eligible: 1, pending: 0, excluded: 2 })
  expect(page.mock.calls.map(call => call[1])).toEqual(f.ids().map(item=>item.recordEventId))
  for (const call of page.mock.calls) expect(call[2]).toEqual({pageSize:50,maxBytes:65536})
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(filename)
  expect(workbook.getWorksheet('有效企业')!.getCell('H2').value).toContain('公布名称："有效公布名"')
  expect(workbook.getWorksheet('已到期')!.getCell('H2').value).toContain('公布名称："待核公布名"')
  expect(workbook.getWorksheet('已到期')!.getCell('M2').value).toBe('已到期')
  expect(workbook.getWorksheet('未认定')!.getCell('H2').value).toBeNull()
  expect(workbook.getWorksheet('未认定')!.getCell('M2').value).toBe('未认定')
})

it('fails a later event page without returning a partial or legacy map', async () => {
  const f = await fixture(); await seed(f, Array.from({ length: 51 }, (_, i) => '分页名称' + i))
  const realRead = official.listEventsOfficialEvidencePages
  const page = vi.spyOn(official, 'listEventsOfficialEvidencePages').mockImplementationOnce(realRead).mockImplementationOnce(() => { throw new Error('second page database failed') })
  expect(() => readOfficialPublishedPresentation(f.db, scope(f))).toThrow('read_failed')
  expect(page).toHaveBeenCalledTimes(2)
})

it('rejects conflicting evidence scope and empty scope needs no event read', async () => {
  const f = await fixture(), page = vi.spyOn(official, 'listEventsOfficialEvidencePages')
  expect(readOfficialPublishedPresentation(f.db, []).size).toBe(0)
  expect(() => readOfficialPublishedPresentation(f.db, [{ eventId: 1, evidenceId: 1 }, { eventId: 2, evidenceId: 1 }])).toThrow('invalid_scope')
  expect(page).not.toHaveBeenCalled()
})

it.each(['little_giant', 'specialized_sme', 'innovative_sme'] as const)('writes the shared display projection for title %s', async title => {
  const f = await fixture(); await seed(f, ['=1+1'], title)
  const filename = join(f.dir, title + '.xlsx'), result = await writeCurrentWorkbook(f.sqlite, title, filename, () => {})
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(filename)
  expect(result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  for (const sheet of workbook.worksheets.slice(0, 5)) {
    expect(sheet.getRow(1).cellCount).toBe(15)
    expect([13,14,15].map(column => sheet.getRow(1).getCell(column).value)).toEqual(['有效状态','有效期及排除依据','资料缺口与来源备注'])
  }
  const cell = workbook.getWorksheet('有效企业')!.getCell('H2')
  expect(cell.type).toBe(ExcelJS.ValueType.String); expect(cell.value).toContain('公布名称："=1+1"')
})

// #391 bounded controls. These bypass no product reader: only their synthetic
// storage setup is direct, and all expected public facts are independent literals.
function fixture391(filename = ':memory:') {
  const sqlite = new Database(filename); sqlite.pragma('foreign_keys=ON')
  closes.push(() => { sqlite.close(); })
  const statements: string[] = []
  const db = drizzle(sqlite, { schema, logger: { logQuery(query) { statements.push(query) } } })
  createRuntimeSchema(sqlite)
  db.insert(schema.importBatch).values({ id: 1, idempotencyKey: '391', sourceKind: 'announcement', sourceIdentity: 'synthetic391', status: 'committed' }).run()
  const event = (id: number) => {
    db.insert(schema.enterprise).values({ id, name: 'Container391', nameNorm: 'Container391-' + id }).run()
    db.insert(schema.record).values({ id, enterpriseId: id, titleCode: 'specialized_sme', source: 'jxj', nameRaw: 'Container391' }).run()
    db.insert(schema.recordEvent).values({ id, recordId: id, eventType: 'award', year: 2024, batchSeq: 1 }).run()
  }
  const evidence = (id: number, eventId = 1) => db.insert(schema.recordEvidence).values({ id, recordEventId: eventId, sourceFile: 'synthetic391.pdf', page: 1, listNo: id }).run()
  const capture = (id: number, eventId = 1, nameRaw: string | null = 'Name391', revision = 1) => {
    if (revision === 1) evidence(id, eventId)
    db.insert(schema.officialEvidenceRowRevision).values({ evidenceId: id, eventId, revision, capturedRecordId: eventId, capturedEnterpriseId: eventId,
      nameRaw, path: 'synthetic391.pdf', sourceBindingKnown: false, actor: { type: 'agent', id: 'synthetic391' }, basis: 'synthetic391', commandKind: 'import', importBatchId: 1, createdAt: 'synthetic391' }).run()
  }
  const selected = () => db.select().from(schema.recordEvidence).all().map(e => ({ evidenceId: e.id, eventId: e.recordEventId }))
  return { sqlite, db, event, evidence, capture, selected, statements }
}
function literal391(evidenceId: number, eventId = 1, nameRaw: string | null = 'Name391', revision = 1): OfficialPublishedFact {
  return { evidenceId, eventId, revision, availability: 'captured', nameRaw, sourceBindingKnown: false }
}
function redactor391(db: ReturnType<typeof fixture391>['db'], token = 'cx391-only-A7mN5p9Q') {
  const real = receiptRedaction.importReceiptRedactor(db, { additionalSecrets: [token] })
  return Object.assign(vi.fn((value: unknown, mode?: receiptRedaction.ReceiptRedactionMode) => real(value, mode)), { knownRedactors: real.knownRedactors })
}
function secrets391(db: ReturnType<typeof fixture391>['db']) {
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'rt391-api-distinct', mcpToken: 'rt391-mcp-distinct' }))
  vi.stubEnv('NUXT_API_TOKEN', 'env391-api-distinct'); vi.stubEnv('NUXT_MCP_TOKEN', 'env391-mcp-distinct')
  db.insert(schema.serviceCredential).values([{ key: 'sme-roster.miitCookie', value: 'saved391-cookie-distinct', updatedAt: 'synthetic' }, { key: 'core.ocrToken', value: 'saved391-ocr-distinct', updatedAt: 'synthetic' }]).run()
  closes.push(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
}

it('factory_union_order preserves the complete context runtime env and credential set', () => {
  const f = fixture391(); secrets391(f.db)
  const credentials = vi.spyOn(credentialState, 'resolveCredential')
  const redact = receiptRedaction.importReceiptRedactor(f.db, { additionalSecrets: ['cx391-only-A7mN5p9Q', null, '', 'cx391-only-A7mN5p9Q'] })
  const actual = redact({ name: 'cx391-only-A7mN5p9Q rt391-api-distinct rt391-mcp-distinct env391-api-distinct env391-mcp-distinct saved391-cookie-distinct saved391-ocr-distinct',
    'cx391-only-A7mN5p9Q': 'ok', nested: '{"name":"cx391-only-A7mN5p9Q","token":"arbitrary"}', bearer: 'Bearer arbitrary-value' })
  expect(actual).toEqual({ name: '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]', '[REDACTED]': 'ok', nested: '{"name":"[REDACTED]","token":"[REDACTED]"}', bearer: 'Bearer [REDACTED]' })
  expect(credentials.mock.calls.map(call => call[0])).toEqual(['sme-roster.miitCookie', 'core.ocrToken'])
  expect(redact).toHaveProperty('knownRedactors')
  expect(redact.knownRedactors).toHaveLength(7)
  expect(redact.knownRedactors.map(r => r('cx391-only-A7mN5p9Q rt391-api-distinct rt391-mcp-distinct env391-api-distinct env391-mcp-distinct saved391-cookie-distinct saved391-ocr-distinct'))).toEqual([
    '[REDACTED] rt391-api-distinct rt391-mcp-distinct env391-api-distinct env391-mcp-distinct saved391-cookie-distinct saved391-ocr-distinct',
    'cx391-only-A7mN5p9Q [REDACTED] rt391-mcp-distinct env391-api-distinct env391-mcp-distinct saved391-cookie-distinct saved391-ocr-distinct',
    'cx391-only-A7mN5p9Q rt391-api-distinct [REDACTED] env391-api-distinct env391-mcp-distinct saved391-cookie-distinct saved391-ocr-distinct',
    'cx391-only-A7mN5p9Q rt391-api-distinct rt391-mcp-distinct [REDACTED] env391-mcp-distinct saved391-cookie-distinct saved391-ocr-distinct',
    'cx391-only-A7mN5p9Q rt391-api-distinct rt391-mcp-distinct env391-api-distinct [REDACTED] saved391-cookie-distinct saved391-ocr-distinct',
    'cx391-only-A7mN5p9Q rt391-api-distinct rt391-mcp-distinct env391-api-distinct env391-mcp-distinct [REDACTED] saved391-ocr-distinct',
    'cx391-only-A7mN5p9Q rt391-api-distinct rt391-mcp-distinct env391-api-distinct env391-mcp-distinct saved391-cookie-distinct [REDACTED]',
  ])
  expect(Object.isFrozen(redact.knownRedactors)).toBe(true)
})

it('factory_default_compatibility keeps omitted and empty options equivalent without request cache', () => {
  const f = fixture391(); secrets391(f.db)
  const input = { name: 'rt391-api-distinct saved391-cookie-distinct', raw: '{"password":"value","name":"env391-mcp-distinct"}' }
  const expected = { name: '[REDACTED] [REDACTED]', raw: '{"password":"[REDACTED]","name":"[REDACTED]"}' }
  expect(receiptRedaction.importReceiptRedactor(f.db)(input)).toEqual(expected)
  expect(receiptRedaction.importReceiptRedactor(f.db, {})(input)).toEqual(expected)
  expect(receiptRedaction.importReceiptRedactor(f.db, { additionalSecrets: ['first391-request'] })('first391-request second391-request')).toBe('[REDACTED] second391-request')
  expect(receiptRedaction.importReceiptRedactor(f.db, { additionalSecrets: ['second391-request'] })('first391-request second391-request')).toBe('first391-request [REDACTED]')
})

it.each([1, 2])("factory_credential_fault fails closed on read %i", read => {
  const f = fixture391(), original = credentialState.resolveCredential
  let n = 0
  vi.spyOn(credentialState, 'resolveCredential').mockImplementation((...args) => { if (++n === read) throw new Error('synthetic-private-storage'); return original(...args) })
  expect(() => receiptRedaction.importReceiptRedactor(f.db, { additionalSecrets: ['context391'] })).toThrow('synthetic-private-storage')
  expect(n).toBe(read)
})

it.each([0, 1, 40, 41, 81])("batch_distinct reads all %i events in bounded chunks", count => {
  const f = fixture391()
  for (let i = 1; i <= count; i++) { f.event(i); f.capture(i, i) }
  const pages = vi.spyOn(official, 'listEventsOfficialEvidencePages'), old = vi.spyOn(official, 'listEventOfficialEvidence')
  const factory = vi.spyOn(receiptRedaction, 'importReceiptRedactor')
  const facts = readOfficialPublishedPresentation(f.db, [...f.selected(), ...f.selected()])
  expect([...facts.values()]).toEqual(Array.from({ length: count }, (_, i) => literal391(i + 1, i + 1)))
  expect(pages.mock.calls.map(call => call[1].length)).toEqual(Array.from({ length: Math.ceil(count / 40) }, (_, i) => Math.min(40, count - 40 * i)))
  expect(old).not.toHaveBeenCalled(); expect(factory).toHaveBeenCalledTimes(count ? 1 : 0)
  for (const call of pages.mock.calls) { expect(call[0]).toBe(f.db); expect(call[2]).toEqual({ pageSize: 50, maxBytes: 65536 }) }
})

it('active_cursor_waves shares one callback and only continues active events', () => {
  const f = fixture391(); f.event(1); f.event(2)
  for (let i = 1; i <= 51; i++) f.capture(i, 1, 'cx391-only-A7mN5p9Q')
  f.capture(52, 2, null)
  const redact = redactor391(f.db), pages = vi.spyOn(official, 'listEventsOfficialEvidencePages')
  const facts = readOfficialPublishedPresentation(f.db, [...f.selected(), ...f.selected()], redact)
  expect([...facts.values()]).toEqual([...Array.from({ length: 51 }, (_, i) => literal391(i + 1, 1, '[REDACTED]')), literal391(52, 2, null)])
  expect(redact).toHaveBeenCalledTimes(52)
  expect(pages.mock.calls.map(call => call[1])).toEqual([[{ eventId: 1 }, { eventId: 2 }], [{ eventId: 1, afterEvidenceId: 50 }]])
})

it('event_scope_300_301 checks all legacy evidence beyond selected captures', () => {
  const f = fixture391(); f.event(1); f.capture(1)
  for (let i = 2; i <= 300; i++) f.evidence(i)
  expect([...readOfficialPublishedPresentation(f.db, [{ eventId: 1, evidenceId: 1 }]).values()]).toEqual([literal391(1)])
  f.evidence(301)
  expect(readPublicPublishedNames(f.db, [{ eventId: 1, evidenceId: 1 }])).toEqual({ availability: 'unavailable', error: 'source_limit', facts: [] })
})

it('latest_origin_owner retains latest raw-only values after owner links disappear', () => {
  const f = fixture391(); f.event(1); f.capture(1, 1, 'K-old'); f.capture(1, 1, 'K-new', 2); f.capture(1, 1, null, 3)
  f.sqlite.pragma('foreign_keys=OFF'); f.sqlite.prepare('DELETE FROM enterprise WHERE id=1').run()
  expect([...readOfficialPublishedPresentation(f.db, f.selected()).values()]).toEqual([literal391(1, 1, null, 3)])
  const raw = f.sqlite.prepare('SELECT captured_record_id,captured_enterprise_id FROM official_evidence_row_revision WHERE revision=3').get()
  expect(raw).toEqual({ captured_record_id: 1, captured_enterprise_id: 1 })
})

it.each(['path', 'name_raw', 'actor'] as const)("unselected_full_field_gate checks %s at UTF16 boundaries", field => {
  const f = fixture391(); f.event(1); f.capture(1); f.capture(2)
  const put = (value: string) => f.sqlite.prepare('UPDATE official_evidence_row_revision SET ' + field + '=? WHERE evidence_id=2').run(field === 'actor' ? JSON.stringify({ type: 'agent', id: value }) : value)
  put('🙂'.repeat(2000))
  expect([...readOfficialPublishedPresentation(f.db, [{ eventId: 1, evidenceId: 1 }]).values()]).toEqual([literal391(1)])
  put('🙂'.repeat(2000) + '\u0000')
  expect(() => readOfficialPublishedPresentation(f.db, [{ eventId: 1, evidenceId: 1 }])).toThrow('field_limit')
})

it('earlier_later_error_order prefers an earlier second-page field error', () => {
  const f = fixture391(); f.event(1); f.event(2)
  for (let i = 1; i <= 51; i++) f.capture(i)
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET path=? WHERE evidence_id=51').run('x'.repeat(4001))
  for (let i = 52; i <= 352; i++) f.evidence(i, 2)
  const pages = vi.spyOn(official, 'listEventsOfficialEvidencePages')
  expect(() => readOfficialPublishedPresentation(f.db, [{ evidenceId: 1, eventId: 1 }, { evidenceId: 52, eventId: 2 }])).toThrow('field_limit')
  expect(pages.mock.calls.map(call => call[1])).toEqual([[{ eventId: 1 }, { eventId: 2 }], [{ eventId: 1, afterEvidenceId: 50 }]])
})

it('prefix_budget_error_order keeps earlier fact overflow ahead of a later page error', () => {
  const f = fixture391(); f.event(1)
  for (let i = 1; i <= 51; i++) f.capture(i, 1, i <= 50 ? 'Q7 '.repeat(120) : 'last')
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET path=? WHERE evidence_id=51').run('x'.repeat(4001))
  const redact = redactor391(f.db, 'Q7')
  expect(() => readOfficialPublishedPresentation(f.db, f.selected(), redact)).toThrow('response_limit')
})

it('late_batch_atomicity never publishes forty successful facts when event forty-one fails', () => {
  const f = fixture391()
  for (let i = 1; i <= 41; i++) { f.event(i); f.capture(i, i) }
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET path=? WHERE evidence_id=41').run('x'.repeat(4001))
  const pages = vi.spyOn(official, 'listEventsOfficialEvidencePages')
  expect(readPublicPublishedNames(f.db, f.selected())).toEqual({ availability: 'unavailable', error: 'field_limit', facts: [] })
  expect(pages).toHaveBeenCalledTimes(2)
})

it('callback_failure_atomicity returns only a safe failure without partial facts', () => {
  const f = fixture391(); f.event(1); f.capture(1); f.capture(2)
  const real = receiptRedaction.importReceiptRedactor(f.db)
  const callback = Object.assign(vi.fn((value: unknown, mode?: receiptRedaction.ReceiptRedactionMode) => { if ((value as { evidenceId: number }).evidenceId === 2) throw new Error('private SQL context391'); return real(value, mode) }), { knownRedactors: real.knownRedactors })
  expect(readPublicPublishedNames(f.db, f.selected(), f.selected(), 1, 1, callback)).toEqual({ availability: 'unavailable', error: 'read_failed', facts: [] })
  expect(callback).toHaveBeenCalledTimes(2)
})

it('caller_snapshot retains one snapshot across cursor waves and an independent commit', () => {
  const dir = mkdtempSync('/tmp/391-snapshot-'), f = fixture391(join(dir, 'own.sqlite'))
  f.sqlite.pragma('journal_mode=WAL'); f.event(1)
  for (let i = 1; i <= 51; i++) f.capture(i, 1, 'before')
  const writer = new Database(join(dir, 'own.sqlite')); closes.push(() => { writer.close(); })
  const real = official.listEventsOfficialEvidencePages; let committed = false
  vi.spyOn(official, 'listEventsOfficialEvidencePages').mockImplementation((...args) => {
    const result = real(...args)
    if (!committed) { committed = true; writer.prepare("UPDATE official_evidence_row_revision SET name_raw='after' WHERE evidence_id=51").run() }
    return result
  })
  const first = f.db.transaction(() => readOfficialPublishedPresentation(f.db, f.selected()))
  expect(first.get(51)).toEqual(literal391(51, 1, 'before'))
  expect(readOfficialPublishedPresentation(f.db, f.selected()).get(51)).toEqual(literal391(51, 1, 'after'))
  expect(f.sqlite.inTransaction).toBe(false)
})

// Independent final JSON contract, not a call to the production budget/formatter.
function finalBytes391(names: string[]) {
  const facts = names.map((name, i) => literal391(i + 1, 1, name))
  const texts = names.map(name => '公布名称：' + JSON.stringify(name) + '（出处绑定未核实）')
  return Buffer.byteLength(JSON.stringify(facts)) + 2 * Buffer.byteLength(JSON.stringify(texts))
    + Buffer.byteLength('{"publishedPresentation":{"availability":"available","error":null,"facts":[]}}')
    + names.length * Buffer.byteLength('{"publishedName":null}')
}
it.each([65535, 65536, 65537])("final_current_bytes gates %i after context expansion with one DTO and two texts", target => {
  const f = fixture391(); f.event(1)
  let names: string[] = [], raw: string[] = []
  for (let quotes = 0; quotes < 3; quotes++) {
    raw = ['Q7 '.repeat(600) + '"'.repeat(quotes), 'Q7 '.repeat(600), 'Q7 '.repeat(600)]
    names = ['[REDACTED] '.repeat(600) + '"'.repeat(quotes), '[REDACTED] '.repeat(600), '[REDACTED] '.repeat(600)]
    const delta = target - finalBytes391(names)
    if (delta >= 0 && delta % 3 === 0) { raw[0] += 'x'.repeat(delta / 3); names[0] += 'x'.repeat(delta / 3); break }
  }
  expect(finalBytes391(names)).toBe(target)
  expect(raw.every(name => name.length <= 4000)).toBe(true)
  raw.forEach((name, i) => f.capture(i + 1, 1, name))
  const redact = redactor391(f.db, 'Q7'), result = readPublicPublishedNames(f.db, f.selected(), f.selected(), 1, 2, redact)
  expect(result).toEqual(target <= 65536 ? { availability: 'available', error: null, facts: names.map((name, i) => literal391(i + 1, 1, name)) } : { availability: 'unavailable', error: 'response_limit', facts: [] })
  expect(redact).toHaveBeenCalledTimes(3)
})

it('dto_text_bytes uses exact final escaped text boundaries including sixteen KiB', () => {
  const fact = literal391(1, 1, '"\u0000🙂')
  const overhead = Buffer.byteLength(JSON.stringify([fact])) + 4
  expect(() => assertOfficialPublishedBudget([fact], ['x'.repeat(16384 - overhead)])).not.toThrow()
  expect(() => assertOfficialPublishedBudget([fact], ['x'.repeat(65536 - overhead)])).not.toThrow()
  expect(() => assertOfficialPublishedBudget([fact], ['x'.repeat(65537 - overhead)])).toThrow('response_limit')
})

it('default_consumers preserve full secrets and qualifier inputs in detail current and workbook formatting', () => {
  const f = fixture391(); secrets391(f.db); f.event(1)
  f.capture(1, 1, 'rt391-api-distinct env391-api-distinct saved391-cookie-distinct saved391-ocr-distinct')
  const before = JSON.stringify(readCurrentCandidate(f.sqlite, 1, 'specialized_sme', qualificationYear, executionTime))
  const expected = literal391(1, 1, '[REDACTED] [REDACTED] [REDACTED] [REDACTED]')
  expect(getRosterEnterpriseDetail(f.db, 1)?.publishedPresentation).toEqual({ availability: 'available', error: null, facts: [expected] })
  const current = listCurrentQualified(f.sqlite, { titleCode: 'specialized_sme' })
  expect(current.total).toBe(1); expect(current.rows[0]?.publishedPresentation).toEqual({ availability: 'available', error: null, facts: [expected] })
  const candidate = readCurrentCandidate(f.sqlite, 1, 'specialized_sme', qualificationYear, executionTime)
  const values = currentWorkbookValues('specialized_sme', candidate, 1, readOfficialPublishedPresentation(f.db, f.selected()))
  expect(values[7]).toBe('2024年第1批认定，《synthetic391.pdf》：公布名称："[REDACTED] [REDACTED] [REDACTED] [REDACTED]"（出处绑定未核实）')
  expect(JSON.stringify(readCurrentCandidate(f.sqlite, 1, 'specialized_sme', qualificationYear, executionTime))).toBe(before)
})

it.each(['evidenceId', 'eventId', 'nameRaw', 'revision', 'availability', 'sourceBindingKnown', 'captured'])("typed_fact_keys keeps %s out of verified DTO structure", token => {
  const f = fixture391(); f.event(9)
  f.capture(17, 9, token); f.capture(17, 9, token, 2); f.capture(17, 9, token, 3)
  f.db.insert(schema.sourceDocument).values({ id: 391, source: 'jxj', title: 'synthetic391', path: 'synthetic391.pdf' }).run()
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET source_document_id=391, sha256=?, bytes=700, section_key=\'synthetic391\', list_no=17, source_binding_known=1 WHERE evidence_id=17 AND revision=3').run('a'.repeat(64))
  const callback = redactor391(f.db, token)
  const facts = readOfficialPublishedPresentation(f.db, [{ evidenceId: 17, eventId: 9 }], callback)
  expect([...facts.keys()]).toEqual([17])
  expect(facts.size).toBe(1)
  expect([...facts.values()]).toEqual([{ evidenceId: 17, eventId: 9, revision: 3, availability: 'captured', nameRaw: '[REDACTED]', sourceBindingKnown: true }])
  expect(callback).toHaveBeenCalledTimes(1)
  expect(callback).toHaveBeenCalledWith({ evidenceId: 17, eventId: 9, revision: 3, availability: 'captured', nameRaw: token, sourceBindingKnown: true }, 'official_published_name')
})

it.each(['evidenceId', 'captured'])("typed_mode_explicit keeps %s raw shape and JSON generic", token => {
  const f = fixture391(), redact = receiptRedaction.importReceiptRedactor(f.db, { additionalSecrets: [token] })
  const input = { evidenceId: 17, eventId: 9, revision: 3, availability: 'captured', nameRaw: token, sourceBindingKnown: true }
  expect(redact(input)).toEqual(token === 'evidenceId'
    ? { '[REDACTED]': 17, eventId: 9, revision: 3, availability: 'captured', nameRaw: '[REDACTED]', sourceBindingKnown: true }
    : { evidenceId: 17, eventId: 9, revision: 3, availability: '[REDACTED]', nameRaw: '[REDACTED]', sourceBindingKnown: true })
  expect(redact(JSON.stringify(input))).toBe(token === 'evidenceId'
    ? '{"[REDACTED]":17,"eventId":9,"revision":3,"availability":"captured","nameRaw":"[REDACTED]","sourceBindingKnown":true}'
    : '{"evidenceId":17,"eventId":9,"revision":3,"availability":"[REDACTED]","nameRaw":"[REDACTED]","sourceBindingKnown":true}')
  expect(redact(input, 'official_published_name')).toBe('[REDACTED]')
})

it.each([
  { label: 'null', raw: null, expected: null },
  { label: 'empty', raw: '', expected: '' },
  { label: 'json', raw: '{"name":"cx391-only-A7mN5p9Q","token":"private"}', expected: '{"name":"[REDACTED]","token":"[REDACTED]"}' },
  { label: 'bearer', raw: 'Bearer arbitrary-value', expected: 'Bearer [REDACTED]' },
])("typed_name_literals keeps $label display semantics", ({ raw, expected }) => {
  const f = fixture391(); f.event(9); f.capture(17, 9, raw)
  const callback = redactor391(f.db)
  expect([...readOfficialPublishedPresentation(f.db, [{ evidenceId: 17, eventId: 9 }], callback).values()]).toEqual([
    { evidenceId: 17, eventId: 9, revision: 1, availability: 'captured', nameRaw: expected, sourceBindingKnown: false },
  ])
  expect(callback).toHaveBeenCalledTimes(1)
  expect(callback).toHaveBeenCalledWith({ evidenceId: 17, eventId: 9, revision: 1, availability: 'captured', nameRaw: raw, sourceBindingKnown: false }, 'official_published_name')
})

it.each([true, false])("typed_name_union shares one closure with context %s", includeContext => {
  const f = fixture391(); secrets391(f.db)
  const credentials = vi.spyOn(credentialState, 'resolveCredential')
  const redact = includeContext
    ? receiptRedaction.importReceiptRedactor(f.db, { additionalSecrets: ['cx391-only-A7mN5p9Q', null, '', 'cx391-only-A7mN5p9Q'] })
    : receiptRedaction.importReceiptRedactor(f.db)
  const known = redact.knownRedactors
  const nameRaw = includeContext
    ? 'cx391-only-A7mN5p9Q rt391-api-distinct rt391-mcp-distinct env391-api-distinct env391-mcp-distinct saved391-cookie-distinct saved391-ocr-distinct'
    : 'rt391-api-distinct rt391-mcp-distinct env391-api-distinct env391-mcp-distinct saved391-cookie-distinct saved391-ocr-distinct'
  const expected = includeContext ? '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]' : '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]'
  const input = { evidenceId: 17, eventId: 9, revision: 3, availability: 'captured', nameRaw, sourceBindingKnown: true }
  const typedFirst = redact(input, 'official_published_name'), genericFirst = redact({ name: nameRaw })
  const typedSecond = redact(input, 'official_published_name'), genericSecond = redact(nameRaw)
  expect(credentials.mock.calls.map(call => call[0])).toEqual(['sme-roster.miitCookie', 'core.ocrToken'])
  expect(redact.knownRedactors).toBe(known)
  expect(known).toHaveLength(includeContext ? 7 : 6)
  expect(genericFirst).toEqual({ name: expected }); expect(genericSecond).toBe(expected)
  expect(typedFirst).toBe(expected); expect(typedSecond).toBe(expected)
})

it.each(['undefined', 'object', 'number'] as const)("typed_name_result rejects %s atomically", kind => {
  const f = fixture391(); f.event(1); f.capture(1); f.capture(2)
  const real = receiptRedaction.importReceiptRedactor(f.db)
  const callback = Object.assign(vi.fn((value: unknown, mode?: receiptRedaction.ReceiptRedactionMode) => {
    if ((value as { evidenceId: number }).evidenceId === 2) return kind === 'undefined' ? undefined : kind === 'object' ? {} : 17
    return real(value, mode)
  }), { knownRedactors: real.knownRedactors })
  expect(readPublicPublishedNames(f.db, f.selected(), f.selected(), 1, 1, callback)).toEqual({ availability: 'unavailable', error: 'read_failed', facts: [] })
  expect(callback).toHaveBeenCalledTimes(2)
})
