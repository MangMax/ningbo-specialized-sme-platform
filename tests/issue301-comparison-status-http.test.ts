import { assertEnterpriseDetailSnapshotEqual } from './helpers/enterprise-detail-snapshot'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { initializeDb } from '../db/client'
import { seedIssue301 } from './helpers/issue301-fixture'
import { spawnOwnedChild, reserveLoopbackPort, waitForHttp, stopOwnedChild } from './helpers/isolated-local-services.mjs'

// A caller-owned service lets manual RED -> GREEN and browser acceptance share
// one dev compilation. Normal test runs still own and clean up their service.
const external = process.env.ISSUE301_BASE_URL
const dir = external ? process.env.ISSUE301_DIR! : mkdtempSync(join(tmpdir(), 'issue301-http-'))
const dbPath = join(dir, 'fixture.db')
const db = external ? useDb({ dbPath }) : initializeDb({ dbPath, create: true })
const fixture = external ? JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as ReturnType<typeof seedIssue301> : seedIssue301(db)
let base = external ?? ''
let stop: (() => Promise<void>) | undefined
let full: Awaited<ReturnType<typeof rest>>
let detail: Awaited<ReturnType<typeof rest>>
const persisted = () => ({
  queries: db.select().from(schema.platformCollection).all(),
  relations: db.select().from(schema.platformBusinessObservation).all(),
  archives: db.select().from(schema.platformArchiveValue).all(),
  assignments: db.select().from(schema.platformObservationAssignment).all(),
  decisions: db.select().from(schema.differenceReason).all(),
  correspondences: db.select().from(schema.recordCorrespondence).all(),
  audit: db.select().from(schema.recordCorrespondenceAudit).all(),
})
const before = persisted()
beforeAll(async () => {
  if (external) { await waitForHttp(`${base}/_openapi.json`); return }
  const cwd = resolve(import.meta.dirname, '..')
  let port = await reserveLoopbackPort()
  while ([3480, 3516].includes(port)) port = await reserveLoopbackPort()
  const child = spawnOwnedChild(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: join(dir, 'fixture.db'), NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_LOG_DIR: join(dir, 'logs'), NUXT_CURATED_PATH: join(dir, 'curated.json'), NUXT_RECONCILE_PATH: join(dir, 'reconcile.json'), NUXT_MCP_TOKEN: 'issue301-synthetic' } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000) })
  base = `http://127.0.0.1:${port}`
  stop = () => stopOwnedChild(child)
  try { await waitForHttp(`${base}/_openapi.json`, { child }) }
  catch (error) { throw new Error(`${String(error)}\n${output}`) }
}, 90000)
beforeAll(async () => {
  full = await rest(`/api/comparison?view=full&enterpriseId=${fixture.enterprise.id}`)
  expect(await rest(`/api/comparison?enterpriseId=${fixture.enterprise.id}`)).toEqual(full)
  detail = await rest(`/api/roster/enterprises/${fixture.enterprise.id}`)
  assertEnterpriseDetailSnapshotEqual(await mcp('get_enterprise_detail', { enterpriseId: fixture.enterprise.id }), detail)
}, 30000)
afterAll(async () => {
  try { expect(persisted()).toEqual(before) }
  finally { await stop?.(); db.$client.close(); if (!external) rmSync(dir, { recursive: true, force: true }) }
})
async function rest(path: string) {
  const response = await fetch(base + path)
  expect(response.status).toBe(200)
  return response.json()
}
async function mcp(name: string, args: unknown) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer issue301-synthetic', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(payload.error).toBeUndefined()
  expect(payload.result.isError).not.toBe(true)
  return JSON.parse(payload.result.content[0].text)
}

it.each(fixture.cases)('native full matches enterprise and HTTP/MCP archive facts without guessing: $label', async ({ query, relation, expected, label }) => {
  const actual = full.rows[0].platform.queries.find((q: { id: number }) => q.id === query.id).relations[0]
  const archive = await rest(`/api/platform/queries?queryId=${query.id}`)
  const remoteArchive = await mcp('list_platform_queries', { queryId: query.id })
  expect(remoteArchive).toEqual(archive)
  const conflicts = label === 'status-conflict' ? [{ field: 'status', storedValue: '已退回', rawValue: '终审通过' }] : []
  const facts = { status: expected, normalizationConflicts: conflicts, declareKind: query.interface === 'recognized_list' ? null : 'apply', appliedAt: query.interface === 'recognized_list' ? null : '2025-01-02', year: query.interface === 'recognized_list' ? null : 2025 }
  for (const row of [actual, detail.platform.relations.find((r: { id: number }) => r.id === relation.id), archive.rows[0].relations[0]]) expect(row).toMatchObject({ id: relation.id, queryId: query.id, rawFields: relation.rawFields, ...facts })
  expect(full.rows[0].platform.disposition).toMatchObject({ explanationId: fixture.decision.id, status: fixture.decision.status, evidenceRelationId: fixture.decision.evidenceRelationId })
})

it('exact HTTP/MCP chunks preserve response bytes and stored relation values after derived reads', async () => {
  for (const { query, relation } of fixture.cases) {
    for (const field of ['rawResponse', 'relation'] as const) {
      const chunks: Buffer[] = []
      let offset = 0
      for (;;) {
        const input = { queryId: query.id, field, ...(field === 'relation' ? { relationId: relation.id } : {}), offset, length: 97 }
        const part = await rest(`/api/platform/queries/${query.id}/evidence?${new URLSearchParams(Object.entries(input).filter(([key]) => key !== 'queryId').map(([k, v]) => [k, String(v)]))}`)
        expect(await mcp('get_platform_query_evidence', input)).toEqual(part)
        const bytes = Buffer.from(part.data, 'base64'); chunks.push(bytes); offset += bytes.length
        if (!part.hasMore) { expect(offset).toBe(part.totalBytes); break }
      }
      const bytes = Buffer.concat(chunks)
      if (field === 'rawResponse') expect(bytes).toEqual(Buffer.from(fixture.rawResponse))
      else expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ id: relation.id, queryId: query.id, sequenceNo: relation.sequenceNo, rawFields: relation.rawFields, sourceText: relation.sourceText })
    }
  }
  expect(persisted()).toEqual(before)
})

it('rejects a conflicting stored and original process status before publishing any native collection', async () => {
  const { submitNativePlatformQuery } = await import('./helpers/native-platform-fixture')
  const count = db.select().from(schema.platformCollection).all().length
  expect(() => submitNativePlatformQuery(db, {
    interface: 'business_list', queryKey: fixture.enterprise.usccNorm!, rdjb: '2', queriedAt: '2026-10-30T00:00:00Z', status: 'success', rawResponse: 'Explicit synthetic conflicting source',
    relations: [{ sequenceNo: 1, enterpriseId: fixture.enterprise.id, status: '已退回', rawFields: { cszt: '终审通过' } }],
  })).toThrow('platform_field_conflict')
  expect(db.select().from(schema.platformCollection).all()).toHaveLength(count)
})
