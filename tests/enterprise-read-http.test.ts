import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, getQuery, getRouterParam, defineEventHandler, createError, setHeader } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useDb, schema } from '../db'
import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'
import { listEnterprises } from '../server/utils/mcp-roster'

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
let normalizationCalls = 0
let unrelatedPointerBytes = 0
const prepare = db.$client.prepare.bind(db.$client)
db.$client.prepare = ((...args: Parameters<typeof db.$client.prepare>) => {
  const statement = prepare(...args)
  const observe = (value: unknown) => {
    if (typeof value === 'string' && value.startsWith('unrelated-pointer-')) unrelatedPointerBytes += Buffer.byteLength(value)
    else if (value && typeof value === 'object') for (const child of Object.values(value)) observe(child)
  }
  for (const method of ['get', 'all'] as const) {
    const run = statement[method].bind(statement)
    statement[method] = ((...params: unknown[]) => { const out = run(...params); observe(out); return out }) as never
  }
  const iterate = statement.iterate.bind(statement)
  statement.iterate = function* (...params: unknown[]) { for (const row of iterate(...params)) { observe(row); yield row } }
  return statement
}) as typeof db.$client.prepare
const registerFunction = db.$client.function.bind(db.$client)
db.$client.function = ((name: string, options: unknown, callback: (...args: unknown[]) => unknown) =>
  registerFunction(name, { ...(options as object), varargs: true }, (...args: unknown[]) => { normalizationCalls++; return callback(...args) })) as typeof db.$client.function
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  for (const [name, value] of Object.entries({ defineEventHandler, getQuery, getRouterParam, createError, setHeader })) vi.stubGlobal(name, value)
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
it('HTTP detail preserves legacy Unicode keys without allocating normalization callbacks for unrelated plain keys', async () => {
  const ids: number[] = []
  db.$client.transaction(() => {
    const insert = db.$client.prepare("INSERT INTO platform_query(interface,query_key,queried_at,status,created_at) VALUES('apply_list',?,'2026-10-19','failed','2026-10-19')")
    for (let i = 0; i < 1000; i++) ids.push(Number(insert.run(`synthetic84:unrelated:${i}`).lastInsertRowid))
    ids.push(Number(insert.run('\u200B sYnThEtIc84\u3000').lastInsertRowid))
  })()
  normalizationCalls = 0
  try {
    const response = await fetch(`${base}/api/roster/enterprises/${owner}`)
    expect(response.status).toBe(200)
    const detail = await response.json()
    expect(detail.platform.queries.map((q: any) => q.id)).toEqual([failed, recognized, ids.at(-1)])
    // Observe the same reader on this instrumented connection, then compare to
    // the worker/HTTP result. A worker has its own driver, so a zero reading on
    // the writer connection alone would prove nothing about its allocations.
    expect(getRosterEnterpriseDetail(db, owner)).toEqual(detail)
    expect(normalizationCalls).toBeGreaterThan(0)
    // Supplementary allocation observation at the real SQLite/HTTP seam.
    // Unrelated ASCII punctuation/lowercase keys must stay inside native SQL.
    expect(normalizationCalls).toBeLessThan(30)
  } finally {
    db.$client.prepare(`DELETE FROM platform_query WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
  }
})
it('HTTP filtered list counts titles without materializing unrelated evidence pointers', async () => {
  const record = db.insert(schema.record).values({ enterpriseId: unrelated, titleCode: 'innovative_sme', source: 'jxj' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2020 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: `unrelated-pointer-${'x'.repeat(4096)}.pdf` }).run()
  unrelatedPointerBytes = 0
  try {
    const response = await fetch(`${base}/api/roster/enterprises?q=已确认旧名&pageSize=1`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ counts: { total: 1, titlePairs: 2, recognitionPairs: 2, differences: 2 }, rows: [{ enterpriseId: owner, nextReviewYear: 2028 }] })
    listEnterprises(db, { q: '已确认旧名', pageSize: 1 })
    expect(unrelatedPointerBytes).toBe(0)
  } finally { db.$client.prepare('DELETE FROM record WHERE id = ?').run(record.id) }
})
it('HTTP detail keeps embedded-null Unicode identity normalization', async () => {
  const identity = db.insert(schema.enterprise).values({ name: '控制符测试企业', nameNorm: '控制符测试企业', usccNorm: 'X\u0000SS' }).returning().get()
  const query = db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: 'x\u0000ß', queriedAt: '2026-10-19', status: 'failed' }).returning().get()
  try {
    const response = await fetch(`${base}/api/roster/enterprises/${identity.id}`)
    expect(response.status).toBe(200)
    expect((await response.json()).platform.queries.map((q: any) => q.id)).toEqual([query.id])
  } finally {
    db.$client.prepare('DELETE FROM platform_query WHERE id = ?').run(query.id)
    db.$client.prepare('DELETE FROM enterprise WHERE id = ?').run(identity.id)
  }
})
it('HTTP name-only detail skips impossible normalized-name matches in unrelated query keys', async () => {
  const identity = db.insert(schema.enterprise).values({ name: '纯名称主体', nameNorm: '纯名称主体' }).returning().get()
  const exact = db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: 'name:纯名称主体', queriedAt: '2026-10-19', status: 'failed' }).returning().get()
  const ids: number[] = []
  db.$client.transaction(() => {
    const insert = db.$client.prepare("INSERT INTO platform_query(interface,query_key,queried_at,status,created_at) VALUES('apply_list',?,'2026-10-19','failed','2026-10-19')")
    for (let i = 0; i < 1000; i++) ids.push(Number(insert.run(`\u200B 无关键${i} `).lastInsertRowid))
  })()
  normalizationCalls = 0
  try {
    const response = await fetch(`${base}/api/roster/enterprises/${identity.id}`)
    expect(response.status).toBe(200)
    const detail = await response.json()
    expect(detail.platform.queries.map((q: any) => q.id)).toEqual([exact.id])
    expect(getRosterEnterpriseDetail(db, identity.id)).toEqual(detail)
    expect(normalizationCalls).toBeLessThan(30)
  } finally {
    db.$client.prepare(`DELETE FROM platform_query WHERE id IN (${[exact.id, ...ids].map(() => '?').join(',')})`).run(exact.id, ...ids)
    db.$client.prepare('DELETE FROM enterprise WHERE id=?').run(identity.id)
  }
})
it('MCP search keeps malformed UTF-16 distinct from stored replacement characters', () => {
  const identity = db.insert(schema.enterprise).values({ name: '替换\uFFFD企业', nameNorm: '替换\uFFFD企业', district: '替换\uFFFD属地' }).returning().get()
  try {
    // SQLite UTF-8 binding substitutes U+FFFD for an isolated surrogate. The
    // original JS predicates did not equate these distinct inputs.
    expect(listEnterprises(db, { q: '\uD800' }).rows).toEqual([])
    expect(listEnterprises(db, { district: '替换\uD800属地' }).rows).toEqual([])
    expect(listEnterprises(db, { q: '\uFFFD' }).rows.map(row => row.enterpriseId)).toEqual([identity.id])
  } finally { db.$client.prepare('DELETE FROM enterprise WHERE id=?').run(identity.id) }
})
it('MCP search matches either UTF-16 half in supplementary names, confirmed aliases and USCC without replacement false positives', () => {
  const identities = [
    { name: '正名𠀀企业', nameNorm: '正名𠀀企业' },
    { name: '别名匹配企业', nameNorm: '别名匹配企业' },
    { name: '统代匹配企业', nameNorm: '统代匹配企业', usccNorm: 'SYN𠀀84' },
    { name: '待核别名企业', nameNorm: '待核别名企业' },
    { name: '替换\uFFFD对照', nameNorm: '替换\uFFFD对照' },
  ].map(value => db.insert(schema.enterprise).values(value).returning().get().id)
  for (const [index, verificationStatus] of [[1, 'confirmed'], [3, 'pending']] as const) db.insert(schema.enterpriseAlias).values({ enterpriseId: identities[index]!, name: '旧名𠀀', nameNorm: '旧名𠀀', sourceKind: 'manual', sourceRefId: 0, verificationStatus }).run()
  try {
    for (const q of ['𠀀', '\uD840', '\uDC00']) {
      const result = listEnterprises(db, JSON.parse(JSON.stringify({ q })))
      expect(result.counts.total).toBe(3)
      expect(result.rows.map(row => row.enterpriseId).sort((a, b) => a - b)).toEqual(identities.slice(0, 3))
    }
    expect(listEnterprises(db, { q: '\uD841' }).rows).toEqual([])
    expect(listEnterprises(db, { q: '\uDC01' }).rows).toEqual([])
    expect(listEnterprises(db, { q: '\uFFFD' }).rows.map(row => row.enterpriseId)).toEqual([identities[4]])
  } finally {
    for (const id of identities) {
      db.$client.prepare('DELETE FROM enterprise_alias WHERE enterprise_id=?').run(id)
      db.$client.prepare('DELETE FROM enterprise WHERE id=?').run(id)
    }
  }
})
it('HTTP SQL selection preserves first-award ties, pending years, same-event filters and terminated lifecycle', async () => {
  const identities = ['A', 'B', 'C'].map(label => db.insert(schema.enterprise).values({ name: `汇总边界${label}`, nameNorm: `汇总边界${label}`, usccNorm: `BOUND84${label}` }).returning().get().id)
  const [a, b, c] = identities as [number, number, number]
  const record = (enterpriseId: number, titleCode: string, source: 'jxj' | 'miit' = 'jxj') => db.insert(schema.record).values({ enterpriseId, titleCode, source }).returning().get().id
  const award = (recordId: number, year: number | null, evidence: boolean, decidedYear = year) => {
    const id = db.insert(schema.recordEvent).values({ recordId, eventType: 'award', year, decidedYear }).returning().get().id
    if (evidence) db.insert(schema.recordEvidence).values({ recordEventId: id, sourceFile: 'boundary.pdf', page: 1 }).run()
    return id
  }
  const early = award(record(a, 'specialized_sme'), 2020, false, 2021)
  const aPlatform = record(a, 'specialized_sme', 'miit')
  award(aPlatform, 2021, true)
  award(record(a, 'innovative_sme'), 2019, true)
  db.insert(schema.recordEvent).values({ recordId: aPlatform, eventType: 'review', year: 2024, decidedYear: 2024, reviewOutcome: 'passed' }).run()
  award(record(b, 'little_giant'), null, true)
  const cRecord = record(c, 'specialized_sme')
  award(cRecord, 2020, true, 2022)
  db.insert(schema.recordEvent).values({ recordId: cRecord, eventType: 'review', year: 2025, decidedYear: 2025, reviewOutcome: 'failed' }).run()
  const list = async (query: string) => (await fetch(`${base}/api/roster/enterprises?q=汇总边界&${query}`)).json()
  try {
    const result = await list('pageSize=10')
    expect(result.rows.map((row: any) => row.enterpriseId)).toEqual([c, a, b])
    expect(result.counts).toMatchObject({ total: 3, titlePairs: 4, recognitionPairs: 4, differences: 3 })
    expect(result.rows[0]).toMatchObject({ nextReviewYear: null, firstRecognition: [{ year: 2022, status: 'confirmed' }] })
    expect(result.rows[1].firstRecognition.find((entry: any) => entry.titleCode === 'specialized_sme')).toMatchObject({ year: 2021, firstEventId: early, status: 'pending', pendingReason: 'no_evidence' })
    expect(await list('title=specialized_sme&firstYear=2021&firstStatus=pending')).toMatchObject({ counts: { total: 1, titlePairs: 2, recognitionPairs: 1 }, rows: [{ enterpriseId: a }] })
    expect(await list('title=little_giant&firstStatus=pending')).toMatchObject({ rows: [{ enterpriseId: b, firstRecognition: [{ year: null, pendingReason: 'no_dated_award' }] }] })
    expect(await list('source=jxj&eventType=review&year=2024')).toMatchObject({ counts: { total: 0 }, rows: [] })
    expect(await list('source=miit&eventType=review&year=2024')).toMatchObject({ counts: { total: 1 }, rows: [{ enterpriseId: a }] })
  } finally {
    db.$client.prepare(`DELETE FROM record WHERE enterprise_id IN (${identities.map(() => '?').join(',')})`).run(...identities)
    db.$client.prepare(`DELETE FROM enterprise WHERE id IN (${identities.map(() => '?').join(',')})`).run(...identities)
  }
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
it('keeps unknown reference titles through the generic aggregate instead of dropping them from compact counts', async () => {
  db.insert(schema.title).values({ code: 'synthetic_extra', nameZh: '合成额外称号', level: 'municipal', rank: 99 }).run()
  const enterprise = db.insert(schema.enterprise).values({ name: '额外称号企业', nameNorm: '额外称号企业' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'synthetic_extra', source: 'jxj' }).returning().get()
  db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).run()
  try {
    const response = await fetch(`${base}/api/roster/enterprises?q=额外称号企业`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ counts: { total: 1, titlePairs: 1, recognitionPairs: 1, differences: 0, titles: { synthetic_extra: 1 } }, rows: [{ titles: ['synthetic_extra'] }] })
  } finally {
    db.$client.prepare('delete from record_event where record_id=?').run(record.id)
    db.$client.prepare('delete from record where id=?').run(record.id)
    db.$client.prepare('delete from enterprise where id=?').run(enterprise.id)
    db.$client.prepare("delete from title where code='synthetic_extra'").run()
  }
})
