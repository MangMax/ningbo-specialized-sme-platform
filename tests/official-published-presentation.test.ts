import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import ExcelJS from 'exceljs'
import { afterEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { TITLE_SEED } from '../db/titles'
import type { OfficialPublishedRow, RosterImportPayload, RosterImportRecord } from '../lib/roster-import-client'
import { preflightRosterImport, commitRosterImport } from '../server/utils/roster-import'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import { handleEvidenceCorrectionRequest } from '../server/utils/roster-evidence-correction-api'
import { readCurrentCandidate, type CurrentTitle } from '../lib/roster/current-qualification'
import { writeCurrentWorkbook } from '../lib/roster/current-workbook'
import { startHttpFixture } from './helpers/http-fixture'
import { minimalPdf } from './helpers/minimal-pdf'
import * as official from '../server/utils/official-evidence'
import { assertOfficialPublishedBudget, readOfficialPublishedPresentation, OfficialPublishedPresentationError, type OfficialPublishedFact } from '../lib/roster/official-published-presentation'
import { currentWorkbookValues } from '../lib/roster/current-workbook-presentation'

const closes: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of closes.splice(0).reverse()) await close() })
const sourceBytes = minimalPdf({ pages: 1 })
const digest = createHash('sha256').update(sourceBytes).digest('hex')
const uscc = '91330211255994457P'
async function fixture() {
  const dir = mkdtempSync('/tmp/issue355-synthetic-'), filesDir = join(dir, 'files'); mkdirSync(filesDir)
  const sqlite = new Database(join(dir, 'synthetic.sqlite')); sqlite.pragma('foreign_keys=ON')
  closes.push(() => { expect(sqlite.pragma('foreign_key_check')).toEqual([]); sqlite.close() })
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: resolve('db/migrations') })
  // Infrastructure catalog only. Normal domain facts below go through B public commands.
  for (const title of TITLE_SEED) db.insert(schema.title).values(title).run()
  for (const [index, path] of ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf'].entries()) {
    writeFileSync(join(filesDir, path), sourceBytes)
    db.insert(schema.storedFile).values({ id: index + 1, relPath: path, filename: path, ext: 'pdf', source: 'jxj', kind: 'announcement', bytes: Buffer.byteLength(sourceBytes), sha256: digest, createdAt: 'synthetic' }).run()
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
    return result
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

it('pairs old and new published names with every independent event and file in twelve columns', async () => {
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
  expect(result.counts, JSON.stringify(readCurrentCandidate(f.sqlite, newer.enterpriseId, 'specialized_sme'))).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  expect(workbook.worksheets.map(s => s.name)).toEqual(['有效企业', '待确认', '排除明细', '口径说明'])
  expect(row.cellCount).toBe(12)
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
  const row = readCurrentCandidate(f.sqlite, 1, 'specialized_sme'), before = JSON.stringify(row)
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
  const row = workbook.getWorksheet('待确认')!.getRow(2)
  expect(String(row.getCell(8).value).match(/未逐出处核实/g)).toHaveLength(2)
  expect(row.getCell(8).value).toContain('2021年第1批原认定批次，结论年份待核复核通过')
  expect(row.getCell(8).value).not.toContain('2024年复核')
  expect(row.getCell(12).value).toContain('PDF第1页，名单序号2，未逐出处核实')
})

it('removes only the inherited first-name rename sentence from Excel while preserving qualifier inputs', async () => {
  const f = await fixture(); await seed(f, ['独立出处原名'])
  const row = readCurrentCandidate(f.sqlite, 1, 'specialized_sme')
  // Formatter input representing the existing qualifier's legacy rename branch.
  // No sidecar/domain fixture is fabricated or written here.
  row.publishedNames = ['旧容器首名']
  row.notes.push('已公布，公布名称为旧容器首名；现已更名为现用名', '仍需保留的业务说明')
  const before = JSON.stringify(row)
  const values = currentWorkbookValues('specialized_sme', row, 1, readOfficialPublishedPresentation(f.db, scope(f)))
  expect(values[7]).toContain('公布名称："独立出处原名"')
  expect(values[7]).not.toContain('旧容器首名')
  expect(values[8]).toBeNull()
  expect(values[10]).not.toContain('现已更名为')
  expect(values[10]).toContain('仍需保留的业务说明')
  expect(JSON.stringify(row)).toBe(before)
})

it('deduplicates caller scope and reads each event page once without per-evidence latest calls', async () => {
  const f = await fixture(); await seed(f, Array.from({ length: 51 }, (_, i) => '独立名称' + (i + 1)))
  const other: RosterImportRecord = f.record('specialized_sme', [{ eventType: 'award', year: 2025, batchSeq: 1, evidence: [f.evidence(f.published('另事件名称', 2))] }])
  await f.commit(f.announcement([other]), 'other')
  const selected = scope(f).slice(0, 51), page = vi.spyOn(official, 'listEventOfficialEvidence'), latest = vi.spyOn(official, 'readLatestOfficialEvidence')
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

it('keeps captured origin facts after a public legal merge removes old live owners', async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType: 'award', year: 2021, batchSeq: 1, evidence: [f.evidence(f.published('2021旧名'))] }], '旧主体名', null)]), 'old')
  const original = await f.exact(f.ids()[0]!.id)
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: [f.evidence(f.published('2024新名', 2))] }])]), 'new')
  await f.commit({ merges: [{ fromEnterpriseId: original.enterpriseId, intoUscc: uscc, note: '合成独立身份核实后归并' }] }, 'merge')
  const facts = readOfficialPublishedPresentation(f.db, scope(f)), exact = await f.exact(original.evidenceId)
  expect([...facts.values()].map(fact => fact.nameRaw)).toEqual(['2021旧名', '2024新名'])
  expect(exact.official.row.capturedEnterpriseId).toBe(original.enterpriseId)
  expect(exact.official.row.currentOwner.enterpriseId).not.toBe(original.enterpriseId)
  expect(f.db.select().from(schema.enterprise).all().some(item => item.id === original.enterpriseId)).toBe(false)
})

