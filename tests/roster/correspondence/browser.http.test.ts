import { handlePostgresCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-runtime'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, toNodeListener, defineEventHandler } from 'h3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../fixtures/postgres-tables'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { browserCorrespondenceRoute } from '../../../layers/sme-roster/server/utils/browser-correspondence'

const createDb = useIsolatedPostgresCases()
let state: Awaited<ReturnType<typeof setup>>
async function setup() {
  const db = createDb()
  const enterprise = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: '合成对应企业', nameNorm: '合成对应企业', usccNorm: '91330211255994457P' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme', usccRaw: enterprise.usccNorm }).returning())
  const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022 }).returning())
  const seeded = await seedPostgresPlatformQuery(db, { interface: 'business_list', titleCode: 'specialized_sme', rdjb: '2', queryKey: enterprise.usccNorm!, queriedAt: '2026-10-23T00:00:00Z', status: 'success', rawResponse: 'Synthetic browser source', relations: [1, 2, 3].map(sequenceNo => ({ sequenceNo, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed' as const, rawFields: { original: `原行${sequenceNo}` } })) })
  const relations = seeded.relationIds.map(id => ({ id }))
  const edge = (n: number) => ({ type: 'event_process', eventId: event.id, relationId: relations[n]!.id, role: 'context_only' })
  const config = { apiToken: 'synthetic-private-token', }
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  const app = createApp()
  for (const action of ['preflight', 'commit'] as const) app.use('/' + action, browserCorrespondenceRoute(action))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (action: string, body: unknown, origin = base) => fetch(base + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
  const read = async (action: any, id?: number) => (await handlePostgresCorrespondenceRequest({ action, method: 'GET', id, query: action === 'list' ? { eventId: String(event.id) } : {} })).body as any
  let serial = 0
  const command = (operations: unknown[]) => ({ idempotencyKey: 'browser-test-' + ++serial, basis: '逐条核对双方原行', operations })
  const save = async (request: any) => {
    const response = await post('preflight', request); expect(response.status).toBe(200)
    const plan = await response.json()
    const committed = await post('commit', { request, planHash: plan.planHash }); expect(committed.status).toBe(200)
    return { receipt: await committed.json(), plan }
  }
  return { db, record, edge, relations, config, post, read, command, save, server }
}
beforeEach(async () => { state = await setup() })
afterEach(async () => {
  if (state) await new Promise<void>(resolve => state.server.close(() => resolve()))
})

it('gates same origin and rejects forged identity before any decision is written', async () => {
  const { edge, post, read, command } = state
  const request = command([{ action: 'create', status: 'confirmed', edge: edge(0) }])
  expect((await post('preflight', request, 'https://elsewhere.invalid')).status).toBe(403)
  expect((await post('preflight', { ...request, actor: { type: 'user', id: 'forged' } })).status).toBe(400)
  expect((await read('list')).total).toBe(0)
})

it('confirms cancels rejects and atomically replaces with truthful adapter audit and idempotent receipt', async () => {
  const { edge, relations, config, post, read, command, save } = state
  const first = await save(command([{ action: 'create', status: 'confirmed', edge: edge(0) }]))
  const a = first.receipt.correspondenceIds[0]
  expect(await read('get', a)).toMatchObject({ status: 'confirmed', revision: 2, requiresRevalidation: false })
  const audit = (await read('audit', a)).rows
  expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ actorType: 'agent', actorId: 'same-origin-correspondence-adapter', basis: '逐条核对双方原行' })]))
  const request = command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: edge(1) }])
  const { receipt, plan } = await save(request)
  expect((await read('list')).rows.map((row: any) => [row.relation.id, row.status]).sort()).toEqual([[relations[0]!.id, 'unlinked'], [relations[1]!.id, 'confirmed']])
  expect(await (await post('commit', { request, planHash: plan.planHash })).json()).toEqual(receipt)
  await save(command([{ action: 'decide', correspondenceId: receipt.correspondenceIds[1], expectedRevision: 2, status: 'unlinked' }]))
  const rejected = await save(command([{ action: 'create', status: 'rejected', edge: edge(2) }]))
  expect(await read('get', rejected.receipt.correspondenceIds[0])).toMatchObject({ status: 'rejected', revision: 2 })
  expect((await read('list')).rows.filter((row: any) => row.status === 'confirmed')).toHaveLength(0)
  expect(JSON.stringify({ receipt, audit })).not.toContain(config.apiToken)
})

