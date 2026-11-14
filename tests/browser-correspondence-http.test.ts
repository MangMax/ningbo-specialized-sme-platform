import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, toNodeListener, defineEventHandler } from 'h3'
import { afterAll, expect, it, vi } from 'vitest'
import { useDb, schema } from '../db/client'
import { browserCorrespondenceRoute } from '../server/utils/browser-correspondence'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'

const dir = mkdtempSync(join(tmpdir(), 'browser-correspondence-'))
const db = useDb({ dbPath: join(dir, 'test.db') })
const enterprise = db.insert(schema.enterprise).values({ name: '合成对应企业', nameNorm: '合成对应企业', usccNorm: '91330211255994457P' }).returning().get()
const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme', usccRaw: enterprise.usccNorm }).returning().get()
const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022 }).returning().get()
const query = db.insert(schema.platformQuery).values({ interface: 'business_list', titleCode: 'specialized_sme', rdjb: '2', queryKey: enterprise.usccNorm!, queriedAt: '2026-10-23T00:00:00Z', status: 'success' }).returning().get()
const relations = [1, 2, 3].map(sequenceNo => db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', rawFields: { original: `原行${sequenceNo}` } }).returning().get())
const edge = (n: number) => ({ type: 'event_process', eventId: event.id, relationId: relations[n]!.id, role: 'context_only' })
const config = { apiToken: 'synthetic-private-token', }
vi.stubGlobal('defineEventHandler', defineEventHandler)
const app = createApp()
for (const action of ['preflight', 'commit'] as const) app.use('/' + action, browserCorrespondenceRoute(action, () => ({ db, config })))
const server = createServer(toNodeListener(app))
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const post = (action: string, body: unknown, origin = base) => fetch(base + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
const read = (action: any, id?: number) => handleRecordCorrespondenceRequest({ action, method: 'GET', id, query: action === 'list' ? { eventId: String(event.id) } : {} }, { db }).body as any
let serial = 0
const command = (operations: unknown[]) => ({ idempotencyKey: 'browser-test-' + ++serial, basis: '逐条核对双方原行', operations })
const save = async (request: any) => {
  const response = await post('preflight', request); expect(response.status).toBe(200)
  const plan = await response.json()
  const committed = await post('commit', { request, planHash: plan.planHash }); expect(committed.status).toBe(200)
  return { receipt: await committed.json(), plan }
}
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals() })

it('gates same origin and rejects forged identity before any decision is written', async () => {
  const request = command([{ action: 'create', status: 'confirmed', edge: edge(0) }])
  expect((await post('preflight', request, 'https://elsewhere.invalid')).status).toBe(403)
  expect((await post('preflight', { ...request, actor: { type: 'user', id: 'forged' } })).status).toBe(400)
  expect(read('list').total).toBe(0)
})

it('confirms cancels rejects and atomically replaces with truthful adapter audit and idempotent receipt', async () => {
  const first = await save(command([{ action: 'create', status: 'confirmed', edge: edge(0) }]))
  const a = first.receipt.correspondenceIds[0]
  expect(read('get', a)).toMatchObject({ status: 'confirmed', revision: 2, requiresRevalidation: false })
  const audit = read('audit', a).rows
  expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ actorType: 'agent', actorId: 'same-origin-correspondence-adapter', basis: '逐条核对双方原行' })]))
  const request = command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: edge(1) }])
  const { receipt, plan } = await save(request)
  expect(read('list').rows.map((row: any) => [row.relation.id, row.status]).sort()).toEqual([[relations[0]!.id, 'unlinked'], [relations[1]!.id, 'confirmed']])
  expect(await (await post('commit', { request, planHash: plan.planHash })).json()).toEqual(receipt)
  await save(command([{ action: 'decide', correspondenceId: receipt.correspondenceIds[1], expectedRevision: 2, status: 'unlinked' }]))
  const rejected = await save(command([{ action: 'create', status: 'rejected', edge: edge(2) }]))
  expect(read('get', rejected.receipt.correspondenceIds[0])).toMatchObject({ status: 'rejected', revision: 2 })
  expect(read('list').rows.filter((row: any) => row.status === 'confirmed')).toHaveLength(0)
  expect(JSON.stringify({ receipt, audit })).not.toContain(config.apiToken)
})

