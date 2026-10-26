import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { useDb, schema } from '../db'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { handleRosterImportRequest, type RosterHttpRequest } from '../server/utils/roster-import-http'
import { preflightRosterImport, commitRosterImport } from '../server/utils/roster-import'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { startHttpFixture } from './helpers/http-fixture'

const MiB = 1024 * 1024
const dirs: string[] = []
const clients: ReturnType<typeof useDb>['$client'][] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-ingestion-'))
  dirs.push(dir)
  const db = useDb({ dbPath: join(dir, 'roster.db') })
  clients.push(db.$client)
  // SQLite driver telemetry is supplemental resource evidence; behavior is observed via HTTP.
  const inserts: { bytes: number; rows: number }[] = []
  const instrumented = drizzle(db.$client, { schema, logger: {
    logQuery(query, params) {
      if (query.startsWith('insert into "platform_export_row"')) {
        inserts.push({ bytes: params.reduce<number>((n, p) => n + Buffer.byteLength(String(p ?? '')), 0), rows: params.length / 10 })
      }
    },
  } })
  return { db: instrumented, inserts }
}

function request(rows: number, key = 'snapshot:test'): RosterImportRequest {
  return {
    idempotencyKey: key, sourceKind: 'platform_export', sourceIdentity: 'synthetic/snapshot.xlsx',
    payload: { exportSnapshot: {
      titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19',
      originalFilename: 'synthetic.xlsx', sha256: 'synthetic-v1',
      rows: Array.from({ length: rows }, (_, i) => ({ sourceRowNo: i + 3, rawFields: { original: `  原行🙂\n${i}  ` } })),
    } },
  }
}

