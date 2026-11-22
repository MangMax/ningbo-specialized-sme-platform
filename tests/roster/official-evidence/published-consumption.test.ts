import { reviewPostgresFixtureRows } from '../imports/fixtures/reviewed-announcement-postgres'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { CURRENT_RULE_VERSION, QUALIFICATION_ASSESSMENT_VERSION, type CurrentQualificationSnapshot, type CurrentTitle } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { readPostgresCurrentDetailBatch, readPostgresCurrentFilterBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { recordEvidence } from '../../../db/postgresql/ledger-tables'
import type { OfficialPublishedRow, RosterImportPayload, RosterImportRequest, RosterImportRecord } from '../../../layers/sme-roster/lib/roster-import-client'
import { handlePostgresRosterImportRequest } from '../../../layers/sme-roster/server/utils/roster-import-http'
import { handlePostgresOfficialEvidenceRead } from '../../../layers/sme-roster/server/utils/official-evidence-read-postgres'
import { handlePostgresEvidenceCorrectionWrite } from '../../../layers/sme-roster/server/utils/roster-evidence-correction-write-postgres'
import { supplementPostgresAnnouncement } from '../../../layers/sme-roster/server/utils/announcement-supplement-postgres'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import { listPostgresCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query-postgres'
import type { CurrentQualifiedResult } from '../../../layers/sme-roster/lib/roster/current-qualified-query'
import { handlePostgresCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-runtime'
import { usePostgresRosterDb } from '../../../layers/sme-roster/server/utils/postgres-roster-db'
import { receiptRedactor } from '../../../layers/sme-roster/server/utils/import-receipt-redaction'
import { startHttpFixture } from '../../support/http'
import { minimalPdf } from '../../support/minimal-pdf'
import * as official from '../../../layers/sme-roster/server/utils/official-evidence-postgres'

// Only process admission is replaced for the runtime project.
vi.mock('../../../layers/sme-roster/server/utils/enterprise-read', () => ({ enterpriseReads: {
  currentQualifiedJson: async (filter: Parameters<typeof listPostgresCurrentQualified>[1]) =>
    ({ body: Buffer.from(JSON.stringify(await listPostgresCurrentQualified(usePostgresRosterDb(), filter))) }),
} }))
// Loading the package's Nitro registration cache requires virtual storage.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))

const createDatabase = useIsolatedPostgresCases()
const closes: Array<() => void | Promise<void>> = []
const readSnapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const
const executionTime = Date.parse('2026-10-25T08:00:00Z')
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(executionTime) })
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); for (const close of closes.splice(0).reverse()) await close() })
const sourceBytes = minimalPdf({ pages: 1 })
const digest = createHash('sha256').update(sourceBytes).digest('hex')
const uscc = '91330211255994457P'
async function fixture() {
  const dir = mkdtempSync('/tmp/issue356-synthetic-'), filesDir = join(dir, 'files'); mkdirSync(filesDir)
  const db = createDatabase()
  const execute = (sql: string, ...args: unknown[]) => db.$client.query(sql, args)
  const ownerIds = async () => (await db.select({ id: enterprise.id }).from(enterprise).orderBy(enterprise.id)).map(owner => owner.id)
  const ownerId = async () => (await ownerIds())[0]!
  const seedRetainedName = (name: string) => db.transaction(async tx => {
    await tx.execute(sql`ALTER TABLE official_evidence_row_revision DISABLE TRIGGER official_evidence_revision_append_only`)
    await tx.execute(sql`UPDATE official_evidence_row_revision SET name_raw=${name} WHERE evidence_id=1`)
    await tx.execute(sql`ALTER TABLE official_evidence_row_revision ENABLE TRIGGER official_evidence_revision_append_only`)
  })
  const apiToken = 'synthetic-356-api'
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken, mcpToken: 'synthetic-mcp-356', filesDir }))
  const paths = ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf']
  // Seed the file catalog, then submit the roster domain facts through commands.
  for (const [index, path] of paths.entries()) {
    writeFileSync(join(filesDir, path), sourceBytes)
    await execute("INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES($1,$2,$2,'pdf',$3,$4,'synthetic')", index + 1, path, sourceBytes.length, digest)
    await execute("INSERT INTO roster_file_classification(file_id,source,kind) VALUES($1,'jxj','announcement')", index + 1)
  }
  const server = await startHttpFixture({ routes: {
    ...Object.fromEntries((['preflight', 'commit'] as const).map(action => ['/import/' + action, (input: Parameters<typeof handlePostgresRosterImportRequest>[1]) => handlePostgresRosterImportRequest(action, input, { apiToken, filesDir })])),
    ...Object.fromEntries((['preflight', 'commit'] as const).map(action => ['/correction/' + action, (input: Parameters<typeof handlePostgresRosterImportRequest>[1]) => handlePostgresEvidenceCorrectionWrite({ ...input, action }, { apiToken, filesDir })])),
    '/detail': async input => ({ status: 200, body: await readPostgresRosterEnterpriseDetail(db, Number(input.query.id)) }),
    '/current': async input => ({ status: 200, body: await listPostgresCurrentQualified(db, { titleCode: 'specialized_sme', pageSize: Number(input.query.pageSize ?? 25), page: Number(input.query.page ?? 1) }) }),
    '/source': input => handlePostgresCorrespondenceRequest({ ...input, action: 'source', kind: 'event', id: input.query.id }, apiToken),
    '/exact': input => handlePostgresOfficialEvidenceRead({ ...input, kind: 'evidence', action: 'get', id: input.query.id, query: { official: 'latest' } }, { db, apiToken }),
  } }); closes.push(server.close)
  const trace: unknown[] = []; closes.push(() => writeFileSync(join(dir, 'public-commands.json'), JSON.stringify(trace, null, 2)))
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(server.baseUrl + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer synthetic-356-api', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json(); trace.push({ path, body, status: response.status, result })
    expect(response.status, JSON.stringify(result)).toBe(200)
    return result
  }
  const commit = async (payload: RosterImportPayload, key: string) => {
    const request: RosterImportRequest = { idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: 'synthetic-356', payload }
    const plan = await http('/import/preflight', request); expect(plan.preflight.conflicts).toEqual([])
    const result = await http('/import/commit', { ...request, payload: { ...payload, ...(plan.preflight.officialEvidencePlanHash ? { officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } : {}) } })
    if (result.status === 'staged') {
      const review = await reviewPostgresFixtureRows(db, result.sourceDigest, request)
      const preview = result.officialEvidencePreflightRequired
        ? await supplementPostgresAnnouncement(db, result.intakeId, { ...review, preflight: true }, filesDir)
        : undefined
      const completed = await supplementPostgresAnnouncement(db, result.intakeId, {
        ...review, officialEvidencePlanHash: preview && 'officialEvidencePlanHash' in preview ? preview.officialEvidencePlanHash : undefined,
      }, filesDir)
      expect(completed.status, JSON.stringify(completed)).toBe('supplemented')
      return completed
    }
    expect(result.status, JSON.stringify(result)).toBe('committed'); return result
  }
  const published = (nameRaw: string | null, file = 1, listNo = 1, extra: Partial<OfficialPublishedRow> = {}): OfficialPublishedRow => ({ nameRaw, usccRaw: uscc, districtRaw: null, declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: '合成公布', docNumber: null, issueDate: null, path: ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf'][file - 1]! }, basis: '合成独立发布依据' }, storedFileId: file, path: ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf'][file - 1]!, sha256: digest, bytes: Buffer.byteLength(sourceBytes), attachment: null, sectionKey: '认定名单', listNo, page: 1, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic-356' }, basis: '合成逐行核实', ...extra })
  const evidence = (row: OfficialPublishedRow) => ({ sourceFile: row.path!, attachment: row.attachment, page: row.page, listNo: row.listNo, publishedRow: row })
  const record = (title: CurrentTitle, events: RosterImportRecord['events'], name = '现用名', code: string | null = uscc): RosterImportRecord => ({ enterprise: { name, uscc: code }, titleCode: title, events })
  const announcement = (records: RosterImportRecord[]): RosterImportPayload => ({ announcement: { sourceDocument: { source: 'jxj', title: '合成公布' }, records } })
  const ids = () => db.select().from(recordEvidence).orderBy(recordEvidence.id)
  const exact = (id: number) => http('/exact?id=' + id)
  const correct = async (id: number, row: OfficialPublishedRow, key: string) => {
    const current = await exact(id)
    const request = { idempotencyKey: key, actor: { type: 'agent', id: 'synthetic-356' }, basis: '合成更正依据', operations: [{ evidenceId: id, eventId: current.eventId, recordId: current.recordId, enterpriseId: current.enterpriseId, expectedVersion: current.version, expectedRowRevision: current.official.row?.revision ?? 0, coordinate: { sourceFile: row.path, attachment: row.attachment, listNo: row.listNo, page: row.page }, publishedRow: row }] }
    const plan = await http('/correction/preflight', request)
    await http('/correction/commit', { request, planHash: plan.planHash })
  }
  return { dir, db, execute, ownerIds, ownerId, seedRetainedName, commit, published, evidence, record, announcement, ids, exact, correct, http }
}


