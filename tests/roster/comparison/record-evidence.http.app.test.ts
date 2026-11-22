import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import * as schema from '../fixtures/postgres-tables'
import { nativeAppAdapter } from '../../support/native-app'
import { sourceDocument } from '../../../db/postgresql/official-evidence-tables'

const dir = mkdtempSync(join(tmpdir(), 'spztx-record-comparison-http-'))
const app = nativeAppAdapter({ dir, token: 'synthetic-record-comparison' })

async function seed() {
  await app.prepare()
  const db = app.db
  const doc = singlePostgresFixtureRow(await db.insert(sourceDocument).values({ source: 'jxj', title: 'Synthetic', path: 'synthetic/official.pdf' }).returning())
  const enterprise = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: 'HTTP', nameNorm: 'HTTP', usccNorm: '91330211255994475A' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme' }).returning())
  const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning())
  await db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 3 })
  const native = await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T00:00:00Z', status: 'partial', rawResponse: 'PRIVATE_RAW_RESPONSE', relations: [{ sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, status: '待审核', verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { secret: 'PRIVATE_RAW_FIELDS' } }] })
  const query = { id: native.queryId }
  const grouped = await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: 'canonical-fixture', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T00:00:00Z', status: 'partial', rawResponse: 'PRIVATE_GROUP_RAW', relations: [1, 2, 3].map(sequenceNo => ({ sequenceNo, relationKey: sequenceNo === 3 ? 'OTHER' : 'SAME', rawFields: { id: sequenceNo === 3 ? 'OTHER' : 'SAME', privateBody: 'PRIVATE_GROUP_RAW' } })) })
  const groupQuery = { id: grouped.queryId }
  const groupedRelations = grouped.relationIds.map(id => ({ id }))
  return { doc, enterprise, event, query, groupQuery, groupedRelations, sourceQuery: `queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}` }
}
let seeded: Awaited<ReturnType<typeof seed>>
let developmentSpec: any
beforeAll(async () => {
  seeded = await seed()
  developmentSpec = await readDevelopmentDiscovery()
  await app.start()
}, 90000)
afterAll(async () => { try { await app.close() } finally { rmSync(dir, { recursive: true, force: true }) } })

