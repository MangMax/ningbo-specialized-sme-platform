import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { expect, it } from 'vitest'
import { initializeDb } from '../../../db/client'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { getPostgresPlatformBatch, getPostgresPlatformBatchItem } from '../../../layers/sme-roster/server/utils/platform-batch-query-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
const batchId = '01J00000000000000000000001'
const itemId = '01J00000000000000000000002'
const emptyItemId = '01J00000000000000000000003'
const limits = { maxRequests: 3, maxRows: 10, maxDurationMs: 5000, maxResultBytes: 65536 }
const params = JSON.stringify({ limits, items: [{ itemId }, { itemId: emptyItemId }] })
const now = '2026-11-22T12:00:00Z'
const unfinished = [{ source: 'queryList', rdjb: null, page: 3 }]
const failure = { code: 'upstream_failed', message: '平台请求失败，未完成查询。' }
const firstBusinessRow = String.raw`{"id":"row-one","qymc":"字面\\u0000、空字符\u0000、保留项\ud800、原转义\u005cu","cszt":"已认定","sqsj":"2026-01-02","year":"2026","\\u0000":"literal","\u0000":"NUL key"}`
const firstTypedRow = firstBusinessRow.replace('"year":"2026"', '"year":2026')
const firstPage = { source: 'queryList', rdjb: null, page: 1, status: 'success', fetchedCount: 1, declaredTotal: 3, error: null }
const firstTime = '2026-11-21T12:00:00Z'
const originalBusinessRow = firstBusinessRow.slice(0, -1) + ',"rawFields":"original row snapshot","rawResponse":"original row bytes"}'
const originalTypedRow = firstTypedRow.slice(0, -1) + ',"rawFields":{"legacy":true},"rawResponse":"original row bytes"}'
const rawData = JSON.stringify({ version: 1, rows: [], pages: [{ source: 'queryList', rdjb: null, page: 1, format: 'json', body: 'original upstream body' }] })
const firstSegment = '{"queriedAt":' + JSON.stringify(firstTime) + ',"rows":[' + originalBusinessRow + '],"pages":['
  + JSON.stringify(firstPage) + '],"rawData":' + rawData.replace('"rows":[]', '"rows":[' + originalTypedRow + ']')
  + ',"rawFields":{"extra":true},"error":null}'
const firstStructuredSegment = {
  queriedAt: firstTime, rows: [JSON.parse(firstBusinessRow)], dataRows: [JSON.parse(firstTypedRow)], pages: [firstPage], error: null,
}
const secondSegment = JSON.stringify({
  queriedAt: now, rows: [{ qymc: '保留第二页' }],
  pages: [
    { source: 'queryList', rdjb: null, page: 2, status: 'success', fetchedCount: 1, declaredTotal: 3, error: null },
    { source: 'queryList', rdjb: null, page: 3, status: 'failed', fetchedCount: 0, declaredTotal: null, error: failure },
  ],
  error: failure,
})
const item = { itemId, status: 'partial', completeness: 'partial', unfinished }
const emptyItem = { itemId: emptyItemId, status: 'not_queried', completeness: 'not_queried', unfinished: [] }
const result = `{"attempt":2,"usage":{"requests":2,"rows":2},"completeness":"partial","limits":${JSON.stringify(limits)},"items":[${JSON.stringify(item).slice(0, -1)},"segments":[${firstSegment},${secondSegment}]},${JSON.stringify({ ...emptyItem, segments: [] })}]}`
const records = [batchId, 'platform-query-batch', params, 'failed', result, now]

type Runtime = Awaited<ReturnType<typeof postgresRuntimeFixture>>

function seedLegacySQLite(sourcePath: string) {
  const db = initializeDb({ create: true, dbPath: sourcePath })
  try {
    installLeadListSchema(db.$client)
    db.$client.prepare('INSERT INTO job (id, kind, params, state, result, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(...records)
  } finally {
    db.$client.close()
  }
}

async function assertCompactBatch(client: pg.Client) {
  const { rows: [job] } = await client.query('SELECT result FROM business.job WHERE id = $1', [batchId])
  expect(JSON.parse(job.result)).toEqual({
    attempt: 2, completeness: 'partial', usage: { requests: 2, rows: 2 }, limits, items: [
      { ...item, error: failure }, { ...emptyItem, error: null },
    ],
  })
  const preserved = await client.query(
    'SELECT payload FROM business.platform_batch_segment WHERE job_id = $1 ORDER BY segment_index', [batchId],
  )
  expect(preserved.rows.map(row => JSON.parse(row.payload))).toEqual([firstStructuredSegment, JSON.parse(secondSegment)])
  expect(preserved.rows[1].payload).toBe(secondSegment)
  const db = drizzle({ client })
  const batch = await getPostgresPlatformBatch(db, { batchId })
  expect(batch).toMatchObject({ batchId, itemIds: [itemId, emptyItemId], state: 'failed', attempt: 2 })
  expect(batch.items).toEqual([
    { ...item, segments: [firstStructuredSegment, JSON.parse(secondSegment)] },
    { ...emptyItem, segments: [] },
  ])
  expect(await getPostgresPlatformBatchItem(db, { batchId, itemId })).toEqual(batch.items[0])
}

it.skipIf(!bin).each(['PostgreSQL', 'already separated PostgreSQL', 'SQLite'] as const)(
  'retains batch business rows and continuation metadata while removing transport material from %s',
  async source => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-platform-batch-migration-'))
    const sourcePath = join(dir, 'source.db')
    let runtime: Runtime | undefined
    let client: pg.Client | undefined
    try {
      if (source === 'SQLite') seedLegacySQLite(sourcePath)
      runtime = await postgresRuntimeFixture({ dir, ...(source === 'SQLite' ? { sourcePath } : {}) })
      client = new pg.Client({ connectionString: runtime.url })
      await client.connect()

      if (source !== 'SQLite') {
        if (source === 'PostgreSQL') await client.query('DROP TABLE business.platform_batch_segment')
        await client.query('INSERT INTO business.job (id, kind, params, state, result, created_at) VALUES ($1,$2,$3,$4,$5,$6)', records)
        if (source === 'already separated PostgreSQL') {
          runtime.psql(['-f', 'upgrade/postgresql/split-platform-batch-results.sql'])
          expect((await client.query('SELECT payload FROM business.platform_batch_segment WHERE segment_index = 0')).rows)
            .toEqual([{ payload: firstSegment }])
        }
        runtime.psql(['-f', 'upgrade/postgresql/compact-platform-batch-results.sql'])
        await assertCompactBatch(client)
        runtime.psql(['-f', 'upgrade/postgresql/compact-platform-batch-results.sql'])
      }

      await assertCompactBatch(client)
      await client.query('DELETE FROM business.job WHERE id = $1', [batchId])
      expect((await client.query('SELECT payload FROM business.platform_batch_segment')).rows).toEqual([])
    } finally {
      await client?.end()
      runtime?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  20_000,
)