it('rejects stale correction without a half replacement and refreshes to a new bound retry', async () => {
  const { db, record, edge, post, read, command, save } = state
  const another = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2022 }).returning())
  const otherEdge = (n: number) => ({ ...edge(n), eventId: another.id })
  const a = (await save(command([{ action: 'create', status: 'confirmed', edge: otherEdge(0) }]))).receipt.correspondenceIds[0]
  const b = (await save(command([{ action: 'create', status: 'candidate', edge: otherEdge(1) }]))).receipt.correspondenceIds[0]
  const request = command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(1) }])
  const preflight = await post('preflight', request)
  expect(preflight.status).toBe(200)
  const plan = await preflight.json()
  await save(command([{ action: 'decide', correspondenceId: a, expectedRevision: 2, status: 'unlinked' }]))
  const stale = await post('commit', { request, planHash: plan.planHash })
  expect(stale.status).toBe(409)
  expect(await read('get', a)).toMatchObject({ status: 'unlinked', revision: 3 })
  expect(await read('get', b)).toMatchObject({ status: 'candidate', revision: 1 })
  await save(command([{ action: 'decide', correspondenceId: b, expectedRevision: 1, status: 'confirmed' }]))
  expect(await read('get', b)).toMatchObject({ status: 'confirmed', revision: 2 })
})

it('atomically corrects to an already registered candidate without resetting manual history', async () => {
  const { db, record, edge, read, command, save } = state
  const another = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2021 }).returning())
  const otherEdge = (n: number) => ({ ...edge(n), eventId: another.id })
  const a = (await save(command([{ action: 'create', status: 'confirmed', edge: otherEdge(0) }]))).receipt.correspondenceIds[0]
  const b = (await save(command([{ action: 'create', status: 'candidate', edge: otherEdge(1) }]))).receipt.correspondenceIds[0]
  const result = await save(command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(1) }]))
  expect(result.receipt.correspondenceIds).toEqual([a, b])
  expect(await read('get', a)).toMatchObject({ status: 'unlinked', revision: 3 })
  expect(await read('get', b)).toMatchObject({ status: 'confirmed', revision: 2 })
  expect((await read('audit', b)).rows.map((row: any) => row.toStatus).sort()).toEqual(['candidate', 'confirmed'])
})

it('binds replacement source evidence and cannot resurrect an unchanged rejected decision', async () => {
  const { db, record, edge, post, read, command, save } = state
  const another = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2020 }).returning())
  const otherEdge = (n: number) => ({ ...edge(n), eventId: another.id })
  const a = (await save(command([{ action: 'create', status: 'confirmed', edge: otherEdge(0) }]))).receipt.correspondenceIds[0]
  const rejected = (await save(command([{ action: 'create', status: 'rejected', edge: otherEdge(1) }]))).receipt.correspondenceIds[0]
  expect((await post('preflight', command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(1) }]))).status).toBe(422)
  expect(await read('get', rejected)).toMatchObject({ status: 'rejected', revision: 2 })
  const request = command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(2) }])
  const plan = await (await post('preflight', request)).json()
  // Official source correction invalidates the bound replacement plan.
  const { eq } = await import('drizzle-orm')
  await db.update(schema.recordEvent).set({ batchSeq: 2 }).where(eq(schema.recordEvent.id, another.id))
  expect((await post('commit', { request, planHash: plan.planHash })).status).toBe(409)
  expect(await read('get', a)).toMatchObject({ status: 'confirmed', revision: 2 })
  expect(((await handlePostgresCorrespondenceRequest({ action: 'list', method: 'GET', query: { eventId: String(another.id) } })).body as any).rows).toHaveLength(2)
  // Existing confirmation now invalidated by a source change is historical, never a validity certificate.
  await db.update(schema.recordEvent).set({ batchSeq: 3 }).where(eq(schema.recordEvent.id, another.id))
  expect(await read('get', a)).toMatchObject({ status: 'confirmed', requiresRevalidation: true })
  await save(command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(0) }]))
  expect(await read('get', a)).toMatchObject({ status: 'confirmed', revision: 4, requiresRevalidation: false })
})

it('rejects two decisions on the replacement candidate in one plan without changing either edge', async () => {
  const { db, record, edge, post, read, command, save } = state
  const another = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2019 }).returning())
  const otherEdge = (n: number) => ({ ...edge(n), eventId: another.id })
  const a = (await save(command([{ action: 'create', status: 'confirmed', edge: otherEdge(0) }]))).receipt.correspondenceIds[0]
  const b = (await save(command([{ action: 'create', status: 'candidate', edge: otherEdge(1) }]))).receipt.correspondenceIds[0]
  const response = await post('preflight', command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(1) }, { action: 'decide', correspondenceId: b, expectedRevision: 1, status: 'rejected' }]))
  expect(response.status).toBe(422)
  expect(await read('get', a)).toMatchObject({ status: 'confirmed', revision: 2 })
  expect(await read('get', b)).toMatchObject({ status: 'candidate', revision: 1 })
})