describe('record comparison HTTP adapters on isolated PostgreSQL', () => {
  it('returns source-scoped event rows and global counts with no-store and no raw response', async () => {
    const { event, sourceQuery } = seeded
    const response = await fetch(`${app.url('')}/api/roster/record-comparison?${sourceQuery}&page=1&pageSize=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const text = await response.text()
    expect(text).not.toContain('PRIVATE_RAW_RESPONSE')
    expect(text).not.toContain('PRIVATE_RAW_FIELDS')
    const body = JSON.parse(text)
    expect(body.rows).toMatchObject([{ event: { id: event.id }, classification: 'unresolved' }])
    expect(body.counts).toMatchObject({ distinctEvents: 1, distinctPlatformRows: 1, unresolved: 1 })
    expect(body.businessCounts).toMatchObject({ records: 0, versions: 0, observations: 1, unknownObservations: 1 })
  })
  it('rejects missing explicit source IDs and returns 404 for the retired preview', async () => {
    const { doc, sourceQuery } = seeded
    const preview = await fetch(`${app.url('')}/api/roster/record-comparison/legacy-impact?${sourceQuery}`)
    expect(preview.status).toBe(404)
    expect(developmentSpec.paths['/api/roster/record-comparison/legacy-impact']).toBeUndefined()
    const invalid = await fetch(`${app.url('')}/api/roster/record-comparison?exportBatchIds=&officialSourceDocumentIds=${doc.id}`)
    expect(invalid.status).toBe(400)
  })
  it('discovers the record comparison tool and returns the same data through MCP', async () => {
    const { doc, event, query, groupQuery, sourceQuery } = seeded
    const rpc = async (method: string, params?: Record<string, unknown>) => {
      const response = await fetch(`${app.url('')}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      expect(response.status).toBe(200)
      const raw = await response.text()
      const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) : raw
      return JSON.parse(payload!)
    }
    const listed = await rpc('tools/list', {})
    const tools = listed.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: { properties: Record<string, unknown> } }>
    expect(tools.find(tool => tool.name === 'list_record_comparison')).toMatchObject({ annotations: { readOnlyHint: true } })
    expect(tools.some(tool => tool.name === 'preview_record_correspondence_impact')).toBe(false)
    expect(tools.map(tool => tool.name).filter(name => name.includes('comparison_scope_proof'))).toEqual([])
    expect(tools.find(tool => tool.name === 'list_record_comparison')?.inputSchema.properties).not.toHaveProperty('proofIds')
    expect(tools.find(tool => tool.name === 'list_record_comparison')?.inputSchema.properties).toMatchObject({ businessPage: { type: 'integer' }, businessPageSize: { type: 'integer', maximum: 200 } })
    const called = await rpc('tools/call', { name: 'list_record_comparison', arguments: { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id] } })
    const value = JSON.parse(called.result.content[0].text)
    expect(value.rows).toMatchObject([{ event: { id: event.id }, classification: 'unresolved' }])
    expect(value.counts).toMatchObject({ distinctEvents: 1, distinctPlatformRows: 1 })
    const http = await fetch(`${app.url('')}/api/roster/record-comparison?${sourceQuery}`)
    expect(http.status).toBe(200)
    expect(value).toEqual(await http.json())
    const canonicalArgs = { queryIds: [groupQuery.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id], businessPage: 2, businessPageSize: 1 }
    const canonical = await rpc('tools/call', { name: 'list_record_comparison', arguments: canonicalArgs })
    const canonicalHttp = await fetch(`${app.url('')}/api/roster/record-comparison?queryIds=${groupQuery.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}&businessPage=2&businessPageSize=1`)
    const canonicalValue = JSON.parse(canonical.result.content[0].text)
    expect(canonicalValue).toEqual(await canonicalHttp.json())
    expect(canonicalValue.businessCounts).toMatchObject({ records: 2, versions: 2, observations: 3, unknownObservations: 0 })
    expect(canonicalValue.businessGroups).toMatchObject({ total: 2, page: 2, pageSize: 1, rows: [{ groupState: 'resolved', observationCount: 1 }] })
  })
  it('lists business-labeled source IDs for explicit UI selection without a latest default', async () => {
    const { doc, enterprise, query } = seeded
    const url = `${app.url('')}/api/roster/record-comparison/sources`
    const response = await fetch(`${url}?page=1&pageSize=2`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const body = await response.json()
    expect(body.selection).toBe('explicit')
    expect(body.counts).toMatchObject({ official_document: 1, query: 2, export_batch: 0 })
    expect(body.rows).toMatchObject([{ kind: 'official_document', id: doc.id, label: 'Synthetic' }, {
      kind: 'query',
      id: query.id,
      status: 'partial',
      confirmedEnterprises: [{ enterpriseId: enterprise.id, enterpriseName: 'HTTP', nameRaw: null, aliasConfirmed: false, mergedFromEnterpriseId: null }],
      recordNames: [],
    }])
    const second = await fetch(`${url}?kind=query&page=1&pageSize=1`)
    expect((await second.json()).rows).toMatchObject([{ id: query.id, kind: 'query', selectable: true }])
    expect((await fetch(`${url}?kind=unknown`)).status).toBe(400)
    const selected = await fetch(`${url}?kind=query&ids=${query.id}`)
    expect(await selected.json()).toMatchObject({ total: 1, rows: [{ id: query.id, kind: 'query', status: 'partial' }] })
    expect(await (await fetch(`${url}?kind=query&ids=999999`)).json()).toMatchObject({ total: 0, rows: [] })
    expect((await fetch(`${url}?ids=${query.id}`)).status).toBe(400)
    expect((await fetch(`${url}?kind=query&ids=1x`)).status).toBe(400)
  })
  it('pages canonical business groups independently while retaining every original observation and validates bounds', async () => {
    const { doc, groupQuery, groupedRelations } = seeded
    const url = `${app.url('')}/api/roster/record-comparison?queryIds=${groupQuery.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}`
    const body = await (await fetch(`${url}&businessPageSize=1`)).json()
    expect(body.businessCounts).toMatchObject({ records: 2, versions: 2, observations: 3, unknownObservations: 0 })
    expect(body.counts.distinctPlatformRows).toBe(3)
    expect(body.platformWithoutOfficial.rows.map((o: { relation: { id: number } }) => o.relation.id)).toEqual(groupedRelations.map(r => r.id))
    expect(body.businessGroups).toMatchObject({ total: 2, page: 1, pageSize: 1, rows: [{ groupState: 'resolved', observationCount: 2 }] })
    expect(JSON.stringify(body)).not.toContain('PRIVATE_GROUP_RAW')
    expect((await fetch(`${url}&businessPage=0`)).status).toBe(400)
    expect((await fetch(`${url}&businessPageSize=201`)).status).toBe(400)
    const openapi = developmentSpec
    expect(Object.keys(openapi.paths).filter(path => path.startsWith('/api/roster/comparison-scope-proofs'))).toEqual([])
    expect(openapi.paths['/api/roster/record-comparison'].get.parameters).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'proofIds' })]))
    const retired = await fetch(`${app.url('')}/api/roster/comparison-scope-proofs`)
    expect(retired.status).toBe(404)
    expect(openapi.paths['/api/roster/record-comparison'].get.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'businessPage' }), expect.objectContaining({ name: 'businessPageSize' })]))
  })

})
