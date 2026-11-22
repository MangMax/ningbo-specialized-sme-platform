import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, expect, it } from 'vitest'
import * as schema from '../fixtures/postgres-tables'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'annual250-mcp-http-'))
async function seed(pool: pg.Pool) {
  const db = drizzle(pool)
  const enterprise = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: '合成年度只读接口', nameNorm: '合成年度只读接口', usccNorm: '91330211255994457P' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning())
  const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning())
  for (const n of [1, 2]) {
    await seedPostgresPlatformQuery(db,{interface:'business_list',queryKey:enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:`2026-10-0${n}T00:00:00Z`,status:'success',rawResponse:'PRIVATE-RESPONSE',relations:[{sequenceNo:1,relationKey:`SQ-${n}`,enterpriseId:enterprise.id,usccRaw:enterprise.usccNorm,verificationStatus:'confirmed',matchBasis:'uscc',rawFields:{id:`SQ-${n}`,year:2024,sblx:'申请',sqsj:n===1?'2024-03-01 09:00:00':'2024-12-13 10:00:00',cszt:n===1?'终审不通过':'终审通过',cookie:'PRIVATE-COOKIE'}}]})
  }
  return event
}
let event: Awaited<ReturnType<typeof seed>>
let service: { baseUrl: string; stop: () => Promise<void> }
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let pool: pg.Pool
let developmentSpec: any
beforeAll(async () => {
  developmentSpec = await readDevelopmentDiscovery()
  postgres = await postgresRuntimeFixture({ dir })
  pool = new pg.Pool({ connectionString: postgres.url, options: '-c search_path=business,public' })
  event = await seed(pool)
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...postgres.env, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_MCP_TOKEN: 'isolated250' } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/api/health`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${String(error)}\n${output}`) }
}, 90000)
afterAll(async () => {
  try { await service?.stop() } finally {
    try { await pool?.end(); postgres?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})
async function rpc(method: string, params: unknown) {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer isolated250', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  return JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
}
it('real GET and MCP return the same full-scope qualification with off-page summary on a read-only database', async () => {
  const response = await fetch(`${service.baseUrl}/api/roster/events/${event.id}/annual-process?pageSize=1`)
  expect(response.status).toBe(200)
  const body = await response.json()
  const wire = await rpc('tools/call', { name: 'get_event_annual_process', arguments: { eventId: event.id, pageSize: 1 } })
  expect(wire.error).toBeUndefined(); expect(wire.result.isError).not.toBe(true)
  expect(wire.result.structuredContent).toEqual(body)
  expect(JSON.parse(wire.result.content[0].text)).toEqual(body)
  expect(body).toMatchObject({ total: 2, page: 1, pageSize: 1, process: { latestStepSummary: { appliedAt: '2024-12-13 10:00:00', status: '终审通过' } } })
  expect(body.process.finalCandidateStepId).toBe(body.process.latestStepSummary.id)
  expect(body.process.steps[0].id).not.toBe(body.process.latestStepSummary.id)
  expect(JSON.stringify(body)).not.toContain('PRIVATE')
  expect((await pool.query('SELECT id FROM business.record_correspondence')).rows).toEqual([])
  expect((await pool.query('SELECT id FROM business.record_correspondence_audit')).rows).toEqual([])
})
it('publishes read-only REST and MCP schema with annual facts generation and bounded pagination', async () => {
  const spec = developmentSpec
  const operation = spec.paths['/api/roster/events/{id}/annual-process'].get
  expect(operation.parameters.find((p: any) => p.name === 'pageSize').schema.maximum).toBe(200)
  expect(operation.parameters.map((p: any) => p.name)).toEqual(['id', 'page', 'pageSize'])
  expect(operation.responses['200'].content['application/json'].schema.properties.process.properties.finalCandidateStepId.description).toContain('纯事实')
  const tool = (await rpc('tools/list', {})).result.tools.find((t: any) => t.name === 'get_event_annual_process')
  expect(tool.annotations.readOnlyHint).toBe(true)
  expect(tool.inputSchema.properties).not.toHaveProperty('asOf')
  expect(tool.inputSchema.properties).not.toHaveProperty('sourceSet')
  expect(tool.outputSchema.properties.process.properties.latestStepSummary).toBeDefined()
  expect(tool.outputSchema.properties.process.properties.finalQualification.properties.status.enum).toEqual(['confirmed', 'eligible', 'blocked', 'none'])
})
it('real handlers reject unsupported scope parameters and preserve MCP error envelopes', async () => {
  const invalid = await fetch(`${service.baseUrl}/api/roster/events/${event.id}/annual-process?asOf=2026`)
  expect(invalid.status).toBe(400)
  const wire = await rpc('tools/call', { name: 'get_event_annual_process', arguments: { eventId: 999999 } })
  expect(wire.result.isError).toBe(true)
  expect(JSON.parse(wire.result.content[0].text)).toMatchObject({ error: { code: 'not_found' } })
})
