import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { useDb, schema } from '../db'
import { listPlatformQueries, MAX_FULL_QUERY_BYTES } from '../lib/platform/read'
import { readPlatformQueryEvidence } from '../lib/platform/evidence-read'
const dir = mkdtempSync(join(tmpdir(), 'platform-query-evidence-'))
const db = useDb({ dbPath: join(dir, 'test.sqlite') })
const raw = '完整原文🙂\n\\"尾部'
const id = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'synthetic-evidence', queriedAt: '2026-10-19', status: 'partial', rawResponse: raw, collectionEvidence: { pages: [{ status: 'success', rdjb: '2', page: 3, fetchedCount: 2 }], rows: [{ original: '完整🙂' }] } as never }).returning().get().id
const ids = [2, 1].map(sequenceNo => db.insert(schema.platformRelation).values({ queryId: id, sequenceNo, relationKey: 'same-key', rawFields: { original: `原行${sequenceNo}🙂` }, sourceText: `原文${sequenceNo}` }).returning().get().id)
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
function chunks(field: 'rawResponse' | 'collectionEvidence' | 'relation', relationId?: number) {
  const buffers: Buffer[] = []
  let offset = 0
  for (;;) {
    const part = readPlatformQueryEvidence(db, { queryId: id, field, relationId, offset, length: 7 }) as any
    expect(part).toMatchObject({ queryId: id, field, encoding: 'base64', offset })
    const bytes = Buffer.from(part.data, 'base64')
    expect(part.byteLength).toBe(bytes.length)
    expect(bytes.length).toBeLessThanOrEqual(7)
    buffers.push(bytes)
    offset += bytes.length
    if (!part.hasMore) { expect(offset).toBe(part.totalBytes); break }
  }
  return Buffer.concat(buffers).toString('utf8')
}
it('byte chunks reassemble exact Unicode raw response and complete collection segments', () => {
  expect(chunks('rawResponse')).toBe(raw)
  expect(JSON.parse(chunks('collectionEvidence'))).toEqual({ pages: [{ status: 'success', rdjb: '2', page: 3, fetchedCount: 2 }], rows: [{ original: '完整🙂' }] })
  expect(readPlatformQueryEvidence(db, { queryId: id, field: 'rawResponse', offset: Buffer.byteLength(raw), length: 1 })).toMatchObject({ byteLength: 0, hasMore: false, totalBytes: Buffer.byteLength(raw) })
})
it('relation IDs page in original sequence and each original relation is independently exact', () => {
  expect(readPlatformQueryEvidence(db, { queryId: id, field: 'relations', pageSize: 1 })).toMatchObject({ total: 2, rows: [{ id: ids[1], sequenceNo: 1 }], page: 1, pageSize: 1 })
  expect(readPlatformQueryEvidence(db, { queryId: id, field: 'relations', pageSize: 1, page: 2 })).toMatchObject({ total: 2, rows: [{ id: ids[0], sequenceNo: 2 }] })
  expect(JSON.parse(chunks('relation', ids[0]))).toMatchObject({ id: ids[0], queryId: id, sequenceNo: 2, relationKey: 'same-key', rawFields: { original: '原行2🙂' }, sourceText: '原文2' })
  expect(listPlatformQueries(db, { queryId: id }).rows[0]!.relations.map(r => [r.sourceRdjb, r.sourcePage])).toEqual([['2', 3], ['2', 3]])
})
it('missing identities, invalid ranges and null evidence remain distinguishable', () => {
  expect(() => readPlatformQueryEvidence(db, { queryId: 9999, field: 'rawResponse' })).toThrowError(/not found/)
  expect(() => readPlatformQueryEvidence(db, { queryId: id, field: 'relation', relationId: 9999 })).toThrowError(/not found/)
  for (const input of [{ offset: -1 }, { offset: 0.5 }, { length: 0 }, { length: 65537 }, { pageSize: 201 }]) expect(() => readPlatformQueryEvidence(db, { queryId: id, field: 'rawResponse', ...input })).toThrowError(/Invalid/)
  const emptyId = db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: 'null-evidence', queriedAt: '2026-10-19', status: 'no_record' }).returning().get().id
  expect(readPlatformQueryEvidence(db, { queryId: emptyId, field: 'rawResponse' })).toMatchObject({ isNull: true, data: '', totalBytes: 0, hasMore: false })
  expect(readPlatformQueryEvidence(db, { queryId: emptyId, field: 'relations' })).toMatchObject({ rows: [], total: 0 })
})
it('oversized full evidence fails explicitly while summary and byte-exact reads stay available', () => {
  const huge = '原'.repeat(1_500_000)
  const largeId = db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: 'large-evidence', queriedAt: '2026-10-19', status: 'failed', rawResponse: huge }).returning().get().id
  expect(listPlatformQueries(db, { queryId: largeId }).rows[0]!.query.status).toBe('failed')
  expect(() => listPlatformQueries(db, { queryId: largeId, includeRawResponse: true })).toThrowError(/summary/)
  expect(listPlatformQueries(db, { queryId: largeId, view: 'summary' }).rows[0]!.query.id).toBe(largeId)
  expect(readPlatformQueryEvidence(db, { queryId: largeId, field: 'rawResponse', offset: Buffer.byteLength(huge) - 3, length: 3 })).toMatchObject({ data: Buffer.from('原').toString('base64'), byteLength: 3, hasMore: false })
})
it('full-read byte budgets accept the exact item boundary and reject an oversized combined page or relation', () => {
  const exactId = db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: 'exact-budget', queriedAt: '2026-10-19', status: 'success', rawResponse: 'x'.repeat(MAX_FULL_QUERY_BYTES) }).returning().get().id
  expect(listPlatformQueries(db, { queryId: exactId, includeRawResponse: true }).rows[0]!.query.rawResponse!.length).toBe(MAX_FULL_QUERY_BYTES)
  db.$client.prepare('update platform_query set raw_response = raw_response || ? where id = ?').run('x', exactId)
  expect(() => listPlatformQueries(db, { queryId: exactId, includeRawResponse: true })).toThrowError(/summary/)
  for (let n = 0; n < 3; n++) db.insert(schema.platformQuery).values({ interface: 'apply_list', rdjb: String(n), queryKey: 'page-budget', queriedAt: '2026-10-19', status: 'success', rawResponse: 'x'.repeat(3 * 1024 * 1024) }).run()
  expect(() => listPlatformQueries(db, { queryKey: 'page-budget', includeRawResponse: true })).toThrowError(/summary/)
  expect(listPlatformQueries(db, { queryKey: 'page-budget', includeRawResponse: true, pageSize: 1 }).total).toBe(3)
  db.insert(schema.platformRelation).values({ queryId: exactId, sequenceNo: 1, rawFields: { original: 'x'.repeat(MAX_FULL_QUERY_BYTES) } }).run()
  expect(() => listPlatformQueries(db, { queryId: exactId })).toThrowError(/summary/)
  expect(listPlatformQueries(db, { queryId: exactId, view: 'summary' }).rows[0]!.query.relationCount).toBe(1)
})