it('rejects stale correction without a half replacement and refreshes to a new bound retry', async () => {
  const another = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2022 }).returning().get()
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
  expect(read('get', a)).toMatchObject({ status: 'unlinked', revision: 3 })
  expect(read('get', b)).toMatchObject({ status: 'candidate', revision: 1 })
  await save(command([{ action: 'decide', correspondenceId: b, expectedRevision: 1, status: 'confirmed' }]))
  expect(read('get', b)).toMatchObject({ status: 'confirmed', revision: 2 })
})

it('atomically corrects to an already registered candidate without resetting manual history', async () => {
  const another = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2021 }).returning().get()
  const otherEdge = (n: number) => ({ ...edge(n), eventId: another.id })
  const a = (await save(command([{ action: 'create', status: 'confirmed', edge: otherEdge(0) }]))).receipt.correspondenceIds[0]
  const b = (await save(command([{ action: 'create', status: 'candidate', edge: otherEdge(1) }]))).receipt.correspondenceIds[0]
  const result = await save(command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(1) }]))
  expect(result.receipt.correspondenceIds).toEqual([a, b])
  expect(read('get', a)).toMatchObject({ status: 'unlinked', revision: 3 })
  expect(read('get', b)).toMatchObject({ status: 'confirmed', revision: 2 })
  expect(read('audit', b).rows.map((row: any) => row.toStatus).sort()).toEqual(['candidate', 'confirmed'])
})

it('binds replacement source evidence and cannot resurrect an unchanged rejected decision', async () => {
  const another = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2020 }).returning().get()
  const otherEdge = (n: number) => ({ ...edge(n), eventId: another.id })
  const a = (await save(command([{ action: 'create', status: 'confirmed', edge: otherEdge(0) }]))).receipt.correspondenceIds[0]
  const rejected = (await save(command([{ action: 'create', status: 'rejected', edge: otherEdge(1) }]))).receipt.correspondenceIds[0]
  expect((await post('preflight', command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(1) }]))).status).toBe(422)
  expect(read('get', rejected)).toMatchObject({ status: 'rejected', revision: 2 })
  const request = command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(2) }])
  const plan = await (await post('preflight', request)).json()
  // Synthetic source change models an independently committed archive correction.
  const { eq } = await import('drizzle-orm')
  db.update(schema.platformRelation).set({ status: '合成来源更正' }).where(eq(schema.platformRelation.id, relations[2]!.id)).run()
  expect((await post('commit', { request, planHash: plan.planHash })).status).toBe(409)
  expect(read('get', a)).toMatchObject({ status: 'confirmed', revision: 2 })
  expect((handleRecordCorrespondenceRequest({ action: 'list', method: 'GET', query: { eventId: String(another.id) } }, { db }).body as any).rows).toHaveLength(2)
  // Existing confirmation now invalidated by a source change is historical, never a validity certificate.
  db.update(schema.platformRelation).set({ status: '合成来源更正' }).where(eq(schema.platformRelation.id, relations[0]!.id)).run()
  expect(read('get', a)).toMatchObject({ status: 'confirmed', requiresRevalidation: true })
  await save(command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(0) }]))
  expect(read('get', a)).toMatchObject({ status: 'confirmed', revision: 4, requiresRevalidation: false })
})

it('rejects two decisions on the replacement candidate in one plan without changing either edge', async () => {
  const another = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2019 }).returning().get()
  const otherEdge = (n: number) => ({ ...edge(n), eventId: another.id })
  const a = (await save(command([{ action: 'create', status: 'confirmed', edge: otherEdge(0) }]))).receipt.correspondenceIds[0]
  const b = (await save(command([{ action: 'create', status: 'candidate', edge: otherEdge(1) }]))).receipt.correspondenceIds[0]
  const response = await post('preflight', command([{ action: 'correct', correspondenceId: a, expectedRevision: 2, edge: otherEdge(1) }, { action: 'decide', correspondenceId: b, expectedRevision: 1, status: 'rejected' }]))
  expect(response.status).toBe(422)
  expect(read('get', a)).toMatchObject({ status: 'confirmed', revision: 2 })
  expect(read('get', b)).toMatchObject({ status: 'candidate', revision: 1 })
})