const factsOf = (value: any) => value.publishedPresentation?.facts
const minimal = (evidenceId: number, eventId: number, nameRaw: string | null, revision = 1, sourceBindingKnown = true) => ({ evidenceId, eventId, revision, availability: 'captured', nameRaw, sourceBindingKnown })
async function paired() {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [
    { eventType: 'award', year: 2021, batchSeq: 1, evidence: [f.evidence(f.published('2021旧名'))] },
    { eventType: 'review', year: 2021, batchSeq: 1, decidedYear: 2024, reviewOutcome: 'passed', evidence: [f.evidence(f.published('2024新名', 2))] },
  ])]), 'paired')
  return f
}

it("pairs anonymous detail source and retained current names by stable evidence IDs without exposing C envelopes", async () => {
  const f = await paired(), ids = await f.ids(), expected = [minimal(1, 1, '2021旧名'), minimal(2, 2, '2024新名')]
  const detail = await f.http('/detail?id=' + await f.ownerId())
  expect(factsOf(detail)).toEqual(expected)
  expect(detail.evidence.map((e: any) => [e.id, e.eventId, e.sourceFile, e.page, e.listNo])).toEqual([[1, 1, '2021公布.pdf', 1, 1], [2, 2, '2024公布.pdf', 1, 1]])
  expect(detail.records[0].nameRaw).toBe('现用名')
  const current = await f.http('/current')
  expect(current.total).toBe(1); expect(current.uncertainTotal).toBe(0)
  expect(factsOf(current.rows[0])).toEqual(expected)
  expect(current.rows[0].publishedNames).toEqual(['现用名'])
  for (const id of ids) {
    const source = await f.http('/source?id=' + id.recordEventId)
    expect(factsOf(source.source)).toEqual([expected[id.id - 1]])
    expect(source.source.evidence[0].publishedName).toEqual(expected[id.id - 1])
    expect(Object.keys(source.source.evidence[0].publishedName).sort()).toEqual(['availability','eventId','evidenceId','nameRaw','revision','sourceBindingKnown'])
    const exact = await f.exact(id.id)
    expect(exact.official.row.nameRaw).toBe(expected[id.id - 1]!.nameRaw)
    expect(exact.official.row.actor).toBeDefined()
    expect(JSON.stringify(factsOf(source.source))).not.toMatch(/actor|basis|command|sha256|usccRaw|districtRaw|capturedEnterpriseId/)
  }
})

