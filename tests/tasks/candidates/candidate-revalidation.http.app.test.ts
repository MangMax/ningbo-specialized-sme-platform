import { readDevelopmentDiscovery } from '../../roster/current-export/fixtures/specialized-export'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent } from '../../../db/postgresql/ledger-tables'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { spawnOwnedChild, spawnCompiledApp, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'candidate-570-'))
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let pool: pg.Pool
let db: NodePgDatabase
let owner: typeof enterprise.$inferSelect
let event: typeof recordEvent.$inferSelect
let base: string, child: ReturnType<typeof spawnOwnedChild>, serial = 0
beforeAll(async () => {
  runtime = await postgresRuntimeFixture({ dir })
  pool = new pg.Pool({ connectionString: runtime.url, options: '-c search_path=business,public' })
  db = drizzle<Record<string, never>>({ client: pool })
  const [seededOwner] = await db.insert(enterprise).values({
    name: '候选重核合成企业', nameNorm: '候选重核合成企业', usccNorm: '91330211000000001A',
  }).returning()
  owner = seededOwner!
  const [ledger] = await db.insert(record).values({
    enterpriseId: owner.id, source: 'jxj', titleCode: 'specialized_sme',
  }).returning()
  const [seededEvent] = await db.insert(recordEvent).values({
    recordId: ledger!.id, eventType: 'award', year: 2022,
  }).returning()
  event = seededEvent!
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), ...runtime.env, NUXT_DB_READONLY: '0', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_API_TOKEN: 'synthetic-570', } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { output += data; writeFileSync(join(dir, 'server.log'), output) })
  base = `http://127.0.0.1:${port}`
  await waitForHttp(base + '/api/health', { timeoutMs: 60000, child })
  const contract = await readDevelopmentDiscovery()
  writeFileSync(join(dir, 'openapi.json'), JSON.stringify(contract))
  expect(contract.paths['/api/roster/correspondences/preflight']).toBeDefined()
}, 90000)
afterAll(async () => {
  try {
    if (child) await stopOwnedChild(child)
  } finally {
    try { await pool?.end() }
    finally {
      try { runtime?.close() }
      finally { rmSync(dir, { recursive: true, force: true }) }
    }
  }
})
async function api(path: string, body?: unknown) {
  const response = await fetch(base + '/api/roster/correspondences' + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-570' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
const command = (operations: unknown[]) => ({ idempotencyKey: 'case-' + ++serial, sourceIdentity: 'synthetic-570', actor: { type: 'agent', id: '570-test' }, ruleId: 'manual', ruleVersion: '1', basis: '明确核实当前来源，保留历史', operations })
async function save(request: ReturnType<typeof command>) {
  const plan = await api('/preflight', request)
  expect(plan.status, JSON.stringify(plan.body)).toBe(200)
  const result = await api('/commit', { request, planHash: plan.body.planHash })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return { request, plan: plan.body, receipt: result.body }
}
async function source() {
  const native = await seedPostgresPlatformQuery(db, { interface: 'business_list', titleCode: 'specialized_sme', rdjb: '2', queryKey: owner.usccNorm!, queriedAt: `2026-01-01T00:00:${String(++serial).padStart(2, '0')}Z`, status: 'success', rawResponse: 'Explicit synthetic candidate source', relations: [{ sequenceNo: 1, enterpriseId: owner.id, usccRaw: owner.usccNorm, verificationStatus: 'confirmed', rawFields: { original: '旧原值', number: 7 } }] })
  return { edge: { type: 'event_process', eventId: event.id, relationId: native.relationIds[0]!, role: 'context_only' } }
}
async function changeEventYear() {
  await db.update(recordEvent).set({ year: sql`${recordEvent.year} + 1` })
    .where(eq(recordEvent.id, event.id))
}
it.each(['confirmed', 'rejected'])('revalidates stale candidate then explicitly decides %s preserving both provenance versions', async status => {
  const { edge } = await source()
  const created = await save(command([{ action: 'create', status: 'candidate', edge }]))
  const id = created.receipt.correspondenceIds[0]
  const oldAudit = (await api(`/${id}/audit`)).body.rows
  await changeEventYear()
  expect((await api('/preflight', command([{ action: 'decide', correspondenceId: id, expectedRevision: 1, status }]))).status).toBe(409)
  const refreshed = await save(command([{ action: 'revalidate', correspondenceId: id, expectedRevision: 1 }]))
  expect((await api(`/${id}`)).body).toMatchObject({ status: 'candidate', revision: 2, requiresRevalidation: false })
  const audit = (await api(`/${id}/audit`)).body.rows
  expect(audit).toHaveLength(2)
  expect(audit[0]).toEqual(oldAudit[0])
  expect(audit[1].evidence.event.year).toBe(audit[0].evidence.event.year + 1)
  expect(audit[0].evidence.relation.rawFields).toEqual({ original: '旧原值', number: 7 })
  expect(audit[1]).toMatchObject({ fromStatus: 'candidate', toStatus: 'candidate', expectedRevision: 1, resultingRevision: 2, evidence: { relation: { rawFields: { original: '旧原值', number: 7 } } } })
  expect(await api('/commit', { request: refreshed.request, planHash: refreshed.plan.planHash })).toEqual({ status: 200, body: refreshed.receipt })
  expect((await api(`/${id}/audit`)).body.rows).toHaveLength(2)
  await save(command([{ action: 'decide', correspondenceId: id, expectedRevision: 2, status }]))
  expect((await api(`/${id}`)).body).toMatchObject({ status, revision: 3 })
})
it('rejects changed source after preflight and stale revisions without altering history', async () => {
  const { edge } = await source()
  const id = (await save(command([{ action: 'create', status: 'candidate', edge }]))).receipt.correspondenceIds[0]
  await changeEventYear()
  expect((await api(`/${id}`)).body.requiresRevalidation).toBe(true)
  expect((await api(`?eventId=${event.id}`)).body.rows.find((r: any) => r.id === id).requiresRevalidation).toBe(true)
  const request = command([{ action: 'revalidate', correspondenceId: id, expectedRevision: 1 }])
  const plan = await api('/preflight', request)
  expect(plan.status).toBe(200)
  await changeEventYear()
  expect((await api('/commit', { request, planHash: plan.body.planHash })).status).toBe(409)
  expect((await api(`/${id}/audit`)).body.rows).toHaveLength(1)
  expect((await api('/preflight', command([{ action: 'revalidate', correspondenceId: id, expectedRevision: 2 }]))).body.error.code).toBe('stale_revision')
  const recovered = await save(command([{ action: 'revalidate', correspondenceId: id, expectedRevision: 1 }]))
  expect((await api('/commit', { request, planHash: plan.body.planHash })).body.error.code).toBe('stale_revision')
  expect((await api('/preflight', { ...recovered.request, basis: '同键改载荷' })).body.error.code).toBe('idempotency_conflict')
  expect((await api('/preflight', command([{ action: 'revalidate', correspondenceId: id, expectedRevision: 2 }]))).status).toBe(422)
  expect((await api(`/${id}/audit`)).body.rows).toHaveLength(2)
})
it('keeps confirmed revalidation and rejected reproposal compatible', async () => {
  const { edge } = await source()
  const id = (await save(command([{ action: 'create', status: 'confirmed', edge }]))).receipt.correspondenceIds[0]
  await changeEventYear()
  expect((await api('/preflight', command([{ action: 'revalidate', correspondenceId: id, expectedRevision: 2 }]))).status).toBe(422)
  await save(command([{ action: 'correct', correspondenceId: id, expectedRevision: 2, edge }]))
  expect((await api(`/${id}`)).body).toMatchObject({ status: 'confirmed', revision: 4, requiresRevalidation: false })
  const other = await source()
  const rejected = (await save(command([{ action: 'create', status: 'rejected', edge: other.edge }]))).receipt.correspondenceIds[0]
  await changeEventYear()
  await save(command([{ action: 'create', status: 'candidate', edge: other.edge }]))
  expect((await api(`/${rejected}`)).body).toMatchObject({ status: 'candidate', revision: 3, requiresRevalidation: false })
  expect((await api(`/${rejected}/audit`)).body.rows.map((r: any) => [r.fromStatus, r.toStatus])).toEqual([[null, 'candidate'], ['candidate', 'rejected'], ['rejected', 'candidate']])
})
it('recovers an accepted revalidation after response loss with the identical receipt and one audit', async () => {
  const { createServer } = await import('node:http')
  const { edge } = await source()
  const id = (await save(command([{ action: 'create', status: 'candidate', edge }]))).receipt.correspondenceIds[0]
  await changeEventYear()
  const request = command([{ action: 'revalidate', correspondenceId: id, expectedRevision: 1 }])
  const plan = await api('/preflight', request)
  const body = { request, planHash: plan.body.planHash }
  let accepted: unknown
  const proxy = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const upstream = await api('/commit', JSON.parse(Buffer.concat(chunks).toString()))
    expect(upstream.status).toBe(200); accepted = upstream.body
    res.destroy()
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  try {
    const address = proxy.address() as import('node:net').AddressInfo
    await expect(fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow()
    expect((await api(`/${id}`)).body).toMatchObject({ status: 'candidate', revision: 2 })
    expect((await api('/commit', body)).body).toEqual(accepted)
    expect((await api('/preflight', request)).body.batchStatus).toBe('committed')
    expect((await api(`/${id}/audit`)).body.rows).toHaveLength(2)
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())) }
})
