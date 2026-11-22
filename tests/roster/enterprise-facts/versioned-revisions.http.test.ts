import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise, enterpriseAlias } from '../../../db/postgresql/enterprise-tables'
import { differenceReason } from '../../../db/postgresql/roster-selection-tables'
import { readPostgresCurrentDetailBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import pg from 'pg'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { createApp, createRouter, toNodeListener } from 'h3'
const dir = mkdtempSync(join(tmpdir(), 'facts-306-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let db: ReturnType<typeof usePostgresDirectoryDb>
const fixtureAsOf = Date.parse('2026-11-04T00:00:00Z')
async function readAssessment(id: number, title = 'specialized_sme', asOf = fixtureAsOf) {
 return db.transaction(async tx =>
  (await readPostgresCurrentDetailBatch(tx, [id], 'specialized_sme', asOf)).get(id)!.snapshot.titles.find(row => row.titleCode === title)!,
  { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
let server: Server, base: string, seq = 0
let mcp: Record<string, any>
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'facts-token' }))
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
  mcp = {}
  for (const name of ['get_enterprise_facts', 'preflight_enterprise_fact', 'commit_enterprise_fact']) mcp[name] = (await import(`../../../layers/sme-roster/server/mcp/tools/${name}.ts`)).default
  const get = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/facts.get')).default
  const preflight = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/facts/preflight.post')).default
  const commit = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/facts/commit.post')).default
  const detail = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id].get')).default
  server = createServer(toNodeListener(createApp().use(createRouter().get('/:id/detail', detail).get('/:id', get).post('/:id/preflight', preflight).post('/:id/commit', commit))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 60_000)
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await closePostgresDirectoryDb()
  postgres?.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.doUnmock('@nuxtjs/mcp-toolkit/server')
})
async function http(id: number, action = '', body?: unknown, auth = true) {
  const response = await fetch(`${base}/${id}${action}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer facts-token' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
async function seed() {
 const name = `事实合成${++seq}`
 const [saved] = await db.insert(enterprise).values({ name, nameNorm: name }).returning()
 const id = saved!.id
 await db.insert(differenceReason).values({ enterpriseId: id, titleCode: 'specialized_sme', direction: 'extra_in_miit',
  status: 'confirmed_reason', reasonCode: 'moved_in', movedInYear: 2020, verificationStatus: 'confirmed',
  recordedAt: '2026-01-01', createdAt: '2026-01-01' })
 return id
}
const fact = { kind: 'moved_out', source: { reference: 'official:notice:17', statement: '迁出，目的地未载明' }, observed: { value: '2026-11-04', precision: 'day' }, effective: { value: '2024', precision: 'year' }, city: null }
async function command(id: number, changes: object) {
  const read = await http(id)
  return { expectedVersion: read.body.version, idempotencyKey: `facts-${++seq}`, actor: { type: 'agent', id: 'test' }, basis: '正式通知核对', ...changes }
}
async function commit(id: number, request: any) {
  const preview = await http(id, '/preflight', request)
  expect(preview.status).toBe(200)
  return http(id, '/commit', { request, planHash: preview.body.planHash })
}
it('HTTP and MCP preserve sourced facts through confirmation replacement withdrawal and replay', async () => {
  const id = await seed()
  expect((await http(id)).body.facts).toEqual([]) // legacy moved_in is not promoted
  const input = await command(id, { action: 'assert', fact })
  const first = await commit(id, input)
  expect(first.status).toBe(200)
  const factId = first.body.factId
  expect((await http(id)).body.facts).toMatchObject([{ factId, status: 'pending', fact }])
  const confirm = await command(id, { action: 'confirm', factId })
  const plan = await mcp.preflight_enterprise_fact.handler({ enterpriseId: id, request: confirm })
  await mcp.commit_enterprise_fact.handler({ enterpriseId: id, request: { request: confirm, planHash: plan.planHash } })
  const replace = await command(id, { action: 'replace', factId, fact: { ...fact, kind: 'cancelled' } })
  await commit(id, replace)
  let read = await mcp.get_enterprise_facts.handler({ enterpriseId: id })
  expect(read.facts).toMatchObject([{ status: 'replaced' }, { status: 'pending', fact: { kind: 'cancelled' } }])
  const replacement = read.facts[1].factId
  await commit(id, await command(id, { action: 'withdraw', factId: replacement }))
  expect((await http(id)).body.facts).toMatchObject([{ status: 'replaced' }, { status: 'withdrawn' }])
  const replayPlan = await http(id, '/preflight', input)
  expect(await http(id, '/commit', { request: input, planHash: replayPlan.body.planHash })).toEqual(first)
  read = (await http(id)).body
  expect(read.history.map((r: any) => r.action)).toEqual(['assert', 'confirm', 'replace', 'replace', 'withdraw'])
  expect(read.history[0]).toMatchObject({ actor: input.actor, basis: input.basis })
})
it('preflight binding CAS auth and illegal transitions leave the same readback', async () => {
  const id = await seed(), input = await command(id, { action: 'assert', fact })
  const before = (await http(id)).body
  const plan = (await http(id, '/preflight', input)).body
  expect((await http(id, '/commit', { request: input, planHash: plan.planHash }, false)).status).toBe(401)
  expect((await http(id, '/commit', { request: { ...input, basis: 'changed' }, planHash: plan.planHash })).status).toBe(409)
  expect((await http(id)).body).toEqual(before)
  await commit(id, input)
  expect((await http(id, '/preflight', { ...input, idempotencyKey: 'stale' })).status).toBe(409)
  const current = (await http(id)).body
  expect((await http(id, '/preflight', await command(id, { action: 'withdraw', factId: 999999 }))).status).toBe(409)
  expect((await http(id)).body).toEqual(current)
})
it('same-input shadow retains legacy IDs heads aliases and moved-in columns; failed audit append rolls back', async () => {
  const id = await seed()
  await db.insert(enterpriseAlias).values({ enterpriseId: id, name: '历史名称', nameNorm: '历史名称', sourceKind: 'manual', verificationStatus: 'confirmed', createdAt: '2026-01-01' })
  const legacy = async () => ({
    heads: await db.select().from(differenceReason).orderBy(differenceReason.id),
    aliases: await db.select().from(enterpriseAlias).orderBy(enterpriseAlias.id),
    enterprise: await db.select().from(enterprise).orderBy(enterprise.id),
  })
  const before = await legacy(), input = await command(id, { action: 'assert', fact: { ...fact, kind: 'moved_in', effective: { precision: 'unknown', value: null } } })
  await commit(id, input)
  expect(await legacy()).toEqual(before)
  const current = (await http(id)).body
  expect(current.facts[0].fact).toMatchObject({ kind: 'moved_in', city: null, effective: { precision: 'unknown', value: null } })
  const request = await command(id, { action: 'replace', factId: current.facts[0].factId, fact })
  const plan = (await http(id, '/preflight', request)).body
  // Simulate storage failure after revisions, before receipt: entire command must roll back.
  await db.execute(sql`ALTER TABLE enterprise_fact_receipt ADD CONSTRAINT reject_fact_receipt CHECK (false) NOT VALID`)
  try { expect((await http(id, '/commit', { request, planHash: plan.planHash })).status).toBe(500) }
  finally { await db.execute(sql`ALTER TABLE enterprise_fact_receipt DROP CONSTRAINT reject_fact_receipt`) }
  expect((await http(id)).body).toEqual(current)
  expect(await legacy()).toEqual(before)
  expect((await http(id, '/commit', { request, planHash: plan.planHash })).status).toBe(200)
})

it('confirmed past independent facts exclude through the existing qualification reader without changing legacy storage', async () => {
  const id = await seed()
  const read = () => readAssessment(id, 'specialized_sme', Date.now())
  const input = await command(id, { action: 'assert', fact })
  const first = await commit(id, input)
  await commit(id, await command(id, { action: 'confirm', factId: first.body.factId }))
  expect((await read()).region.status).toBe('outside_ningbo')
  expect((await read()).group).toBe('excluded')
  const detail = await http(id, '/detail')
  expect(detail.status).toBe(200)
  expect(detail.body.qualificationAssessment.titles.find((t: any) => t.titleCode === 'specialized_sme').region.status).toBe('outside_ningbo')
})
it('conservative intervals preserve precision and unknown registration never implies termination', async () => {
  for (const [kind, effective, region, subject] of [
    ['moved_out', { precision: 'year', value: '2026' }, 'unresolved', 'unresolved'],
    ['moved_out', { precision: 'month', value: '2026-11' }, 'unresolved', 'unresolved'],
    ['moved_out', { precision: 'unknown', value: null }, 'unresolved', 'unresolved'],
    ['registration_status', { precision: 'year', value: '2024' }, 'unresolved', 'unresolved'],
    ['cancelled', { precision: 'year', value: '2024' }, 'not_established', 'terminated'],
  ] as const) {
    const id = await seed()
    const first = await commit(id, await command(id, { action: 'assert', fact: { ...fact, kind, effective } }))
    await commit(id, await command(id, { action: 'confirm', factId: first.body.factId }))
    const read = await readAssessment(id, 'little_giant')
    expect(read.region.status).toBe(region)
    expect(read.subject.status).toBe(subject)
    expect((await http(id)).body.facts[0].fact.effective).toEqual(effective)
  }
})
it('native qualification consumes confirmed facts and withdrawal preserves immutable lifecycle revisions', async () => {
  const id=await seed(),read=()=>readAssessment(id)
  expect((await read()).region.status).toBe('not_established')
  const first=await commit(id,await command(id,{action:'assert',fact}))
  await commit(id,await command(id,{action:'confirm',factId:first.body.factId}))
  const confirmed=(await http(id)).body
  expect(confirmed.facts).toMatchObject([{factId:first.body.factId,status:'confirmed',fact}])
  expect((await read()).region.status).toBe('outside_ningbo')
  const version=(await read()).versions.facts
  await commit(id,await command(id,{action:'withdraw',factId:first.body.factId}))
  const withdrawn=(await http(id)).body
  expect(withdrawn.facts).toMatchObject([{factId:first.body.factId,status:'withdrawn',fact}])
  expect(withdrawn.history.map((row:any)=>row.action)).toEqual(['assert','confirm','withdraw'])
  expect(withdrawn.history.slice(0,2)).toEqual(confirmed.history)
  expect((await read()).region.status).toBe('not_established')
  expect((await read()).versions.facts).not.toBe(version)
})
it('difference commands pin multiple owned confirmed revisions and reject cross-enterprise stale or pending references', async () => {
  const { internalDecisionCommand102 } = await import('../../../layers/sme-roster/server/utils/decision-lifecycle-102/contract')
  const { savePostgresDecision102 } = await import('../../../layers/sme-roster/server/utils/decision-lifecycle-102/postgres-writes')
  const id = await seed(), other = await seed(), refs: any[] = []
  for (const kind of ['moved_out', 'cancelled']) {
    const first = await commit(id, await command(id, { action: 'assert', fact: { ...fact, kind } }))
    await commit(id, await command(id, { action: 'confirm', factId: first.body.factId }))
    refs.push({ enterpriseId: id, factId: first.body.factId, revision: 2, kind })
  }
  const request: any = { enterpriseId: id, titleCode: 'specialized_sme', direction: 'missing_in_miit', action: 'replace', expectedCurrentId: null, idempotencyKey: `decision-${++seq}`, actor: { type: 'agent', id: 'test' }, basis: '核实', ruleVersion: 'test', effectiveAt: '2026-01-01T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'none', verificationStatus: 'confirmed', factReferences: refs } }
  for (const bad of [{ ...refs[0], enterpriseId: other }, { ...refs[0], revision: 1 }, { ...refs[0], kind: 'moved_in' }]) {
    await expect(savePostgresDecision102(db, internalDecisionCommand102.parse({ ...request, decision: { ...request.decision, factReferences: [bad] } }))).rejects.toThrow()
  }
  const result = await savePostgresDecision102(db, internalDecisionCommand102.parse(request))
  if (typeof result.versionId !== 'number') throw new Error('Expected a numeric decision version ID')
  const [row] = await db.select().from(differenceReason).where(eq(differenceReason.id, result.versionId))
  expect(JSON.parse(row!.factReferences!)).toEqual(refs)
})
it('overlapping opposite migrations stay pending and confirmed cancellation survives a later migration', async () => {
  const id = await seed(), read = () => readAssessment(id, 'little_giant')
  for (const kind of ['moved_in', 'moved_out', 'cancelled', 'moved_in']) {
    const first = await commit(id, await command(id, { action: 'assert', fact: { ...fact, kind, effective: { precision: 'year', value: kind === 'moved_in' ? '2024' : '2024' } } }))
    await commit(id, await command(id, { action: 'confirm', factId: first.body.factId }))
    if (kind === 'moved_out') expect((await read()).region.status).toBe('unresolved')
  }
  expect((await read()).subject.status).toBe('terminated')
  expect((await read()).group).toBe('excluded')
})

it('concurrent HTTP and MCP confirmations replay one committed revision', async () => {
  const enterpriseId = await seed()
  const asserted = await commit(enterpriseId, await command(enterpriseId, { action: 'assert', fact }))
  const original = (await http(enterpriseId)).body
  const confirm = await command(enterpriseId, { action: 'confirm', factId: asserted.body.factId })
  const { body: plan } = await http(enterpriseId, '/preflight', confirm)
  const submitted = { request: confirm, planHash: plan.planHash }
  expect((await http(enterpriseId, '/commit', submitted, false)).status).toBe(401)
  const [mcpResult, httpResult] = await Promise.all([
    mcp.commit_enterprise_fact.handler({ enterpriseId, request: submitted }),
    http(enterpriseId, '/commit', submitted),
  ])
  expect(httpResult.status).toBe(200)
  expect(mcpResult).toEqual(httpResult.body)
  const confirmed = (await http(enterpriseId)).body
  expect(confirmed.history[0]).toEqual(original.history[0])
  expect(confirmed.history.map((row: any) => [row.revision, row.status])).toEqual([[1, 'pending'], [2, 'confirmed']])
  expect(await mcp.get_enterprise_facts.handler({ enterpriseId })).toEqual(confirmed)
  expect((await readAssessment(enterpriseId)).region.status).toBe('outside_ningbo')
})
