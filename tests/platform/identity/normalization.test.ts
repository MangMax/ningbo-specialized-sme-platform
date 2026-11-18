import {submitNativePlatformQuery} from '../fixtures/native-query'
import {normalizePlatformRelation} from '../../../layers/sme-roster/lib/platform/normalization'
import { initializeDb } from '../../../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema, useDb } from '../../../db'
import { listPlatformQueries } from '../../../layers/sme-roster/lib/platform/read'
import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import { relationSource } from '../../../layers/sme-roster/server/utils/record-correspondence-read'
import { generateCandidates } from '../../../layers/sme-roster/server/utils/record-correspondence-candidates'
import { createRosterImportClient, type RosterImportRequest } from '../../../lib/roster-import-client'
import { readPlatformQueryEvidence } from '../../../layers/sme-roster/lib/platform/evidence-read'
import { executeNativeImport, startRosterApi } from '../../roster/imports/fixtures/import-server'
import { startHttpFixture, type HttpFixture } from '../../support/http'

const dir = mkdtempSync(join(tmpdir(), 'platform-normalization-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') })
const uscc = '91330211000000001A'
const enterpriseId = db.insert(schema.enterprise).values({ name: '归一化测试企业', nameNorm: '归一化测试企业', usccNorm: uscc }).returning().get().id
const rawFields = { cszt: '终审通过', sblx: '复核', sqsj: '2025-11-21 09:54:16', year: '2025', whpc: '2025-2' }
const seeded = submitNativePlatformQuery(db,{interface:'business_list',queryKey:uscc,rdjb:'1',queriedAt:'2026-10-18T10:10:07.888Z',status:'success',rawResponse:'原始响应 🙂\n',relations:[{sequenceNo:1,enterpriseId,usccRaw:uscc,rawFields}]})
const queryId=seeded.queryId,relationId=seeded.relationIds[0]!
let server: HttpFixture
let writes: HttpFixture
beforeAll(async () => {
  server = await startHttpFixture({ getRoutes: {
    '/api/platform/queries': request => ({ status: 200, body: listPlatformQueries(db, { queryId: Number(request.query.queryId), includeRawResponse: true }) }),
  } })
  writes = await startRosterApi({ db, apiToken: 'synthetic-normalization-token', executeImport: executeNativeImport })
})
afterAll(async () => { await server?.close(); await writes?.close(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

function request(key: string): RosterImportRequest {
  return { idempotencyKey: `normalization:${key}`, sourceKind: 'alias_evidence', sourceIdentity: `synthetic:${key}`, payload: { platformQueries: [{ interface: 'apply_list', queryKey: `synthetic:${key}`, queriedAt: '2026-10-23T00:00:00.000Z', status: 'success', rawResponse: '原始响应 🙂\n', relations: [{ sequenceNo: 1, rawFields }] }] } }
}
function storedRelation(queryId: number, relationId: number) {
  const chunk = readPlatformQueryEvidence(db, { queryId, relationId, field: 'relation' })
  if (!('data' in chunk)) throw new Error('Expected an exact relation evidence chunk')
  return JSON.parse(Buffer.from(chunk.data, 'base64').toString())
}

it('native raw-only process facts agree across HTTP, enterprise, source and candidate reads', async () => {
  const response = await fetch(`${server.baseUrl}/api/platform/queries?queryId=${queryId}`)
  expect(response.status).toBe(200)
  const result = await response.json()
  const expected = { id: relationId, status: '终审通过', declareKind: 'review', appliedAt: '2025-11-21 09:54:16', year: 2025, batch: '2025-2', rawFields }
  expect(result.rows[0].relations[0]).toMatchObject(expected)
  expect(result.rows[0].query).toMatchObject({ status: 'success', rawResponse: '原始响应 🙂\n' })
  expect(getRosterEnterpriseDetail(db, enterpriseId)!.platform.relations[0]).toMatchObject(expected)
  expect(relationSource(db, relationId)).toMatchObject(expected)
  const candidates = generateCandidates(db, { enterpriseId, titleCode: 'innovative_sme', queryIds: [queryId], exportBatchIds: [], ruleVersion: 'test', page: 1, pageSize: 25 })!
  expect(candidates.rows).toHaveLength(1)
  expect(candidates.rows[0]).toMatchObject({ status: 'candidate', edge: { relationId, role: 'followup_review' }, evidence: { temporal: { relationYear: 2025, relationBatch: '2025-2' }, process: { declareKind: 'review', appliedAt: '2025-11-21 09:54:16', status: '终审通过' } } })
  expect(candidates.rows[0]!.conflicts).not.toContain('process_type_unknown')
  // Evidence reads retain the captured source facts and raw values.
  expect(storedRelation(queryId, relationId)).toMatchObject({ ...expected, rawFields })
})

it('new archives preserve matching explicit facts and reject contradictory nonempty facts atomically', async () => {
  const client = createRosterImportClient({ baseUrl: writes.baseUrl, token: 'synthetic-normalization-token' })
  const matching = request('matching')
  Object.assign(matching.payload.platformQueries![0]!.relations![0]!, { status: '终审通过', declareKind: 'review', appliedAt: '2025-11-21 09:54:16', year: 2025, batch: '2025-2', province: '人工已核实省市' })
  expect((await client.commit(matching)).status).toBe('committed')
  expect(listPlatformQueries(db, { queryKey: 'synthetic:matching' }).rows[0]!.relations[0]).toMatchObject({ status: '终审通过', province: '人工已核实省市', normalizationConflicts: [] })
  const conflict = request('conflict')
  Object.assign(conflict.payload.platformQueries![0]!.relations![0]!, { status: '已退回', declareKind: 'apply', appliedAt: '2024-01-01', year: 2024, batch: '2024-1' })
  expect((await client.preflight(conflict)).preflight.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'platform_field_conflict' }) })]))
  expect((await client.commit(conflict)).status).toBe('failed')
  expect(listPlatformQueries(db, { queryKey: 'synthetic:conflict' }).total).toBe(0)
})

