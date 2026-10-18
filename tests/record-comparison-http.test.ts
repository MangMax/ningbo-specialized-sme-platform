import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useDb, schema } from '../db/client.ts'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'spztx-record-comparison-http-'))
const path = join(dir, 'roster.db')
const db = useDb({ dbPath: path })
const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic', path: 'synthetic/official.pdf' }).returning().get()
const enterprise = db.insert(schema.enterprise).values({ name: 'HTTP', nameNorm: 'HTTP', usccNorm: '91330211255994475A' }).returning().get()
const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 3 }).run()
const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T00:00:00Z', status: 'partial', rawResponse: 'PRIVATE_RAW_RESPONSE' }).returning().get()
db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, status: '待审核', verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { secret: 'PRIVATE_RAW_FIELDS' } }).run()
const reason = db.insert(schema.differenceReason).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2026-10-18T01:00:00Z' }).returning().get()
let service: { baseUrl: string; stop: () => Promise<void> }
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..')
  const port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NUXT_DB_PATH: path, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') },
  })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/roster/record-comparison?queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}`, { timeoutMs: 60000 }) }
  catch (error) { await service.stop(); throw error }
}, 90000)
afterAll(async () => { if (service) await service.stop(); rmSync(dir, { recursive: true, force: true }) })
const sourceQuery = `queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}`

describe('record comparison true HTTP adapters on isolated SQLite', () => {
  it('returns source-scoped event rows and global counts with no-store and no raw response', async () => {
    const response = await fetch(`${service.baseUrl}/api/roster/record-comparison?${sourceQuery}&page=1&pageSize=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const text = await response.text()
    expect(text).not.toContain('PRIVATE_RAW_RESPONSE')
    expect(text).not.toContain('PRIVATE_RAW_FIELDS')
    const body = JSON.parse(text)
    expect(body.rows).toMatchObject([{ event: { id: event.id }, classification: 'unresolved' }])
    expect(body.counts).toMatchObject({ distinctEvents: 1, distinctPlatformRows: 1, unresolved: 1 })
  })
  it('returns readonly legacy originals and rejects missing explicit source IDs', async () => {
    const preview = await fetch(`${service.baseUrl}/api/roster/record-comparison/legacy-impact?${sourceQuery}`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('cache-control')).toContain('no-store')
    const body = await preview.json()
    expect(body.rows).toMatchObject([{ id: reason.id, disposition: 'legacy_pending_review', possibleEventIds: [event.id] }])
    const invalid = await fetch(`${service.baseUrl}/api/roster/record-comparison?exportBatchIds=&officialSourceDocumentIds=${doc.id}`)
    expect(invalid.status).toBe(400)
  })
  it('discovers both read-only MCP tools and returns the same comparison data through MCP', async () => {
    const rpc = async (method: string, params?: Record<string, unknown>) => {
      const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      expect(response.status).toBe(200)
      const raw = await response.text()
      const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) : raw
      return JSON.parse(payload!)
    }
    const listed = await rpc('tools/list', {})
    const tools = listed.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>
    expect(tools.find(tool => tool.name === 'list_record_comparison')).toMatchObject({ annotations: { readOnlyHint: true } })
    expect(tools.find(tool => tool.name === 'preview_record_correspondence_impact')).toMatchObject({ annotations: { readOnlyHint: true } })
    const called = await rpc('tools/call', { name: 'list_record_comparison', arguments: { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id] } })
    const value = JSON.parse(called.result.content[0].text)
    expect(value.rows).toMatchObject([{ event: { id: event.id }, classification: 'unresolved' }])
    expect(value.counts).toMatchObject({ distinctEvents: 1, distinctPlatformRows: 1 })
  })
  it('lists business-labeled source IDs for explicit UI selection without a latest default', async () => {
    const url = `${service.baseUrl}/api/roster/record-comparison/sources`
    const response = await fetch(`${url}?page=1&pageSize=2`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const body = await response.json()
    expect(body.selection).toBe('explicit')
    expect(body.counts).toMatchObject({ official_document: 1, query: 1, export_batch: 0 })
    expect(body.rows).toMatchObject([{ kind: 'official_document', id: doc.id, label: 'Synthetic' }, { kind: 'query', id: query.id, status: 'partial' }])
    const second = await fetch(`${url}?kind=query&page=1&pageSize=1`)
    expect((await second.json()).rows).toMatchObject([{ id: query.id, kind: 'query', selectable: true }])
    expect((await fetch(`${url}?kind=unknown`)).status).toBe(400)
  })
})