it("preserves null empty whitespace binding unknown legacy and repeated equal names as distinct sources", async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: [
    f.evidence(f.published(null, 1, 1)), f.evidence(f.published('', 1, 2)), f.evidence(f.published(' \t旧名\n ', 1, 3)),
    f.evidence(f.published('相同名称', 1, 4, { sourceBindingKnown: false })), f.evidence(f.published('相同名称', 1, 5)),
    { sourceFile: '2021公布.pdf', page: 1, listNo: 99 },
  ] }])]), 'mixed')
  const expected = [minimal(1,1,null), minimal(2,1,''), minimal(3,1,' \t旧名\n '), minimal(4,1,'相同名称',1,false), minimal(5,1,'相同名称'), { evidenceId:6,eventId:1,revision:null,availability:'unknown_legacy',nameRaw:null,sourceBindingKnown:null }]
  expect(factsOf(await f.http('/detail?id=' + await f.ownerId()))).toEqual(expected)
  expect(factsOf((await f.http('/source?id=1')).source)).toEqual(expected)
  expect(factsOf((await f.http('/current')).rows[0])).toEqual(expected)
})

it("hydrates only retained current rows after qualification counts filters and options", async () => {
  const f = await paired()
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType:'award',year:2024,batchSeq:1,evidence:[f.evidence(f.published('第二企业',3,2,{usccRaw:null}))] }], '第二企业', null)]), 'second')
  const read = vi.spyOn(official, 'readPostgresOfficialEvidencePages')
  const current = await f.http('/current?page=1&pageSize=1')
  expect(current.total).toBe(2); expect(current.rows).toHaveLength(1)
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls.map(call => call[1])).toEqual([[{eventId:1},{eventId:2}]])
  expect(current.options.recognitionYears).toEqual([2021,2024])
  expect(current.rows[0].qualificationWitnesses).toMatchObject([{cycle:{originYear:2021,batchSeq:1},awardEventId:1,recognition:{precision:'year',year:2021}}])
  expect(current.rows[0].references).toEqual(expect.arrayContaining(['evidence:1 2021公布.pdf  序号:1','evidence:2 2024公布.pdf  序号:1']))
})

it("reads raw-only latest after public correction without caching or changing qualification partitions", async () => {
  const f = await paired(), before = await f.http('/current'), current = await f.exact(2)
  const row = f.published('更正公布原名', 2, 1, { declaration:{kind:'existing',sourceDocumentId:current.official.row.sourceDocumentId,basis:'同一出处复核'} })
  await f.correct(2,row,'raw-only')
  const after = await f.http('/current')
  expect(factsOf(after.rows[0])).toEqual([minimal(1,1,'2021旧名'),minimal(2,2,'更正公布原名',2)])
  expect([after.total,after.uncertainTotal,after.options,after.rows[0].group,after.rows[0].publishedNames]).toEqual([before.total,before.uncertainTotal,before.options,before.rows[0].group,before.rows[0].publishedNames])
  expect(factsOf(await f.http('/detail?id=' + await f.ownerId()))).toEqual(factsOf(after.rows[0]))
  expect(factsOf((await f.http('/source?id=2')).source)).toEqual([minimal(2,2,'更正公布原名',2)])
  expect(after.rows[0].basis).not.toBe(before.rows[0].basis) // B correctly increments event.revision.
})

it("separates unavailable safe errors from unknown legacy while preserving original detail and locators", async () => {
  const f = await paired()
  vi.spyOn(official,'readPostgresOfficialEvidencePages').mockImplementation(() => { throw new Error('private sql secret capture') })
  const detail = await f.http('/detail?id=' + await f.ownerId())
  expect(detail.publishedPresentation).toEqual({availability:'unavailable',error:'read_failed',facts:[]})
  expect(detail.evidence.map((v:any) => [v.id,v.sourceFile,v.page])).toEqual([[1,'2021公布.pdf',1],[2,'2024公布.pdf',1]])
  expect(JSON.stringify(detail)).not.toContain('private sql secret capture')
  expect((await f.http('/source?id=1')).source.publishedPresentation).toEqual({availability:'unavailable',error:'read_failed',facts:[]})
  const query = await f.http('/current')
  expect(query.total).toBe(1); expect(query.rows[0].group).toBe('eligible')
  expect(query.rows[0].publishedPresentation).toEqual({availability:'unavailable',error:'read_failed',facts:[]})
})

it("reuses one selected event Map across source detail and repeated references with no per-evidence latest", async () => {
  const f = await paired()
  const { readPostgresCorrespondenceSources } = await import('../../../layers/sme-roster/server/utils/record-correspondence-postgres')
  // Caller-selected reference inputs to the pure reader, not forged persisted decisions.
  const row = { id: 17, type:'later_process',role:'followup_apply',status:'candidate',eventId:1,predecessorEventId:2,relationId:null,exportRowId:null } as any
  const read = vi.spyOn(official,'readPostgresOfficialEvidencePages'), latest = vi.spyOn(official,'readPostgresPublicOfficialEvidence')
  const reader = await readPostgresCorrespondenceSources(f.db,[row,{...row,id:18}],receiptRedactor([]),{kind:'event',id:1})
  const direct = reader.read('event',1) as any, first = reader.detail(row), second = reader.detail({...row,id:18})
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls.map(call => call[1])).toEqual([[{eventId:1},{eventId:2}]])
  expect(first.event).toBe(direct); expect(second.event).toBe(direct)
  expect((first.event as any).evidence[0].publishedName).toBe((second.event as any).evidence[0].publishedName)
  expect((first.predecessorEvent as any).publishedPresentation.facts).toEqual([minimal(2,2,'2024新名')])
  expect(latest).not.toHaveBeenCalled()
})