it('new raw-only archives persist process facts through preflight and idempotent HTTP commit', async () => {
  const client = createRosterImportClient({ baseUrl: writes.baseUrl, token: 'synthetic-normalization-token' })
  const input = request('new-raw-only')
  expect((await client.preflight(input)).preflight.conflicts).toEqual([])
  const committed = await client.commit(input)
  expect(committed.status).toBe('committed')
  const row = listPlatformQueries(db, { queryKey: 'synthetic:new-raw-only', includeRawResponse: true }).rows[0]!
  const archived = storedRelation(row.query.id, row.relations[0]!.id)
  expect(archived).toMatchObject({ status: '终审通过', declareKind: 'review', appliedAt: '2025-11-21 09:54:16', year: 2025, batch: '2025-2', rawFields })
  expect(row.query.rawResponse).toBe('原始响应 🙂\n')
  expect((await client.commit(input)).status).toBe('committed')
  expect(listPlatformQueries(db, { queryKey: 'synthetic:new-raw-only' }).rows[0]!.relations.map(r => r.id)).toEqual([archived.id])
})

it.each([
  { case: 'absent', raw: {}, expected: { status: null, declareKind: null, appliedAt: null, year: null } },
  { case: 'blank', raw: { cszt: '  ', sblx: '', sqsj: '\t', year: '' }, expected: { status: null, declareKind: null, appliedAt: null, year: null } },
  { case: 'explicit-null', raw: { cszt: null, sblx: null, sqsj: null, year: null }, expected: { status: null, declareKind: null, appliedAt: null, year: null } },
  { case: 'unknown-enum', raw: { cszt: '未知', sblx: '新事项', sqsj: '2025-11-21 09:54:16', year: true }, expected: { status: '未知', declareKind: '新事项', appliedAt: '2025-11-21 09:54:16', year: null } },
  { case: 'unknown-prototype-name', raw: { sblx: 'constructor' }, expected: { status: null, declareKind: 'constructor', appliedAt: null, year: null } },
])('archives retain raw distinctions and never infer a year: $case', async ({ case: name, raw, expected }) => {
  const client = createRosterImportClient({ baseUrl: writes.baseUrl, token: 'synthetic-normalization-token' })
  const input = request(name)
  input.payload.platformQueries![0]!.relations![0]!.rawFields = raw
  expect((await client.commit(input)).status).toBe('committed')
  const row = listPlatformQueries(db, { queryKey: `synthetic:${name}` }).rows[0]!.relations[0]!
  expect(row).toMatchObject({ ...expected, rawFields: raw })
  expect(storedRelation(row.queryId, row.id).rawFields).toEqual(raw)
  if (name === 'unknown-enum') expect(row.verificationStatus).toBe('pending')
})

it('recognized parsing does not borrow process status, matter, time or year from similar keys', () => {
  const raw = { ...rawFields, sfyx: '1', rddqrq: '2029-02-27' }
  expect(normalizePlatformRelation('recognized_list',{sequenceNo:1,rawFields:raw})).toMatchObject({status:null,declareKind:null,appliedAt:null,year:null,batch:null,rawFields:raw})
})

it('candidate projection preserves unknown enum and JSON boolean year without positive inference', () => {
  const id=submitNativePlatformQuery(db,{interface:'business_list',queryKey:'synthetic:unknown-candidate',rdjb:'1',queriedAt:'2026-10-23',status:'success',rawResponse:'Explicit original',relations:[{sequenceNo:1,enterpriseId,usccRaw:uscc,rawFields:{sblx:'constructor',cszt:'未知',year:true,sqsj:'2025-11-21 09:54:16'}}]}).queryId
  const result = generateCandidates(db, { enterpriseId, titleCode: 'innovative_sme', queryIds: [id], exportBatchIds: [], ruleVersion: 'test', page: 1, pageSize: 25 })!
  expect(result.rows[0]).toMatchObject({ status: 'candidate', evidence: { process: { declareKind: 'constructor', status: '未知', appliedAt: '2025-11-21 09:54:16' }, temporal: { relationYear: null } } })
  expect(result.rows[0]!.conflicts).toEqual(expect.arrayContaining(['process_type_unknown', 'platform_year_missing']))
})
