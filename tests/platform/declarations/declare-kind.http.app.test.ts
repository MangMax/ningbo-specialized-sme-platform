import { readDevelopmentDiscovery } from '../../roster/current-export/fixtures/specialized-export'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createRosterImportClient, type RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { nativeAppAdapter } from '../../support/native-app'

// Every business write uses the app API on isolated PostgreSQL.
const dir = mkdtempSync(join(tmpdir(), 'declare-kind-249-'))
const token = 'synthetic-declare-kind-249'
const app = nativeAppAdapter({ dir, token })
let pool: pg.Pool | undefined
let baseUrl: string
let client: ReturnType<typeof createRosterImportClient>
beforeAll(async () => {
  await app.start()
  baseUrl = app.url('')
  pool = new pg.Pool({ connectionString: app.postgresUrl!, options: '-c search_path=business,public -c default_transaction_read_only=on' })
  const contract = await readDevelopmentDiscovery()
  expect(contract.paths['/api/roster/import/preflight'].post).toBeDefined()
  expect(contract.paths['/api/roster/import/commit'].post).toBeDefined()
  expect(contract.paths['/api/platform/queries'].get).toBeDefined()
  expect(contract.paths['/api/platform/queries/{queryId}/evidence']).toBeUndefined()
  expect(JSON.stringify(contract.paths['/api/platform/queries'].get)).not.toContain('includeRawResponse')
  client = createRosterImportClient({ baseUrl: baseUrl, token })
}, 90000)
afterAll(async () => {
  await pool?.end()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

function input(label: string, source: 'apply_list' | 'business_list', relations: NonNullable<NonNullable<RosterImportRequest['payload']['platformQueries']>[number]['relations']>): RosterImportRequest {
  return { idempotencyKey: `249:${label}`, sourceKind: 'alias_evidence', sourceIdentity: `synthetic:249:${label}`, payload: { platformQueries: [{ interface: source, queryKey: `synthetic:249:${label}`, queriedAt: '2026-10-23T00:00:00.000Z', status: 'success', rawResponse: '原始响应 🙂\n', relations }] } }
}
async function read(label: string) {
  const response = await fetch(`${baseUrl}/api/platform/queries?queryKey=${encodeURIComponent(`synthetic:249:${label}`)}`)
  expect(response.status).toBe(200)
  return response.json()
}
async function api(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(baseUrl + path, { method: body ? method : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  expect(response.status).toBe(200)
  return response.json()
}

it.each(['apply_list', 'business_list'] as const)('equivalent declare kinds remain stable on HTTP readback and import replay: %s', async (source) => {
  const pairs = [['申请', 'apply'], ['更新', 'update'], ['复核', 'review']] as const
  const relations = pairs.flatMap(([chinese, english], i) => [
    { sequenceNo: i * 2 + 1, declareKind: chinese, rawFields: { sblx: english, cszt: '终审通过', sourceOnly: { note: '留证 🙂\n' } } },
    { sequenceNo: i * 2 + 2, declareKind: english, rawFields: { sblx: chinese, cszt: '终审通过', sourceOnly: { note: '留证 🙂\n' } } },
  ])
  const request = input(source, source, relations)
  expect((await client.preflight(request)).preflight.conflicts).toEqual([])
  expect((await client.commit(request)).status).toBe('committed')
  const page = await read(source)
  const archived = page.rows[0]
  expect(archived.query).not.toHaveProperty('rawResponse')
  expect(JSON.stringify(archived)).not.toContain('留证')
  expect(archived.relations).toHaveLength(6)
  for (const [i, row] of archived.relations.entries()) {
    expect(row).toMatchObject({ declareKind: pairs[Math.floor(i / 2)]![1], normalizationConflicts: [] })
  }
  expect((await client.commit(request)).status).toBe('committed')
  expect(await read(source)).toEqual(page)
}, 20_000)

it('unknown and prototype-named declare kinds survive extracted HTTP readback', async () => {
  const values = ['新事项', '__proto__', 'constructor', 'toString', 'APPLY']
  const relations = values.map((value, i) => ({ sequenceNo: i + 1, declareKind: value, rawFields: { sblx: value } }))
  const request = input('unknown', 'business_list', relations)
  expect((await client.preflight(request)).preflight.conflicts).toEqual([])
  expect((await client.commit(request)).status).toBe('committed')
  const archived = (await read('unknown')).rows[0]
  expect(archived.relations).toHaveLength(values.length)
  for (const [i, row] of archived.relations.entries()) {
    expect(row).toMatchObject({ declareKind: values[i], normalizationConflicts: [] })
  }
})

it('real nonempty type and status conflicts still reject HTTP archives atomically', async () => {
  for (const [label, stored, raw, status] of [
    ['different-known', '申请', 'update', '终审通过'],
    ['different-unknown', 'constructor', '申请', '终审通过'],
    ['different-status', '申请', 'apply', '已退回'],
  ]) {
    const request = input(label!, 'apply_list', [{ sequenceNo: 1, declareKind: stored, status, rawFields: { sblx: raw, cszt: '终审通过' } }])
    expect((await client.preflight(request)).preflight.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'platform_field_conflict' }) })]))
    expect((await client.commit(request)).status).toBe('failed')
    expect((await read(label!)).total).toBe(0)
  }
})

it('identical full raw reuses a content version across stored synonyms while changed raw stays distinct', async () => {
  const raw = { id: 'synthetic-249-content', sblx: '申请', sourceOnly: '完整原始内容' }
  const requests = [
    input('content-first', 'apply_list', [{ sequenceNo: 1, relationKey: raw.id, declareKind: 'apply', rawFields: raw }]),
    input('content-second', 'apply_list', [{ sequenceNo: 1, relationKey: raw.id, declareKind: '申请', rawFields: raw }]),
    input('content-changed', 'apply_list', [{ sequenceNo: 1, relationKey: raw.id, declareKind: '申请', rawFields: { ...raw, sblx: 'apply' } }]),
  ]
  for (const [index, request] of requests.entries()) {
    request.sourceKind = 'platform_archive'
    expect((await client.preflight(request)).preflight.conflicts).toEqual([])
    expect((await client.commit(request)).status).toBe('committed')
    if (index === 1) {
      const [versionCount] = (await pool!.query<{ count: string }>(
        'SELECT count(*) FROM platform_business_record_version v JOIN platform_business_record r ON r.id = v.record_id WHERE r.platform_key = $1', [raw.id],
      )).rows
      expect(Number(versionCount!.count)).toBe(1)
    }
  }
  const versions = async () => (await pool!.query<{ record_id: string; version_id: string }>(
    'SELECT o.record_id, o.version_id FROM platform_business_observation o JOIN platform_business_record r ON r.id = o.record_id WHERE r.platform_key = $1 ORDER BY o.id', [raw.id],
  )).rows
  const before = await versions()
  expect(before).toHaveLength(2)
  expect(Number(before[0]!.version_id)).toBeGreaterThan(0)
  expect(before[1]!.record_id).toBe(before[0]!.record_id)
  expect(before[1]!.version_id).not.toBe(before[0]!.version_id)
  for (const label of ['content-first', 'content-second']) expect((await read(label)).rows[0].relations).toEqual([])
  expect((await read('content-changed')).rows[0].relations).toEqual([expect.objectContaining({ declareKind: 'apply', normalizationConflicts: [] })])
  expect(await versions()).toEqual(before)
})