it("applies final source copy and text budget without truncating old locators or shrinking A pages", async () => {
  const f = await fixture(), name = 'x'.repeat(600)
  await f.commit(f.announcement([f.record('specialized_sme',[{eventType:'award',year:2024,batchSeq:1,evidence:Array.from({length:20},(_,i) => f.evidence(f.published(name,1,i+1)))}])]),'budget')
  const read = vi.spyOn(official,'readPostgresOfficialEvidencePages')
  const detail = await f.http('/detail?id=' + await f.ownerId())
  expect(detail.publishedPresentation.availability).toBe('available')
  expect(detail.publishedPresentation.facts).toHaveLength(20)
  expect(detail.qualificationAssessment.titles.map((title: any) => title.titleCode)).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
  expect(read).toHaveBeenCalledTimes(1)
  const source = await f.http('/source?id=1')
  expect(source.source.publishedPresentation).toEqual({availability:'unavailable',error:'response_limit',facts:[]})
  expect(source.source.evidence).toHaveLength(20)
  expect(source.source.evidence.map((v:any) => [v.id,v.page,v.listNo])).toEqual(Array.from({length:20},(_,i)=>[i+1,1,i+1]))
  expect(source.source.evidence.every((v:any) => !('publishedName' in v))).toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls.map(call => call[1])).toEqual([[{eventId:1}],[{eventId:1}]])
})

it("preserves A field and event scope failures as typed unavailable without exposing raw errors", async () => {
  const f = await paired()
  // Explicit corrupt historical capture; public B rejects these invalid inputs.
  await f.seedRetainedName('x'.repeat(4001))
  const detail = await f.http('/detail?id=' + await f.ownerId())
  expect(detail.publishedPresentation).toEqual({availability:'unavailable',error:'field_limit',facts:[]})
  expect(detail.evidence).toHaveLength(2)
  await f.seedRetainedName('2021旧名')
  // Explicit extreme legacy event scope, not a normal import shortcut.
  await f.execute("INSERT INTO record_evidence(record_event_id,source_file,page,list_no) SELECT 1,'historical.pdf',1,n FROM generate_series(2,301) n")
  const source = await f.http('/source?id=1')
  expect(source.source.publishedPresentation).toEqual({availability:'unavailable',error:'source_limit',facts:[]})
  expect(source.source.evidence).toHaveLength(301)
})

it("retains captured old and new names after public merge using the surviving owner IDs", async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme',[{eventType:'award',year:2021,batchSeq:1,evidence:[f.evidence(f.published('归并前原名'))]}],'归并前企业',null)]),'old')
  await f.commit(f.announcement([f.record('specialized_sme',[{eventType:'award',year:2024,batchSeq:1,evidence:[f.evidence(f.published('归并后原名',2))]}])]),'new')
  const [oldOwner, newOwner] = await f.ownerIds()
  await f.commit({merges:[{fromEnterpriseId:oldOwner!,intoUscc:uscc,note:'独立主体依据核实归并'}]},'merge')
  const expected = [minimal(1,1,'归并前原名'),minimal(2,2,'归并后原名')]
  const detail = await f.http('/detail?id=' + newOwner)
  expect(detail.enterprise.enterpriseId).toBe(newOwner); expect(factsOf(detail)).toEqual(expected)
  expect(factsOf((await f.http('/current')).rows[0])).toEqual(expected)
  expect(factsOf((await f.http('/source?id=1')).source)).toEqual([expected[0]])
  expect((await f.exact(1)).official.row).toMatchObject({capturedEnterpriseId:oldOwner,currentOwner:{enterpriseId:newOwner}})
})