it('isolates sidecar-only changes from enumerable qualification and dataVersion at a fixed time', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-25T08:00:00Z'))
  const f = await fixture(); await seed(f, ['原捕获名'])
  const target = f.ids()[0]!, exact = await f.exact(target.id)
  const before = readCurrentCandidate(f.sqlite, exact.enterpriseId, 'specialized_sme'), originalJson = JSON.stringify(before)
  expect(Object.getOwnPropertyDescriptor(before, 'workbookFacts')?.enumerable).toBe(false)
  const firstFile = join(f.dir, 'before.xlsx'), secondFile = join(f.dir, 'after.xlsx')
  const first = await writeCurrentWorkbook(f.sqlite, 'specialized_sme', firstFile, () => {})
  const row = f.published('更正后原名', 1, 1, { declaration: { kind: 'existing', sourceDocumentId: exact.official.row.sourceDocumentId, basis: '同一正式公布核实' } })
  await f.correct(target.id, row, 'raw-only')
  expect((await f.exact(target.id)).official.row).toMatchObject({ revision: 2, nameRaw: '更正后原名' })
  // Controlled sidecar-only experiment: B correctly increments legacy event.revision.
  // Pin that one legacy input back to baseline, leaving the normal public capture history intact.
  // This is an isolation control, never a suggested business write or capture shortcut.
  f.sqlite.prepare('UPDATE record_event SET revision=? WHERE id=?').run(exact.event.revision, target.recordEventId)
  expect(JSON.stringify(readCurrentCandidate(f.sqlite, exact.enterpriseId, 'specialized_sme'))).toBe(originalJson)
  const second = await writeCurrentWorkbook(f.sqlite, 'specialized_sme', secondFile, () => {})
  expect(second.counts).toEqual(first.counts); expect(second.dataVersion).toBe(first.dataVersion); expect(second.ruleVersion).toBe(first.ruleVersion)
  expect(createHash('sha256').update(readFileSync(secondFile)).digest('hex')).not.toBe(createHash('sha256').update(readFileSync(firstFile)).digest('hex'))
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(secondFile)
  expect(workbook.getWorksheet('有效企业')!.getCell('H2').value).toContain('公布名称："更正后原名"')
  expect(workbook.getWorksheet('有效企业')!.getCell('H2').value).not.toContain('原捕获名')
})

