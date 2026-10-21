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
    expect((await server.post('preflight', otherKey)).preflight).toMatchObject({ add: 0, update: 1, conflicts: [] })
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

it('snapshot HTTP versions retain previous history and empty and mixed rows retain their counts', async () => {
  const { db } = database()
  const server = await api(db)
  try {
    const first = await server.post('commit', request(1, 'snapshot:first'))
    const mixed = request(2, 'snapshot:mixed')
    const appended = await server.post('commit', mixed)
    expect(appended.items[0].detail).toMatchObject({ skipped: 1, rowsWritten: 1 })
    const oldSource = await server.source(first.items[0].detail.rows[0])
    const newer = request(1, 'snapshot:new-version')
    newer.payload.exportSnapshot!.sha256 = 'synthetic-v2'
    const next = await server.post('commit', newer)
    expect(next.summary.written).toBe(2)
    const newSource = await server.source(next.items[0].detail.rows[0])
    expect(newSource.batch.replacedBatchId).toBe(oldSource.batch.id)
    expect(await server.source(first.items[0].detail.rows[0])).toEqual(oldSource)
    const empty = request(0, 'snapshot:empty')
    expect((await server.post('preflight', empty)).preflight).toMatchObject({ add: 0, update: 1, conflicts: [] })
    expect(await server.post('commit', empty)).toMatchObject({ summary: { written: 0 }, items: [{ detail: { skipped: 0, rows: [], rowsWritten: 0 } }] })
    const invalid = request(2, 'snapshot:invalid')
    invalid.payload.exportSnapshot!.rows[1]!.sourceRowNo = 3
    expect(await server.post('commit', invalid)).toMatchObject({ status: 'failed', summary: { written: 0 }, items: [{ ref: 'export:row:3', error: { code: 'source_row_no_duplicate' } }] })
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