it("preserves enumerable qualification input exactly under an explicit sidecar-only isolation control", async () => {
  const f = await paired(), before = await f.http('/current'), exact = await f.exact(2)
  const scope = { enterpriseId: await f.ownerId(), asOf: '2026-10-25T08:00:00.000Z', ruleVersion: CURRENT_RULE_VERSION, assessmentVersion: QUALIFICATION_ASSESSMENT_VERSION }
  const assertQA = async (value: CurrentQualificationSnapshot) => {
    expect(value).toMatchObject(scope)
    expect(value.titles.map(item => item.titleCode)).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
    expect(value.snapshotId).toBe(createHash('sha256').update(JSON.stringify([scope, value.titles])).digest('hex'))
    expect(value).toEqual((await readPostgresRosterEnterpriseDetail(f.db, await f.ownerId(), executionTime))!.qualificationAssessment)
  }
  const beforeQA: CurrentQualificationSnapshot = before.rows[0].qualificationAssessment
  await assertQA(beforeQA)
  const capturedSha256 = 'e207797150f31c324144b0f6d2a197f50843ef0b481c3874c0b19889dddfcc4d'
  const originalSources = [
    { evidenceId: 1, eventId: 1, sourceFile: '2021公布.pdf', storedFileId: 1, sha256: capturedSha256, bytes: 458, removedAt: null, capturedRevision: 1, capturedSha256 },
    { evidenceId: 2, eventId: 2, sourceFile: '2024公布.pdf', storedFileId: 2, sha256: capturedSha256, bytes: 458, removedAt: null, capturedRevision: 1, capturedSha256 },
  ]
  const knownNames = [{ evidenceId: 1, availability: 'captured', nameKnown: true }, { evidenceId: 2, availability: 'captured', nameKnown: true }]
  expect(beforeQA.titles[1]!.sourceVersions).toEqual(originalSources)
  expect(beforeQA.titles[1]!.completeness.publishedNames).toEqual(knownNames)
  expect(beforeQA.titles[0]!.sourceVersions).toEqual([])
  expect(beforeQA.titles[0]!.completeness.publishedNames).toEqual([])
  // Independent fixture coordinates; correction changes only capturedRevision.
  const hashJSON = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const emptyGiantSources = hashJSON([[], [], [], []])
  const evidenceInputs = [
    { id: 1, eventId: 1, sourceFile: '2021公布.pdf', attachment: null, listNo: 1, page: 1 },
    { id: 2, eventId: 2, sourceFile: '2024公布.pdf', attachment: null, listNo: 1, page: 1 },
  ]
  const lowerSources = (revision: number) => hashJSON([
    hashJSON([evidenceInputs, [originalSources[0], { ...originalSources[1], capturedRevision: revision }], knownNames, []]), emptyGiantSources,
  ])
  const innovativeSources = (revision: number) => hashJSON([hashJSON([emptyGiantSources, emptyGiantSources]), lowerSources(revision)])
  expect(beforeQA.titles.map(title => title.versions.sources)).toEqual([emptyGiantSources, lowerSources(1), innovativeSources(1)])
  expect(beforeQA.titles[1]!.group).toBe('eligible')
  expect(beforeQA.titles[1]!.cycles).toEqual([{ originYear: 2021, batchSeq: 1, precision: 'year' }])
  const row = f.published('隔离变量公布名',2,1,{declaration:{kind:'existing',sourceDocumentId:exact.official.row.sourceDocumentId,basis:'同一公布事实'}})
  await f.correct(2,row,'isolation')
  // Public correction increments event.revision. Pin just that old input to isolate the sidecar.
  await f.execute('UPDATE record_event SET revision=$1 WHERE id=2', exact.event.revision)
  const after = await f.http('/current')
  const afterQA: CurrentQualificationSnapshot = after.rows[0].qualificationAssessment
  await assertQA(afterQA)
  expect(afterQA.titles[1]!.sourceVersions).toEqual([originalSources[0], { ...originalSources[1], capturedRevision: 2 }])
  expect(afterQA.titles[1]!.completeness.publishedNames).toEqual(knownNames)
  expect(afterQA.titles[1]!.versions.sources).toBe(lowerSources(2))
  // Exactly these source changes are allowed. Everything else, including unknown
  // added/deleted fields, stays deeply equal except downstream source dependency.
  const expectedAfter = structuredClone(beforeQA)
  expectedAfter.titles[1]!.sourceVersions[1]!.capturedRevision = 2
  expectedAfter.titles[1]!.versions.sources = lowerSources(2)
  expectedAfter.titles[2]!.versions.sources = innovativeSources(2)
  expectedAfter.snapshotId = createHash('sha256').update(JSON.stringify([scope, expectedAfter.titles])).digest('hex')
  expect(afterQA).toEqual(expectedAfter)
  expect(afterQA.snapshotId).not.toBe(beforeQA.snapshotId)
  expect(afterQA.titles[0]).toEqual(beforeQA.titles[0])
  expect({ ...afterQA.titles[2], versions: beforeQA.titles[2]!.versions }).toEqual(beforeQA.titles[2])
  // Only after the complete new object is validated, retain the old enumerable oracle.
  const strip = (v: CurrentQualifiedResult) => ({ ...v, rows: v.rows.map(({ publishedPresentation, qualificationAssessment, ...old }) => old) })
  expect(strip(after)).toEqual(strip(before))
  expect(factsOf(after.rows[0])).toEqual([minimal(1,1,'2021旧名'),minimal(2,2,'隔离变量公布名',2)])
  expect((await f.db.transaction(async tx => readPostgresCurrentFilterBatch(tx, [await f.ownerId()], 'specialized_sme', executionTime), readSnapshot)).get(await f.ownerId())?.row.group).toBe('eligible')
})

it("reads actual H3 routes and MCP handlers through the same serialized DTO while C exact auth remains protected", async () => {
  const f = await paired(), h3 = await import('h3'), { createServer } = await import('node:http')
  for (const key of ['defineEventHandler','getRouterParam','setHeader','createError'] as const) vi.stubGlobal(key,h3[key])
  vi.stubGlobal('useRuntimeConfig',() => ({apiToken:'synthetic-356-api',mcpToken:'synthetic-mcp-356',filesDir:f.dir+'/files'}))
  const router = h3.createRouter()
  router.get('/api/roster/enterprises/:id',(await import('../../../layers/sme-roster/server/api/roster/enterprises/[id].get')).default)
  router.get('/api/roster/current-enterprises',(await import('../../../layers/sme-roster/server/api/roster/current-enterprises.get')).default)
  router.get('/api/roster/correspondences/events/:id',(await import('../../../layers/sme-roster/server/api/roster/correspondences/events/[id].get')).default)
  router.get('/api/roster/evidence/:id',(await import('../../../layers/sme-roster/server/api/roster/evidence/[id].get')).default)
  const server = createServer(h3.toNodeListener(h3.createApp().use(router)))
  await new Promise<void>((resolve,reject) => { server.once('error',reject);server.listen(0,'127.0.0.1',resolve) })
  closes.push(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())))
  const address=server.address();if(!address || typeof address==='string')throw Error('Missing owned listener')
  const trace:unknown[]=[];closes.push(() => writeFileSync(join(f.dir,'h3-reads.json'),JSON.stringify(trace,null,2)))
  const get=async(path:string,token?:string) => {const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{headers:token?{authorization:'Bearer '+token}:{}});const body=await response.json();trace.push({path,tokenPresent:!!token,status:response.status,body});return {status:response.status,body}}
  const expected=[minimal(1,1,'2021旧名'),minimal(2,2,'2024新名')]
  const detail=await get('/api/roster/enterprises/' + await f.ownerId()),query=await get('/api/roster/current-enterprises?titleCode=specialized_sme'),source=await get('/api/roster/correspondences/events/2')
  expect([detail.status,query.status,source.status]).toEqual([200,200,200])
  expect(factsOf(detail.body)).toEqual(expected);expect(factsOf(query.body.rows[0])).toEqual(expected);expect(factsOf(source.body.source)).toEqual([expected[1]])
  const { dispatchRecordCorrespondenceMcp }=await import('../../../layers/sme-roster/server/utils/mcp-record-correspondence')
  expect(await dispatchRecordCorrespondenceMcp('source',{kind:'event',id:2})).toEqual(source.body)
  const detailTool=(await import('../../../layers/sme-roster/server/mcp/tools/get_enterprise_detail')).default
  const currentTool=(await import('../../../layers/sme-roster/server/mcp/tools/list_current_qualified_enterprises')).default
  // Direct tool handlers, not the real MCP transport or native admission.
  expect(JSON.parse(await (detailTool as any).handler({enterpriseId:await f.ownerId()}))).toEqual(detail.body)
  expect(JSON.parse(await (currentTool as any).handler({titleCode:'specialized_sme'}))).toEqual(query.body)
  expect((await get('/api/roster/evidence/1')).status).toBe(200)
  expect((await get('/api/roster/evidence/1?official=latest')).status).toBe(401)
  expect((await get('/api/roster/evidence/1?official=latest','wrong')).status).toBe(401)
  const c=await get('/api/roster/evidence/1?official=latest','synthetic-356-api')
  expect(c.status).toBe(200);expect(c.body.official.row).toMatchObject({nameRaw:'2021旧名',actor:{type:'agent',id:'synthetic-356'},usccRaw:uscc})
  expect(JSON.stringify(factsOf(detail.body))).not.toMatch(/actor|command|basis|sha256|usccRaw|districtRaw/)
})