async function api(db: ReturnType<typeof database>['db']) {
  const server = await startHttpFixture({ routes: Object.fromEntries(['preflight', 'commit'].map(action => [
    `/api/roster/import/${action}`, async (input: RosterHttpRequest) => handleRosterImportRequest(action as 'preflight' | 'commit', input, { db, apiToken: 'synthetic-token', executeImport: async (db, action, body, errors) => action === 'preflight' ? preflightRosterImport(db, body, errors) : commitRosterImport(db, body, errors) }),
  ])), getRoutes: {
    '/source': input => handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind: 'export_row', id: String(input.query.id) }, { db, apiToken: 'synthetic-token' }),
  } })
  return { ...server,
    async post(action: string, body: RosterImportRequest) {
      const response = await fetch(`${server.baseUrl}/api/roster/import/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-token' }, body: JSON.stringify(body) })
      expect(response.status).toBe(200)
      return response.json() as Promise<any>
    },
    async source(id: number) {
      const response = await fetch(`${server.baseUrl}/source?id=${id}`)
      expect(response.status).toBe(200)
      return (await response.json() as any).source
    },
  }
}

it('snapshot HTTP import bounds encoded statements and preserves oversized raw items and receipt replay', async () => {
  const { db, inserts } = database()
  const server = await api(db)
  try {
    const input = request(9)
    const rows = input.payload.exportSnapshot!.rows
    rows[0]!.sourceRowNo = 99 // Receipt order follows insertion, not a sort by source row number.
    for (const row of rows) row.rawFields = { original: '  原文🙂\n'.repeat(30_000), empty: '', nested: { value: null } }
    rows[4]!.rawFields = { original: '🙂'.repeat(300_000), whitespace: ' \n\t ' }
    const preflight = await server.post('preflight', input)
    expect(preflight.preflight).toMatchObject({ add: 1, update: 0, conflicts: [] })
    const committed = await server.post('commit', input)
    expect(committed).toMatchObject({ status: 'committed', summary: { written: 10, failed: 0 }, items: [{ detail: { rowsWritten: 10, skipped: 0 } }] })
    // Each oversize row is kept whole as a singleton, never truncated or queued with others.
    expect(inserts.length).toBeGreaterThan(1)
    expect(inserts.every(insert => insert.rows <= 200 && (insert.bytes <= MiB || insert.rows === 1))).toBe(true)
    const ids: number[] = committed.items[0].detail.rows
    expect(ids).toHaveLength(9)
    for (const [index, id] of ids.entries()) {
      expect(await server.source(id)).toMatchObject({ sourceRowNo: index === 0 ? 99 : index + 3, rawFields: rows[index]!.rawFields })
    }
    expect(await server.post('commit', input)).toEqual(committed)
    const otherKey = { ...input, idempotencyKey: 'snapshot:other-key' }
    // #386 新用户裁定：同 SHA 完整来源只读复用，预检不计 update；回执/批次另账。
    expect((await server.post('preflight', otherKey)).preflight).toMatchObject({ add: 0, update: 0, conflicts: [] })
    expect(await server.post('commit', otherKey)).toMatchObject({ status: 'committed', summary: { written: 0 }, items: [{ detail: { rows: [], skipped: 9, rowsWritten: 0 } }] })
  } finally { await server.close() }
})

it('snapshot HTTP failure in a later chunk rolls back earlier rows and same-key retry returns a durable receipt', async () => {
  const { db } = database()
  const server = await api(db)
  try {
    const input = request(300, 'snapshot:recover')
    db.$client.exec("CREATE TRIGGER synthetic_chunk_failure BEFORE INSERT ON platform_export_row WHEN NEW.source_row_no = 203 BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END")
    const failed = await server.post('commit', input)
    expect(failed).toMatchObject({ status: 'failed', summary: { written: 0, failed: 1 }, items: [{ ok: false, error: { code: 'commit_rolled_back' } }] })
    expect((await fetch(`${server.baseUrl}/source?id=1`)).status).toBe(404)
    db.$client.exec('DROP TRIGGER synthetic_chunk_failure')
    const committed = await server.post('commit', input)
    expect(committed.batchId).toBe(failed.batchId)
    expect(committed).toMatchObject({ status: 'committed', summary: { written: 301, failed: 0 }, items: [{ ok: true, detail: { rowsWritten: 301, skipped: 0 } }] })
    for (const index of [0, 199, 200, 299]) {
      expect(await server.source(committed.items[0].detail.rows[index])).toMatchObject({ sourceRowNo: index + 3, rawFields: input.payload.exportSnapshot!.rows[index]!.rawFields })
    }
    expect(await server.post('commit', input)).toEqual(committed)
  } finally { await server.close() }
})

it.each([
  { name: 'S392-N01 same SHA rejects added rows', rowCount: 2 },
  { name: 'S392-N02 same SHA rejects an empty row set', rowCount: 0 },
])('$name', async ({ rowCount }) => {
  const { db } = database()
  const server = await api(db)
  try {
    const first = await server.post('commit', request(1, 'snapshot:control-first'))
    expect(first).toMatchObject({ status: 'committed', error: null, summary: { written: 2, skipped: 0, failed: 0 } })
    expect(first.items).toHaveLength(1)
    expect(first.items[0]).toMatchObject({ ok: true, detail: { rowsWritten: 2, skipped: 0 } })
    expect(first.items[0].detail.rows).toHaveLength(1)
    const id = first.items[0].detail.rows[0]
    expect(Number.isSafeInteger(id) && id > 0).toBe(true)
    const oldSource = await server.source(id)
    expect(oldSource).toMatchObject({ sourceRowNo: 3, batch: { sha256: 'synthetic-v1', rowCount: 1 } })
    expect(oldSource.rawFields).toEqual({ original: '  原行🙂\n0  ' })
    const before = {
      batches: db.select().from(schema.platformExportBatch).all(),
      rows: db.select().from(schema.platformExportRow).all(),
      correspondences: db.select().from(schema.recordCorrespondence).all(),
      audits: db.select().from(schema.recordCorrespondenceAudit).all(),
    }
    expect(before.batches).toHaveLength(1)
    expect(before.rows).toHaveLength(1)
    expect(before.correspondences).toEqual([])
    expect(before.audits).toEqual([])
    // These are the original illegal v1 one-to-two / one-to-empty inputs.
    const input = request(rowCount, 'snapshot:control-conflict')
    const conflict = {
      ok: false, kind: 'export_batch', ref: `export:${oldSource.batch.id}`,
      error: { code: 'export_row_set_conflict', field: 'rows', message: 'Replay must retain the original file row set' },
    }
    const preflight = await server.post('preflight', input)
    expect(preflight.preflight).toMatchObject({ add: 0, update: 0 })
    expect(preflight.preflight.conflicts).toEqual([conflict])
    const failed = await server.post('commit', input)
    expect(failed).toMatchObject({ status: 'failed' })
    expect(failed.summary).toEqual({ written: 0, skipped: 0, failed: 1, evidenceRepointed: 0 })
    expect(failed.items).toEqual([conflict])
    expect(await server.source(id)).toEqual(oldSource)
    expect({
      batches: db.select().from(schema.platformExportBatch).all(),
      rows: db.select().from(schema.platformExportRow).all(),
      correspondences: db.select().from(schema.recordCorrespondence).all(),
      audits: db.select().from(schema.recordCorrespondenceAudit).all(),
    }).toEqual(before)
  } finally { await server.close() }
})

it.each([
  { name: 'S392-P01 new SHA accepts added rows', rowCount: 2, sha256: 'synthetic-mixed-v3', written: 3,
    expectedRows: [{ sourceRowNo: 3, rawFields: { original: '  原行🙂\n0  ' } }, { sourceRowNo: 4, rawFields: { original: '  原行🙂\n1  ' } }] },
  { name: 'S392-P02 new SHA accepts an empty row set', rowCount: 0, sha256: 'synthetic-empty-v4', written: 1, expectedRows: [] },
])('$name', async ({ rowCount, sha256, written, expectedRows }) => {
  const { db } = database()
  const server = await api(db)
  try {
    const first = await server.post('commit', request(1, 'snapshot:positive-first'))
    expect(first).toMatchObject({ status: 'committed', error: null, summary: { written: 2, failed: 0 } })
    expect(first.items).toHaveLength(1)
    expect(first.items[0]).toMatchObject({ ok: true, detail: { rowsWritten: 2, skipped: 0 } })
    expect(first.items[0].detail.rows).toHaveLength(1)
    const id = first.items[0].detail.rows[0]
    expect(Number.isSafeInteger(id) && id > 0).toBe(true)
    const oldSource = await server.source(id)
    expect(oldSource.rawFields).toEqual({ original: '  原行🙂\n0  ' })
    const input = request(rowCount, 'snapshot:positive-new')
    input.payload.exportSnapshot!.sha256 = sha256
    expect(input.payload.exportSnapshot!.rows).toEqual(expectedRows)
    expect((await server.post('preflight', input)).preflight).toMatchObject({ add: 1, update: 0, conflicts: [] })
    const committed = await server.post('commit', input)
    expect(committed).toMatchObject({ status: 'committed', error: null, summary: { written, skipped: 0, failed: 0 } })
    expect(committed.items).toHaveLength(1)
    expect(committed.items[0]).toMatchObject({ ok: true, detail: { rowsWritten: written, skipped: 0 } })
    const ids: number[] = committed.items[0].detail.rows
    expect(ids).toHaveLength(rowCount)
    expect(ids.every(rowId => Number.isSafeInteger(rowId) && rowId > 0 && rowId !== id)).toBe(true)
    const sources = await Promise.all(ids.map(rowId => server.source(rowId)))
    expect(sources.map(source => ({ sourceRowNo: source.sourceRowNo, rawFields: source.rawFields }))).toEqual(expectedRows)
    const batches = db.select().from(schema.platformExportBatch).all()
    expect(batches).toHaveLength(2)
    expect(batches[1]).toMatchObject({ sha256, rowCount, replacedBatchId: oldSource.batch.id, importBatchId: committed.batchId })
    expect(db.select().from(schema.platformExportRow).all()).toHaveLength(1 + rowCount)
    expect(await server.source(id)).toEqual(oldSource)
    expect(db.select().from(schema.recordCorrespondence).all()).toEqual([])
    expect(db.select().from(schema.recordCorrespondenceAudit).all()).toEqual([])
  } finally { await server.close() }
})

it('snapshot HTTP versions retain previous history and empty and mixed rows retain their counts', async () => {
  const { db } = database()
  const server = await api(db)
  try {
    const first = await server.post('commit', request(1, 'snapshot:first'))
    expect(first).toMatchObject({ status: 'committed', error: null, summary: { written: 2, skipped: 0, failed: 0 } })
    expect(first.items).toHaveLength(1)
    expect(first.items[0]).toMatchObject({ ok: true, detail: { skipped: 0, rowsWritten: 2 } })
    expect(first.items[0].detail.rows).toHaveLength(1)
    expect(Number.isSafeInteger(first.batchId) && first.batchId > 0).toBe(true)
    expect(Number.isSafeInteger(first.items[0].detail.rows[0]) && first.items[0].detail.rows[0] > 0).toBe(true)
    const oldSource = await server.source(first.items[0].detail.rows[0])
    expect(Number.isSafeInteger(oldSource.batch.id) && oldSource.batch.id > 0).toBe(true)
    expect(oldSource).toEqual({
      id: first.items[0].detail.rows[0], batchId: oldSource.batch.id, sourceRowNo: 3,
      usccRaw: null, nameRaw: null, district: null, province: null, city: null, regStatus: null,
      rawFields: { original: '  原行🙂\n0  ' }, createdAt: expect.any(String), correspondences: [],
      batch: {
        id: oldSource.batch.id, titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19',
        originalFilename: 'synthetic.xlsx', sha256: 'synthetic-v1', rowCount: 1, importStatus: 'imported',
        sourceDocumentId: null, importBatchId: first.batchId, replacedBatchId: null, createdAt: expect.any(String),
      },
    })
    expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(1)
    expect(db.select().from(schema.platformExportRow).all()).toHaveLength(1)
    const newer = request(1, 'snapshot:new-version')
    newer.payload.exportSnapshot!.sha256 = 'synthetic-v2'
    newer.payload.exportSnapshot!.rows[0]!.rawFields = { original: '  新版原行🙂\n0  ' }
    expect((await server.post('preflight', newer)).preflight).toMatchObject({ add: 1, update: 0, conflicts: [] })
    const next = await server.post('commit', newer)
    expect(next).toMatchObject({ status: 'committed', error: null, summary: { skipped: 0, failed: 0 } })
    expect(next.summary.written).toBe(2)
    expect(next.items).toHaveLength(1)
    expect(next.items[0]).toMatchObject({ ok: true, detail: { skipped: 0, rowsWritten: 2 } })
    expect(next.items[0].detail.rows).toHaveLength(1)
    expect(Number.isSafeInteger(next.batchId) && next.batchId > 0).toBe(true)
    expect(Number.isSafeInteger(next.items[0].detail.rows[0]) && next.items[0].detail.rows[0] > 0).toBe(true)
    expect(next.items[0].detail.rows[0]).not.toBe(first.items[0].detail.rows[0])
    const newSource = await server.source(next.items[0].detail.rows[0])
    expect(Number.isSafeInteger(newSource.batch.id) && newSource.batch.id > 0).toBe(true)
    expect(newSource.batch.id).not.toBe(oldSource.batch.id)
    expect(newSource).toEqual({
      id: next.items[0].detail.rows[0], batchId: newSource.batch.id, sourceRowNo: 3,
      usccRaw: null, nameRaw: null, district: null, province: null, city: null, regStatus: null,
      rawFields: { original: '  新版原行🙂\n0  ' }, createdAt: expect.any(String), correspondences: [],
      batch: {
        id: newSource.batch.id, titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19',
        originalFilename: 'synthetic.xlsx', sha256: 'synthetic-v2', rowCount: 1, importStatus: 'imported',
        sourceDocumentId: null, importBatchId: next.batchId, replacedBatchId: oldSource.batch.id, createdAt: expect.any(String),
      },
    })
    expect(newSource.batch.replacedBatchId).toBe(oldSource.batch.id)
    expect(await server.source(first.items[0].detail.rows[0])).toEqual(oldSource)
    expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(2)
    expect(db.select().from(schema.platformExportRow).all()).toHaveLength(2)

    // New symbolic SHAs declare distinct synthetic file contents, not real file hashes.
    const mixed = request(2, 'snapshot:mixed-new')
    mixed.payload.exportSnapshot!.sha256 = 'synthetic-mixed-v3'
    expect(mixed.payload.exportSnapshot!.rows).toEqual([
      { sourceRowNo: 3, rawFields: { original: '  原行🙂\n0  ' } },
      { sourceRowNo: 4, rawFields: { original: '  原行🙂\n1  ' } },
    ])
    expect((await server.post('preflight', mixed)).preflight).toMatchObject({ add: 1, update: 0, conflicts: [] })
    const appended = await server.post('commit', mixed)
    expect(appended).toMatchObject({ status: 'committed', error: null, summary: { written: 3, skipped: 0, failed: 0 } })
    expect(appended.items).toHaveLength(1)
    expect(appended.items[0]).toMatchObject({ ok: true, detail: { skipped: 0, rowsWritten: 3 } })
    const mixedIds: number[] = appended.items[0].detail.rows
    expect(mixedIds).toHaveLength(2)
    expect(new Set(mixedIds).size).toBe(2)
    expect(mixedIds.every(id => Number.isSafeInteger(id) && id > 0 && id !== first.items[0].detail.rows[0] && id !== next.items[0].detail.rows[0])).toBe(true)
    const mixedSources = await Promise.all(mixedIds.map(id => server.source(id)))
    expect(mixedSources.map(source => ({ sourceRowNo: source.sourceRowNo, rawFields: source.rawFields }))).toEqual([
      { sourceRowNo: 3, rawFields: { original: '  原行🙂\n0  ' } },
      { sourceRowNo: 4, rawFields: { original: '  原行🙂\n1  ' } },
    ])
    for (const source of mixedSources) {
      expect(source.batch).toMatchObject({ sha256: 'synthetic-mixed-v3', rowCount: 2, replacedBatchId: newSource.batch.id, importBatchId: appended.batchId })
      expect(source.batchId).toBe(source.batch.id)
    }
    expect(mixedSources[0].batch.id).toBe(mixedSources[1].batch.id)
    expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(3)
    expect(db.select().from(schema.platformExportRow).all()).toHaveLength(4)
    const beforeReuse = {
      batches: db.select().from(schema.platformExportBatch).all(),
      rows: db.select().from(schema.platformExportRow).all(),
    }
    const mixedReuse = { ...mixed, idempotencyKey: 'snapshot:mixed-reuse' }
    expect((await server.post('preflight', mixedReuse)).preflight).toMatchObject({ add: 0, update: 0, conflicts: [] })
    const reused = await server.post('commit', mixedReuse)
    expect(reused).toMatchObject({ status: 'committed', error: null, summary: { written: 0, skipped: 2, failed: 0 } })
    expect(reused.items).toHaveLength(1)
    expect(reused.items[0]).toMatchObject({ ok: true, detail: { skipped: 2, rows: [], rowsWritten: 0 } })
    expect({ batches: db.select().from(schema.platformExportBatch).all(), rows: db.select().from(schema.platformExportRow).all() }).toEqual(beforeReuse)

    const empty = request(0, 'snapshot:empty-new')
    empty.payload.exportSnapshot!.sha256 = 'synthetic-empty-v4'
    expect((await server.post('preflight', empty)).preflight).toMatchObject({ add: 1, update: 0, conflicts: [] })
    const emptied = await server.post('commit', empty)
    expect(emptied).toMatchObject({ status: 'committed', error: null, summary: { written: 1, skipped: 0, failed: 0 } })
    expect(emptied.items).toHaveLength(1)
    expect(emptied.items[0]).toMatchObject({ ok: true, detail: { skipped: 0, rows: [], rowsWritten: 1 } })
    const batches = db.select().from(schema.platformExportBatch).all()
    expect(batches).toHaveLength(4)
    expect(batches[3]).toMatchObject({ sha256: 'synthetic-empty-v4', rowCount: 0, importStatus: 'imported', importBatchId: emptied.batchId, replacedBatchId: mixedSources[0].batch.id })
    expect(db.select().from(schema.platformExportRow).all()).toHaveLength(4)
    // Same key returns the entire first receipt, including its original written:1.
    expect(await server.post('commit', empty)).toEqual(emptied)
    const emptyReuse = { ...empty, idempotencyKey: 'snapshot:empty-reuse' }
    expect((await server.post('preflight', emptyReuse)).preflight).toMatchObject({ add: 0, update: 0, conflicts: [] })
    const reusedEmpty = await server.post('commit', emptyReuse)
    expect(reusedEmpty).toMatchObject({ status: 'committed', error: null, summary: { written: 0, skipped: 0, failed: 0 } })
    expect(reusedEmpty.items).toHaveLength(1)
    expect(reusedEmpty.items[0]).toMatchObject({ ok: true, detail: { skipped: 0, rows: [], rowsWritten: 0 } })
    expect(db.select().from(schema.platformExportBatch).all()).toEqual(batches)
    expect(db.select().from(schema.platformExportRow).all()).toEqual(beforeReuse.rows)
    const invalid = request(2, 'snapshot:invalid')
    invalid.payload.exportSnapshot!.rows[1]!.sourceRowNo = 3
    expect(await server.post('commit', invalid)).toMatchObject({ status: 'failed', summary: { written: 0 }, items: [{ ref: 'export:row:3', error: { code: 'source_row_no_duplicate' } }] })
    expect(db.select().from(schema.platformExportBatch).all()).toEqual(batches)
    expect(db.select().from(schema.platformExportRow).all()).toEqual(beforeReuse.rows)
    expect(await server.source(first.items[0].detail.rows[0])).toEqual(oldSource)
    expect(await server.source(next.items[0].detail.rows[0])).toEqual(newSource)
    expect(await Promise.all(mixedIds.map(id => server.source(id)))).toEqual(mixedSources)
    expect(db.select().from(schema.recordCorrespondence).all()).toEqual([])
    expect(db.select().from(schema.recordCorrespondenceAudit).all()).toEqual([])
  } finally { await server.close() }
})

// Opt-in: this regression deliberately seeds >300MiB of unrelated JSON. Keep it out of daily tests.
it.runIf(process.env.ROSTER_SNAPSHOT_SCALE === '1')('snapshot preflight does not materialize unrelated archived raw fields', async () => {
  const { db } = database()
  const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19', originalFilename: 'synthetic.xlsx', sha256: 'synthetic-v1', rowCount: 1100, importStatus: 'imported' }).returning({ id: schema.platformExportBatch.id }).get()
  const insert = db.$client.prepare('INSERT INTO platform_export_row(batch_id,source_row_no,raw_fields,created_at) VALUES(?,?,?,?)')
  const raw = JSON.stringify({ original: 'x'.repeat(300_000) })
  db.$client.transaction(() => { for (let i = 0; i < 1100; i++) insert.run(batch.id, i + 3, raw, '2026-10-19') })()
  const server = await api(db)
  try {
    const before = process.memoryUsage().heapUsed
    const preflight = await server.post('preflight', request(300))
    const growth = process.memoryUsage().heapUsed - before
    expect(preflight.preflight).toMatchObject({ add: 0, update: 1, conflicts: [] })
    expect(growth).toBeLessThanOrEqual(256 * MiB)
  } finally { await server.close() }
}, 30_000)
