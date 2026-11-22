import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it } from 'vitest'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
const now = '2026-11-22T12:00:00Z'
const bodies = [
  [1, 1, String.raw`{"metadata":"\\u0000 \u0000 \ud800","pay\u006coad":{"platformRecordObservations":null}}`, null],
  [2, 1, '', 1],
  [3, 1, '{"payload":{"platformRecordObservations":[]},"payload":{"other":[]}}', null],
  [4, 1, '{"payload":null}', null],
  [5, 1, '', null],
  [6, 2, '{"payload":{"platformRecordObservations":[]}}', null],
] as const
const batches = [[1, 'platform_archive'], [2, 'announcement']] as const
const summary = '{ "written" : 0, "failed" : 1 }'
const items = '[{"ok":false,"ref":"合成：🧾"}]'
type Runtime = Awaited<ReturnType<typeof postgresRuntimeFixture>>

async function seedLegacyPostgreSQL(runtime: Runtime) {
  const client = new pg.Client({ connectionString: runtime.url })
  await client.connect()
  try {
    await client.query(`ALTER TABLE business.import_receipt
      DROP COLUMN historical_projection,
      ADD COLUMN request_body text NOT NULL,
      ADD COLUMN body_receipt_id bigint REFERENCES business.import_receipt(id)`)
    await client.query(`CREATE INDEX import_receipt_body_owner_idx
      ON business.import_receipt (batch_id, request_hash, id) WHERE body_receipt_id IS NULL`)
    for (const [id, kind] of batches) {
      await client.query(`INSERT INTO business.import_batch
        (id, idempotency_key, source_kind, source_identity, status, created_at) VALUES ($1, $2, $3, 'fixture', 'failed', $4)`,
      [id, 'fixture-key-' + id, kind, now])
    }
    for (const [id, batchId, body, owner] of bodies) {
      await client.query(`INSERT INTO business.import_receipt
        (id, batch_id, operation, request_hash, request_body, status, summary, item_results, created_at, completed_at, body_receipt_id)
        VALUES ($1, $2, 'commit', $3, $4, 'failed', $5, $6, $7, $7, $8)`,
      [id, batchId, 'frozen-' + (owner ?? id), body, summary, items, now, owner])
    }
  } finally {
    await client.end()
  }
}

function assertCompactReceipts(runtime: Runtime) {
  const psql = (sql: string) => runtime.psql(['-At', '-c', sql]).trim()
  expect(psql(`SELECT column_name FROM information_schema.columns WHERE table_schema='business'
    AND table_name='import_receipt' AND column_name IN ('request_body','body_receipt_id','historical_projection')`))
    .toBe('historical_projection')
  expect(psql("SELECT to_regclass('business.import_receipt_body_owner_idx') IS NULL")).toBe('t')
  const results = psql(`SELECT row_to_json(result) FROM (
    SELECT r.id::int, b.idempotency_key, r.request_hash, r.historical_projection, r.summary, r.item_results,
      r.status, r.operation, r.created_at, r.completed_at
    FROM business.import_receipt r JOIN business.import_batch b ON b.id=r.batch_id ORDER BY r.id
  ) result`).split('\n').map(line => JSON.parse(line))
  expect(results).toEqual(bodies.map(([id, batchId, , owner]) => ({
    id, idempotency_key: 'fixture-key-' + batchId, request_hash: 'frozen-' + (owner ?? id),
    historical_projection: id === 1 || id === 2, summary, item_results: items, status: 'failed', operation: 'commit',
    created_at: now, completed_at: now,
  })))
}

it.skipIf(!bin)('compacts legacy receipt bodies and resolves historical body owners on PostgreSQL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-receipt-upgrade-'))
  let runtime: Runtime | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    await seedLegacyPostgreSQL(runtime)
    runtime.psql(['-f', 'upgrade/pg/2026-11-data-compaction/steps/12-compact-import-receipts.sql'])
    assertCompactReceipts(runtime)
    runtime.psql(['-f', 'upgrade/pg/2026-11-data-compaction/steps/12-compact-import-receipts.sql'])
    assertCompactReceipts(runtime)
  } finally {
    runtime?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)