it('redacts only minimal display values and rejects unavailable facts instead of exporting them as legacy', async () => {
  const f = await fixture(); await seed(f, ['Bearer synthetic-private-value'])
  const facts = readOfficialPublishedPresentation(f.db, scope(f)), fact = [...facts.values()][0]!
  expect(fact.nameRaw).toBe('Bearer [REDACTED]')
  expect(Object.keys(fact).sort()).toEqual(['availability', 'eventId', 'evidenceId', 'nameRaw', 'revision', 'sourceBindingKnown'])
  const row = readCurrentCandidate(f.sqlite, 1, 'specialized_sme')
  expect(() => currentWorkbookValues('specialized_sme', row, 1, new Map())).toThrow(OfficialPublishedPresentationError)
  expect(() => currentWorkbookValues('specialized_sme', row, 1, new Map([[fact.evidenceId, { evidenceId: fact.evidenceId, eventId: fact.eventId, revision: null, availability: 'unavailable', nameRaw: null, sourceBindingKnown: null }]]))).toThrow(OfficialPublishedPresentationError)
  vi.spyOn(official, 'listEventOfficialEvidence').mockImplementation(() => { throw new Error('private SQL and Bearer secret') })
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
  const page = vi.spyOn(official, 'listEventOfficialEvidence')
  expect(() => readOfficialPublishedPresentation(f.db, scope(f))).toThrow('response_limit')
  expect(page).toHaveBeenCalledTimes(1)
  await expect(writeCurrentWorkbook(f.sqlite, 'specialized_sme', join(f.dir, 'page-limit.xlsx'), () => {})).rejects.toMatchObject({ code: 'response_limit' })
  expect(page).toHaveBeenCalledTimes(2); expect(f.sqlite.inTransaction).toBe(false)
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
  const row = readCurrentCandidate(f.sqlite, 1, 'specialized_sme')
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
  const page = vi.spyOn(official, 'listEventOfficialEvidence'), filename = join(f.dir, 'groups.xlsx')
  const result = await writeCurrentWorkbook(f.sqlite, 'specialized_sme', filename, () => {})
  expect(result.counts).toEqual({ eligible: 1, pending: 1, excluded: 1 })
  expect(page.mock.calls.map(call => call[1])).toEqual([f.ids()[0]!.recordEventId, f.ids()[1]!.recordEventId])
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(filename)
  expect(workbook.getWorksheet('有效企业')!.getCell('H2').value).toContain('公布名称："有效公布名"')
  expect(workbook.getWorksheet('待确认')!.getCell('H2').value).toContain('公布名称："待核公布名"')
  expect(workbook.getWorksheet('排除明细')!.getCell('H2').value).toBeNull()
})

it('fails a later event page without returning a partial or legacy map', async () => {
  const f = await fixture(); await seed(f, Array.from({ length: 51 }, (_, i) => '分页名称' + i))
  const realRead = official.listEventOfficialEvidence
  const page = vi.spyOn(official, 'listEventOfficialEvidence').mockImplementationOnce(realRead).mockImplementationOnce(() => { throw new Error('second page database failed') })
  expect(() => readOfficialPublishedPresentation(f.db, scope(f))).toThrow('read_failed')
  expect(page).toHaveBeenCalledTimes(2)
})

it('rejects conflicting evidence scope and empty scope needs no event read', async () => {
  const f = await fixture(), page = vi.spyOn(official, 'listEventOfficialEvidence')
  expect(readOfficialPublishedPresentation(f.db, []).size).toBe(0)
  expect(() => readOfficialPublishedPresentation(f.db, [{ eventId: 1, evidenceId: 1 }, { eventId: 2, evidenceId: 1 }])).toThrow('invalid_scope')
  expect(page).not.toHaveBeenCalled()
})

it.each(['little_giant', 'specialized_sme', 'innovative_sme'] as const)('writes the shared display projection for title %s', async title => {
  const f = await fixture(); await seed(f, ['=1+1'], title)
  const filename = join(f.dir, title + '.xlsx'), result = await writeCurrentWorkbook(f.sqlite, title, filename, () => {})
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(filename)
  expect(result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  for (const sheet of workbook.worksheets.slice(0, 3)) expect(sheet.getRow(1).cellCount).toBe(12)
  const cell = workbook.getWorksheet('有效企业')!.getCell('H2')
  expect(cell.type).toBe(ExcelJS.ValueType.String); expect(cell.value).toContain('公布名称："=1+1"')
})
