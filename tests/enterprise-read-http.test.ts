import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, getQuery, getRouterParam, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useDb, schema } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'enterprise-read-http-'))
const db = useDb({ dbPath: join(dir, 'test.sqlite') })
const owner = db.insert(schema.enterprise).values({ name: '合成双称号企业', nameNorm: '合成双称号企业', usccNorm: 'SYNTHETIC84', district: '海曙区' }).returning().get().id
const unrelated = db.insert(schema.enterprise).values({ name: '无关企业', nameNorm: '无关企业' }).returning().get().id
for (const [titleCode, year] of [['specialized_sme', 2022], ['little_giant', 2024]] as const) {
  const recordId = db.insert(schema.record).values({ enterpriseId: owner, titleCode, source: 'jxj' }).returning().get().id
  const eventId = db.insert(schema.recordEvent).values({ recordId, eventType: 'award', year, decidedYear: year }).returning().get().id
  db.insert(schema.recordEvidence).values({ recordEventId: eventId, sourceFile: 'synthetic.pdf', page: 3 }).run()
  db.insert(schema.recordEvent).values({ recordId, eventType: 'review', year: 2025, decidedYear: 2025, reviewOutcome: 'passed' }).run()
}
for (const [name, verificationStatus] of [['已确认旧名', 'confirmed'], ['待核旧名', 'pending']] as const) db.insert(schema.enterpriseAlias).values({ enterpriseId: owner, name, nameNorm: name, sourceKind: 'manual', sourceRefId: 0, verificationStatus }).run()
const recognized = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: ' synthetic84 ', queriedAt: '2026-10-19', status: 'partial', collectionEvidence: { titleScope: { rdjb: ['2'] }, pages: [{ rdjb: '2', page: 4, fetchedCount: 2, status: 'success' }] } as never }).returning().get().id
for (const sequenceNo of [2, 1]) db.insert(schema.platformRelation).values({ queryId: recognized, sequenceNo, enterpriseId: sequenceNo === 1 ? owner : null, rawFields: { original: `原行${sequenceNo}` }, nameRaw: `原名${sequenceNo}` }).run()
const failed = db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: 'name:合成双称号企业', queriedAt: '2026-10-18', status: 'failed', failureReason: 'synthetic failure' }).returning().get().id
const otherQuery = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'unrelated', queriedAt: '2026-10-19', status: 'success', rawResponse: '原文'.repeat(1_000_000) }).returning().get().id
// A malformed, unrelated archive must never be decoded by a list or a fixed enterprise read.
db.$client.prepare('UPDATE platform_query SET collection_evidence = ? WHERE id = ?').run('{unrelated invalid json', otherQuery)
db.insert(schema.platformRelation).values({ queryId: otherQuery, sequenceNo: 1, enterpriseId: unrelated }).run()
db.$client.prepare('UPDATE platform_relation SET raw_fields = ? WHERE query_id = ?').run('{unrelated invalid json', otherQuery)
let server: ReturnType<typeof createServer>, base: string
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  for (const [name, value] of Object.entries({ defineEventHandler, getQuery, getRouterParam, createError })) vi.stubGlobal(name, value)
  const list = (await import('../server/api/roster/enterprises.get')).default
  const detail = (await import('../server/api/roster/enterprises/[id].get')).default
  server = createServer(toNodeListener(createApp({ debug: false }).use(createRouter().get('/api/roster/enterprises', list).get('/api/roster/enterprises/:id', detail))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
it('HTTP list keeps filters, same-title recognition, counts, stable deep pages and confirmed alias search without decoding unrelated archives', async () => {
  const response = await fetch(`${base}/api/roster/enterprises?q=已确认旧名&pageSize=1`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ counts: { total: 1, titlePairs: 2, recognitionPairs: 2, differences: 2 }, rows: [{ enterpriseId: owner, titles: ['little_giant', 'specialized_sme'], aliasNames: ['已确认旧名'], nextReviewYear: 2028 }] })
  for (const query of ['q=待核旧名', 'title=little_giant&firstYear=2022', 'source=jxj&eventType=award&year=2025']) expect(await (await fetch(`${base}/api/roster/enterprises?${query}`)).json()).toMatchObject({ counts: { total: 0 }, rows: [] })
  expect(await (await fetch(`${base}/api/roster/enterprises?q=合成&sort=name&page=2&pageSize=1`)).json()).toMatchObject({ counts: { total: 1 }, page: 2, rows: [] })
})
it('HTTP detail scopes identity and record evidence but preserves recognized unmatched rows, failures, original JSON and source positions', async () => {
  // Unrelated identity JSON also cannot be loaded by the detail path.
  db.$client.prepare('UPDATE enterprise SET quality_flags = ? WHERE id = ?').run('{invalid unrelated identity', unrelated)
  try {
    const response = await fetch(`${base}/api/roster/enterprises/${owner}`)
    expect(response.status).toBe(200)
    const detail = await response.json()
    expect(detail.records).toHaveLength(2)
    expect(detail.events).toHaveLength(4)
    expect(detail.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ sourceFile: 'synthetic.pdf', page: 3 })]))
    expect(detail.aliases).toHaveLength(2)
    expect(detail.platform.queries.map((q: any) => [q.id, q.status, q.relationCount])).toEqual([[failed, 'failed', 0], [recognized, 'partial', 2]])
    expect(detail.platform.relations.map((r: any) => [r.sequenceNo, r.enterpriseId, r.rawFields, r.sourcePage])).toEqual([[1, owner, { original: '原行1' }, 4], [2, null, { original: '原行2' }, 4]])
  } finally { db.$client.prepare('UPDATE enterprise SET quality_flags = NULL WHERE id = ?').run(unrelated) }
  expect((await fetch(`${base}/api/roster/enterprises/999999`)).status).toBe(404)
  expect((await fetch(`${base}/api/roster/enterprises/invalid`)).status).toBe(400)
})
