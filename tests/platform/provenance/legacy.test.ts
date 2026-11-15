import { submitNativePlatformQuery } from '../../helpers/native-platform-fixture'
import { sourceReader } from '../../../server/utils/record-correspondence-read'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { initializeDb } from '../../../db/client'
import * as schema from '../../../db/schema'
import { commitRosterImport, planRosterImport, preflightRosterImport, validateImportRequest } from '../../../server/utils/roster-import'
import { handleRosterImportRequest } from '../../../server/utils/roster-import-http'
import { inspectLegacyPlatformProvenance } from '../../../server/utils/platform-legacy-provenance'
import { legacyPlatformProvenanceItemsSchema, type LegacyPlatformCollection, type LegacyPlatformProvenanceInput } from '../../../lib/platform/legacy-provenance'
import { platformEvidenceError } from '../../../lib/platform/recognized-evidence'
import { listPlatformQueries } from '../../../lib/platform/read'
import { readPlatformQueryEvidence } from '../../../lib/platform/evidence-read'
import { getRosterEnterpriseDetail } from '../../../lib/roster/enterprise-roster'
import { rosterImportMcpPayloadSchema } from '../../../server/utils/roster-import-schema'
import type { RosterImportRequest } from '../../../lib/roster-import-client'

const dir = mkdtempSync(join(tmpdir(), 'legacy-provenance-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') })
let serial = 0
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
function request(inputs: LegacyPlatformProvenanceInput[]): RosterImportRequest {
  return { sourceKind: 'platform_archive', sourceIdentity: 'synthetic-legacy-provenance', idempotencyKey: `legacy-provenance-${++serial}`, payload: { platformLegacyProvenance: inputs } }
}
function fixture(empty = false) {
  const number = ++serial
  const enterpriseId = db.insert(schema.enterprise).values({ name: `合成企业${number}`, nameNorm: `合成企业${number}` }).returning().get().id
  const collection: LegacyPlatformCollection = {
    source: 'businessList', status: empty ? 'no_record' : 'success',
    effectiveConditions: { uscc: '9133020078041158X6', combination: 'and' },
    titleScope: { mode: 'selected', rdjb: ['1', '2', '3'] },
    queriedAt: `2026-11-06T01:00:${String(number % 60).padStart(2, '0')}.${String(number).padStart(3, '0')}Z`,
    completedAt: '2026-11-06T02:00:00.000Z',
    rows: empty ? [] : [{ id: `${number}-a`, rdjb: '2', qymc: '合成', blank: '', count: '0' }, { id: `${number}-b`, rdjb: '2', qymc: '合成', unknown: '' }, { id: `${number}-c`, rdjb: '3', qymc: '合成', value: '🙂' }],
    pages: ['1', '2', '3'].map(rdjb => ({ source: 'businessList', rdjb, page: 1, status: 'success', fetchedCount: empty || rdjb === '1' ? 0 : rdjb === '2' ? 2 : 1, declaredTotal: empty || rdjb === '1' ? 0 : rdjb === '2' ? 2 : 1, error: null })),
    fetchedCount: empty ? 0 : 3, declaredTotal: empty ? 0 : 3, completeness: 'complete', fullRange: true,
    unfinished: [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
  }
  const queryId = submitNativePlatformQuery(db, { interface:'business_list',queryKey:collection.effectiveConditions.uscc!,rdjb:'1,2,3',queriedAt:collection.queriedAt,status:empty?'no_record':'success',rawResponse:'original-native-sentinel',relations:collection.rows.map((rawFields,index)=>({sequenceNo:index+1,relationKey:rawFields.id!,nameRaw:'合成',enterpriseId,rawFields,verificationStatus:'confirmed'})) }).queryId
  const input: LegacyPlatformProvenanceInput = { queryId, interface: 'business_list', queryKey: collection.effectiveConditions.uscc!, rdjb: '1,2,3', queriedAt: collection.queriedAt,
    sourceIdentity: `synthetic/file-${number}.json`, sourceSha256: createHash('sha256').update(`source-${number}`).digest('hex'), segmentIndex: 0,
    collection, relations: collection.rows.map((rawFields, index) => ({ sequenceNo: index + 1, relationKey: rawFields.id!, rawFields })) }
  return { input, enterpriseId }
}
const protectedTables = ['platform_collection', 'platform_observation_assignment', 'platform_legacy_query_alias', 'platform_legacy_relation_alias', 'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'record_correspondence', 'difference_reason']
function protectedRows() { return protectedTables.map(table => [table, db.$client.prepare(`select * from ${table} order by rowid`).all()]) }
function submit(input: LegacyPlatformProvenanceInput) { return commitRosterImport(db, request([input]), [], { deferCandidateTasks: true }) }

describe('independent legacy provenance', () => {
  it('preflights without business writes and commits real pagination without changing protected facts', () => {
    const { input, enterpriseId } = fixture()
    const before = protectedRows()
    const command = request([input])
    expect(preflightRosterImport(db, command).preflight).toMatchObject({ add: 1, conflicts: [], platformLegacyProvenanceSources: [{ queryId: input.queryId, inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }] })
    expect(provenanceDisplays( [input.queryId]).size).toBe(0)
    const result = commitRosterImport(db, command, [], { deferCandidateTasks: true })
    expect(result).toMatchObject({ status: 'committed', summary: { written: 1 }, items: [{ ok: true, kind: 'platform_legacy_provenance', detail: { typedState: 'unknown', relationCount: 3 } }] })
    expect(protectedRows()).toEqual(before)
    const metadata = provenanceDisplays( [input.queryId]).get(input.queryId)!
    expect(metadata).toMatchObject({ kind: 'legacy_pagination', sourceSha256: input.sourceSha256, segmentIndex: 0, collection: expect.objectContaining({ pages: input.collection.pages }), importBatchId: result.batchId })
    const query = listPlatformQueries(db, { queryId: input.queryId }).rows[0]!
    expect(query.query.collectionEvidence).toBeNull()
    expect(query.query.legacyProvenance?.kind).toBe('legacy_pagination')
    expect(query.query.legacyProvenance?.collection).not.toHaveProperty('rows')
    expect(query.relations.map(row => [row.sourceRdjb, row.sourcePage])).toEqual([['2', 1], ['2', 1], ['3', 1]])
    const detail = getRosterEnterpriseDetail(db, enterpriseId, Date.parse('2026-11-07T00:00:00Z'))!
    expect(detail.platform.queries[0]?.collectionEvidence).toBeNull()
    expect(detail.platform.queries[0]?.legacyProvenance?.kind).toBe('legacy_pagination')
    expect(detail.platform.relations.map(row => [row.sourceRdjb, row.sourcePage])).toEqual([['2', 1], ['2', 1], ['3', 1]])
    const source=sourceReader(db, [], {kind:'relation', id:query.relations[2]!.id}).read('relation', query.relations[2]!.id) as any
    expect(source).toMatchObject({sourceRdjb:'3',sourcePage:1,query:{collectionEvidence:null,legacyProvenance:{kind:'legacy_pagination'}}})
    expect(source.query.legacyProvenance.collection).not.toHaveProperty('rows')
  })

  it('keeps original second-page positions and exposes full legacy rows only through exact evidence reads', () => {
    const { input } = fixture()
    input.collection.limits.pageSize = 1
    input.collection.pages.splice(1, 1,
      { source: 'businessList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 2, error: null },
      { source: 'businessList', rdjb: '2', page: 2, status: 'success', fetchedCount: 1, declaredTotal: 2, error: null })
    expect(submit(input).status).toBe('committed')
    expect(listPlatformQueries(db, { queryId: input.queryId }).rows[0]!.relations.map(row => [row.sourceRdjb, row.sourcePage])).toEqual([['2', 1], ['2', 2], ['3', 1]])
    const chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      const chunk = readPlatformQueryEvidence(db, { queryId: input.queryId, field: 'legacyProvenance', offset, length: 11 }) as any
      expect(chunk.isNull).toBe(false)
      chunks.push(Buffer.from(chunk.data, 'base64')); offset += chunk.byteLength
      if (!chunk.hasMore) break
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(JSON.stringify(input.collection))
    expect(readPlatformQueryEvidence(db, { queryId: fixture().input.queryId, field: 'legacyProvenance' })).toMatchObject({ isNull: true, totalBytes: 0 })
  })

  it('replays the same receipt and independently skips an identical supplement', () => {
    const { input } = fixture(), command = request([input])
    const first = commitRosterImport(db, command, [], { deferCandidateTasks: true })
    expect(first.status).toBe('committed')
    expect(commitRosterImport(db, command, [], { deferCandidateTasks: true })).toEqual(first)
    const another = submit(input)
    expect(another).toMatchObject({ status: 'committed', summary: { written: 0, skipped: 1 } })
    expect(provenanceDisplays( [input.queryId]).get(input.queryId)?.importBatchId).toBe(first.batchId)
  })

  it('accepts an explicitly empty complete collection without creating relations', () => {
    const { input } = fixture(true)
    expect(submit(input).status).toBe('committed')
    expect(listPlatformQueries(db, { queryId: input.queryId }).rows[0]).toMatchObject({ query: { status: 'no_record', collectionEvidence: null, legacyProvenance: { kind: 'legacy_pagination' } }, relations: [] })
  })

  it.each(['queryId', 'queryKey', 'rdjb', 'queriedAt'] as const)('rejects a mismatched original natural key field %s', field => {
    const { input } = fixture()
    if (field === 'queryId') input.queryId = 987654321
    else input[field] += '-wrong'
    const result = submit(input)
    expect(result.status).toBe('failed')
    expect(result.items[0]?.error?.code).toMatch(/legacy_query_(missing|identity_conflict)/)
    expect(provenanceDisplays( [input.queryId]).size).toBe(0)
  })

  it.each(['missing', 'extra', 'order', 'relationKey', 'rawFields'] as const)('rejects an incomplete or changed original relation set %s', change => {
    const { input } = fixture()
    if (change === 'missing') input.relations.pop()
    else if (change === 'extra') input.relations.push({ ...input.relations[0]!, sequenceNo: 4 })
    else if (change === 'order') input.relations.reverse()
    else if (change === 'relationKey') input.relations[0]!.relationKey = 'wrong'
    else input.relations[0] = { ...input.relations[0]!, rawFields: { ...input.relations[0]!.rawFields, unknown: 'invented' } }
    const result = submit(input)
    expect(result.status).toBe('failed')
    expect(result.items[0]?.error?.code).toMatch(/legacy_relation_(set|payload)_conflict/)
    expect(provenanceDisplays( [input.queryId]).size).toBe(0)
  })

  it('rejects internally valid page counts that assign a row to another rdjb', () => {
    const { input } = fixture()
    input.collection.pages[1]!.rdjb = '3'; input.collection.pages[2]!.rdjb = '2'
    const result = submit(input)
    expect(result).toMatchObject({ status: 'failed', items: [{ error: { code: 'legacy_page_title_conflict' } }] })
  })

  it('rejects an alternate file hash segment or collection after a supplement exists', () => {
    const { input } = fixture()
    expect(submit(input).status).toBe('committed')
    for (const field of ['sourceIdentity', 'sourceSha256', 'segmentIndex', 'collection'] as const) {
      const changed = structuredClone(input)
      if (field === 'sourceIdentity') changed.sourceIdentity += '.other'
      else if (field === 'sourceSha256') changed.sourceSha256 = 'f'.repeat(64)
      else if (field === 'segmentIndex') changed.segmentIndex = 1
      else changed.collection.completedAt = '2026-11-06T03:00:00.000Z'
      expect(submit(changed)).toMatchObject({ status: 'failed', items: [{ error: { code: 'legacy_provenance_conflict' } }] })
    }
    expect(provenanceDisplays( [input.queryId]).get(input.queryId)?.collection).toEqual(Object.fromEntries(Object.entries(input.collection).filter(([key]) => key !== 'rows')))
  })

  it('rejects a source file segment already owned by another query', () => {
    const first = fixture().input, second = fixture().input
    expect(submit(first).status).toBe('committed')
    second.sourceSha256 = first.sourceSha256; second.segmentIndex = first.segmentIndex
    expect(submit(second)).toMatchObject({ status: 'failed', items: [{ error: { code: 'legacy_source_identity_conflict' } }] })
  })

  it('rolls back an entire batch when another supplemental item conflicts', () => {
    const first = fixture().input, second = fixture().input
    second.relations[0]!.relationKey = 'invalid'
    const before = protectedRows()
    expect(commitRosterImport(db, request([first, second]), [], { deferCandidateTasks: true }).status).toBe('failed')
    expect(provenanceDisplays( [first.queryId, second.queryId]).size).toBe(0)
    expect(protectedRows()).toEqual(before)
  })

  it('discovers explicit source locks on REST and MCP without claiming typed evidence', () => {
    const mcp = z.toJSONSchema(rosterImportMcpPayloadSchema, { io: 'input' }) as any
    const rest = ['preflight', 'commit'].map(action => JSON.parse(readFileSync(new URL(`../../../server/api/roster/import/${action}.post.ts`, import.meta.url), 'utf8').match(/payload: (\{\n[\s\S]*?\n\}),/)![1]!))
    for (const payload of [mcp, ...rest]) {
      expect(payload.properties.platformLegacyProvenance).toMatchObject({ type: 'array', minItems: 1, maxItems: 100, items: { additionalProperties: false, required: expect.arrayContaining(['queryId', 'interface', 'queryKey', 'rdjb', 'queriedAt', 'sourceSha256', 'segmentIndex', 'collection', 'relations']) } })
    }
    for (const payload of [mcp, ...rest]) {
      const fields=payload.properties.platformLegacyProvenance.items.properties
      expect(fields.collection.properties.source.enum ?? [fields.collection.properties.source.const]).toEqual(['businessList'])
      expect(fields.collection.properties).not.toHaveProperty('rawData')
      expect(fields.collection.properties).not.toHaveProperty('dataRows')
      expect(fields.relations.maxItems).toBe(5000)
    }
    expect(legacyPlatformProvenanceItemsSchema.safeParse([fixture().input]).success).toBe(true)
  })

  it('accepts the supplemental command through authenticated public HTTP semantics', async () => {
    const { input } = fixture(), command = request([input])
    const deps = { db, apiToken: 'synthetic-token', executeImport: async (_db: unknown, action: string, body: RosterImportRequest) => action === 'preflight' ? preflightRosterImport(db, body) : commitRosterImport(db, body, [], { deferCandidateTasks: true }) } as any
    expect((await handleRosterImportRequest('commit', { method: 'POST', headers: {}, body: command }, deps)).status).toBe(401)
    const incoming = { method: 'POST', headers: { authorization: 'Bearer synthetic-token' }, body: command }
    expect(await handleRosterImportRequest('preflight', incoming, deps)).toMatchObject({ status: 200, body: { preflight: { add: 1, conflicts: [] } } })
    expect(await handleRosterImportRequest('commit', incoming, deps)).toMatchObject({ status: 200, body: { status: 'committed', items: [{ detail: { typedState: 'unknown' } }] } })
    expect(inspectLegacyPlatformProvenance(db, input).exists).toBe(true)
  })
})

function provenanceDisplays(ids: readonly number[]) {
 return new Map(ids.flatMap(id=>{const metadata=listPlatformQueries(db,{queryId:id}).rows[0]?.query.legacyProvenance;return metadata?[[id,metadata] as const]:[]}))
}