it("rejects total enterprise name bytes across individually small event pages and preserves current counts", async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme',Array.from({length:4},(_,eventIndex) => ({eventType:'award' as const,year:2021+eventIndex,batchSeq:1,evidence:Array.from({length:10},(_,i) => f.evidence(f.published('x'.repeat(1000),1,eventIndex*10+i+1)))})))]),'enterprise-scope')
  const detail=await f.http('/detail?id=' + await f.ownerId())
  expect(detail.publishedPresentation).toEqual({availability:'unavailable',error:'response_limit',facts:[]})
  expect(detail.events).toHaveLength(4);expect(detail.evidence).toHaveLength(40)
  const assessment = detail.qualificationAssessment.titles.find((title: any) => title.titleCode === 'specialized_sme')
  expect(assessment.completeness.publishedNames).toEqual(Array.from({ length: 40 }, (_, i) => ({ evidenceId: i + 1, availability: 'captured', nameKnown: true })))
  expect(assessment.effectiveQualification.status).toBe('effective')
  const current=await f.http('/current')
  expect(current.total).toBe(1);expect(current.rows[0].group).toBe('eligible')
  expect(current.rows[0].publishedPresentation).toEqual({availability:'unavailable',error:'response_limit',facts:[]})
})

async function currentH3(f: Awaited<ReturnType<typeof fixture>>) {
  const h3 = await import('h3'), { createServer } = await import('node:http')
  vi.stubGlobal('defineEventHandler', h3.defineEventHandler)
  const handler = (await import('../../../layers/sme-roster/server/api/roster/current-enterprises.get')).default
  const server = createServer(h3.toNodeListener(h3.createApp().use('/api/roster/current-enterprises', handler)))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  closes.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned H3 listener')
  return async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/roster/current-enterprises?titleCode=specialized_sme`)
    expect(response.status).toBe(200); const result = await response.json()
    writeFileSync(join(f.dir, 'current-h3-r1.json'), JSON.stringify(result, null, 2)); return result
  }
}

async function budgetFixture(count: number, perEvent: number, name: string) {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', Array.from({ length: count / perEvent }, (_, eventIndex) => ({
    eventType: 'award' as const, year: 2025 - count / perEvent + eventIndex, batchSeq: 1,
    evidence: Array.from({ length: perEvent }, (_, i) => f.evidence(f.published(name, 1, eventIndex * perEvent + i + 1))),
  })))]), 'r1-budget')
  const literal = Array.from({ length: count }, (_, i) => minimal(i + 1, Math.floor(i / perEvent) + 1, name))
  // Independent expected strings: no production formatter/budget builder supplies this oracle.
  const text = Array.from({ length: count }, () => '公布名称：' + JSON.stringify(name))
  const dtoBytes = Buffer.byteLength(JSON.stringify({ publishedPresentation: { availability: 'available', error: null, facts: literal } }))
  const textBytes = Buffer.byteLength(JSON.stringify(text))
  return { f, literal, dtoBytes, textBytes, get: await currentH3(f) }
}

it.each([{ case: 'Spec25', count: 25, perEvent: 5 }, { case: 'Standards24', count: 24, perEvent: 1 }])(
  "rejects current double text overflow while retaining one DTO and all old qualification fields for $case", async ({ count, perEvent }) => {
    const { f, literal, dtoBytes, textBytes, get } = await budgetFixture(count, perEvent, 'x'.repeat(1000))
    expect(dtoBytes + textBytes).toBeLessThan(65536)
    expect(dtoBytes + textBytes * 2).toBeGreaterThan(65536)
    const ownerId = await f.ownerId()
    const beforeRows = await f.db.transaction(tx => readPostgresCurrentDetailBatch(tx, [ownerId], 'specialized_sme', executionTime), readSnapshot)
    const { assessment: _assessment, ...before } = beforeRows.get(ownerId)!.rows.find(row => row.assessment?.titleCode === 'specialized_sme')!
    const current = await get(), { publishedPresentation, qualificationAssessment, ...old } = current.rows[0]
    // The additive complete T2 is checked before the unchanged legacy-row oracle.
    const scope = { enterpriseId: await f.ownerId(), asOf: new Date(executionTime).toISOString(), ruleVersion: CURRENT_RULE_VERSION, assessmentVersion: QUALIFICATION_ASSESSMENT_VERSION }
    expect(current.responseVersion).toBe('current-qualified-478-v2')
    expect(qualificationAssessment).toMatchObject(scope)
    expect(qualificationAssessment.titles.map((item: { titleCode: string }) => item.titleCode)).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
    expect(qualificationAssessment.snapshotId).toBe(createHash('sha256').update(JSON.stringify([scope, qualificationAssessment.titles])).digest('hex'))
    expect(qualificationAssessment).toEqual((await readPostgresRosterEnterpriseDetail(f.db, await f.ownerId(), executionTime))!.qualificationAssessment)
    expect(current.total).toBe(1); expect(current.uncertainTotal).toBe(0); expect(old).toEqual(before)
    expect(old.references.filter((v: string) => v.startsWith('evidence:'))).toHaveLength(count)
    const detail = await f.http('/detail?id=' + await f.ownerId())
    expect(detail.publishedPresentation.facts).toEqual(literal)
    expect(detail.evidence.map((v: any) => [v.id, v.eventId, v.sourceFile, v.page, v.listNo])).toEqual(literal.map((v, i) => [v.evidenceId, v.eventId, '2021公布.pdf', 1, i + 1]))
    expect(publishedPresentation).toEqual({ availability: 'unavailable', error: 'response_limit', facts: [] })
  },
)

it("keeps current under budget when one DTO and two texts fit but doubling the DTO would not", async () => {
  const { f, literal, dtoBytes, textBytes, get } = await budgetFixture(24, 1, 'x'.repeat(700))
  await f.commit({ aliases: [{ uscc, name: '已确认旧名', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'confirmed' }, { uscc, name: '待核别名', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'pending' }] }, 'r1-aliases')
  expect(dtoBytes + textBytes * 2).toBeLessThan(65536)
  expect(dtoBytes * 2 + textBytes * 2).toBeGreaterThan(65536)
  const current = await get()
  expect(current.rows[0].publishedPresentation).toEqual({ availability: 'available', error: null, facts: literal })
  expect(current.rows[0].aliases).toEqual(['已确认旧名'])
  expect(current.total).toBe(1)
})

it.each([{ case: 'escaped-below', repeats: 48, available: true }, { case: 'escaped-above', repeats: 54, available: false }])(
  "budgets escaped Unicode UTF8 across both current text branches for $case", async ({ repeats, available }) => {
    const name = '中🙂"\\\n'.repeat(repeats)
    const { literal, dtoBytes, textBytes, get } = await budgetFixture(24, 1, name)
    expect(name.length).toBeLessThan(4000)
    if (available) expect(dtoBytes + textBytes * 2).toBeLessThan(65536)
    else expect(dtoBytes + textBytes * 2).toBeGreaterThan(65536)
    const current = await get()
    expect(current.rows[0].publishedPresentation).toEqual(available
      ? { availability: 'available', error: null, facts: literal }
      : { availability: 'unavailable', error: 'response_limit', facts: [] })
    expect(current.rows[0].group).toBe('eligible'); expect(current.total).toBe(1)
  },
)

it('detail and ledger preserve each published name and original coordinates after filtering', async () => {
  const { readPostgresLedgerEnterpriseDetail, allPostgresLedgerRecords } = await import('../../../layers/sme-roster/lib/query-postgres')
  const f = await paired()
  const detail = (await readPostgresLedgerEnterpriseDetail(f.db, await f.ownerId()))!
  expect(detail.name).toBe('现用名')
  expect(detail.publishedPresentation).toEqual({ availability: 'available', error: null, facts: [minimal(1,1,'2021旧名'),minimal(2,2,'2024新名')] })
  expect(detail.records[0]!.events.map(e => e.evidence)).toEqual([
    [{ id: 1, sourceFile: '2021公布.pdf', attachment: null, listNo: 1, page: 1 }],
    [{ id: 2, sourceFile: '2024公布.pdf', attachment: null, listNo: 1, page: 1 }],
  ])
  expect(await allPostgresLedgerRecords(f.db, { eventType: ['award'] })).toEqual([{
    enterpriseId: await f.ownerId(), name: '现用名', uscc, district: null, titleCode: 'specialized_sme', sources: ['jxj'],
    events: '认定 2021-1; 复核 2021-1',
    evidence: '2021公布.pdf / 序号1 / 第1页 / 公布名称："2021旧名"; 2024公布.pdf / 序号1 / 第1页 / 公布名称："2024新名"',
  }])
})

it('uncaptured and captured unknown names stay distinct from unavailable', async () => {
  const { readPostgresLedgerEnterpriseDetail, allPostgresLedgerRecords } = await import('../../../layers/sme-roster/lib/query-postgres')
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: [
    f.evidence(f.published(null)), { sourceFile: '2024公布.pdf', page: 1, listNo: 9 },
  ] }])]), 'legacy-mixed')
  expect((await readPostgresLedgerEnterpriseDetail(f.db, await f.ownerId()))!.publishedPresentation).toEqual({ availability: 'available', error: null, facts: [
    minimal(1,1,null), { evidenceId: 2, eventId: 1, revision: null, availability: 'unknown_legacy', nameRaw: null, sourceBindingKnown: null },
  ] })
  expect((await allPostgresLedgerRecords(f.db, {}))[0]!.evidence).toBe('2021公布.pdf / 序号1 / 第1页 / 已捕获出处，名称原值未知; 2024公布.pdf / 序号9 / 第1页 / 未逐出处核实')
  // Corrupt historical storage is intentionally outside the valid command contract.
  await f.seedRetainedName('x'.repeat(4001))
  expect((await readPostgresLedgerEnterpriseDetail(f.db, await f.ownerId()))!.publishedPresentation).toEqual({ availability: 'unavailable', error: 'field_limit', facts: [] })
  expect((await allPostgresLedgerRecords(f.db, {}))[0]!.evidence).toBe('2021公布.pdf / 序号1 / 第1页 / 公布名称暂不可用; 2024公布.pdf / 序号9 / 第1页 / 公布名称暂不可用')

})

it('actual legacy HTTP detail and sync XLSX retain a literal matrix with per-source names', async () => {
  const f = await paired()
  const { createServer } = await import('node:http')
  const h3 = await import('h3')
  for (const [name, value] of Object.entries({ defineEventHandler: h3.defineEventHandler, getQuery: h3.getQuery, setHeader: h3.setHeader, createError: h3.createError, getRouterParam: h3.getRouterParam })) vi.stubGlobal(name, value)
  const app = h3.createApp(), router = h3.createRouter()
  router.get('/api/enterprises/:id', (await import('../../../layers/sme-roster/server/api/enterprises/[id].get')).default)
  router.get('/api/export', (await import('../../../layers/sme-roster/server/api/export.get')).default)
  app.use(router)
  const server = createServer(h3.toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closes.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const response = await fetch(baseUrl + '/api/enterprises/' + await f.ownerId())
  expect(response.status).toBe(200)
  const detail = await response.json()
  expect(detail.publishedPresentation.facts).toEqual([minimal(1,1,'2021旧名'),minimal(2,2,'2024新名')])
  expect(detail.records.map((r: any) => [r.id, r.events.map((e: any) => [e.id,e.recordId,e.evidence.map((v: any) => [v.id,v.sourceFile,v.page])])])).toEqual([[1,[[1,1,[[1,'2021公布.pdf',1]]],[2,1,[[2,'2024公布.pdf',1]]]]]])
  const { readExportWorkbook } = await import('../../support/read-workbook')
  const download = await fetch(baseUrl + '/api/export?eventType=award')
  expect(download.status).toBe(200)
  expect(download.headers.get('content-type')).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const workbook = await readExportWorkbook(new Uint8Array(await download.arrayBuffer()))
  const sheet = workbook.worksheets[0]!
  expect(sheet.name).toBe('台账')
  expect(sheet.rowCount).toBe(3)
  expect(sheet.getRow(2).values).toEqual([, '企业名称','统一社会信用代码','区县','称号','来源','事件','出处'])
  expect(sheet.getRow(3).values).toEqual([, '现用名',uscc,'','专精特新中小企业','经信局','认定 2021-1; 复核 2021-1', '2021公布.pdf / 序号1 / 第1页 / 公布名称："2021旧名"; 2024公布.pdf / 序号1 / 第1页 / 公布名称："2024新名"'])
})

it('ledger batches selected groups and isolates an unavailable group without changing rows', async () => {
  const { allPostgresLedgerRecords } = await import('../../../layers/sme-roster/lib/query-postgres')
  const f = await paired()
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: [
    f.evidence(f.published('第二公布名', 3, 2, { usccRaw: null })),
  ] }], '第二企业', null)]), 'ledger-second')
  const read = vi.spyOn(official, 'readPostgresOfficialEvidencePages')
  expect((await allPostgresLedgerRecords(f.db, {})).map(row => [row.name,row.evidence])).toEqual([
    ['现用名','2021公布.pdf / 序号1 / 第1页 / 公布名称："2021旧名"; 2024公布.pdf / 序号1 / 第1页 / 公布名称："2024新名"'],
    ['第二企业','独立佐证.pdf / 序号2 / 第1页 / 公布名称："第二公布名"'],
  ])
  expect(read).toHaveBeenCalledTimes(1)
  await f.seedRetainedName('x'.repeat(4001))
  expect((await allPostgresLedgerRecords(f.db, {})).map(row => [row.name,row.evidence])).toEqual([
    ['现用名','2021公布.pdf / 序号1 / 第1页 / 公布名称暂不可用; 2024公布.pdf / 序号1 / 第1页 / 公布名称暂不可用'],
    ['第二企业','独立佐证.pdf / 序号2 / 第1页 / 公布名称："第二公布名"'],
  ])
})

it('large display batches retain names in independently bounded groups', async () => {
  const { allPostgresLedgerRecords } = await import('../../../layers/sme-roster/lib/query-postgres')
  const f = await fixture(), names = ['A'.repeat(1500), 'B'.repeat(1500)]
  await f.commit(f.announcement(names.map((name, index) => f.record('specialized_sme', [{
    eventType: 'award', year: 2024, batchSeq: 1,
    evidence: Array.from({ length: 10 }, (_, n) => f.evidence(f.published(name, index + 1, n + 1, { usccRaw: null }))),
  }], index === 0 ? '甲企业' : '乙企业', null))), 'ledger-batch-budget')
  const rows = (await allPostgresLedgerRecords(f.db, {}))
  expect(rows.map(row => row.name)).toEqual(['乙企业','甲企业'])
  expect(rows[0]!.evidence.split('; ').map(text => text.slice(text.indexOf(' / 公布名称')))).toEqual(Array(10).fill(' / 公布名称："' + names[1] + '"'))
  expect(rows[1]!.evidence.split('; ').map(text => text.slice(text.indexOf(' / 公布名称')))).toEqual(Array(10).fill(' / 公布名称："' + names[0] + '"'))
})
