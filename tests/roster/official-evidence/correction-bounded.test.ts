import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { singlePostgresFixtureRow, useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { handlePostgresOfficialEvidenceRead } from '../../../layers/sme-roster/server/utils/official-evidence-read-postgres'
import { handlePostgresEvidenceCorrectionWrite } from '../../../layers/sme-roster/server/utils/roster-evidence-correction-write-postgres'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record as recordTable, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { storedFile } from '../../../db/postgresql/file-tables'
import { rosterFileClassification } from '../../../db/postgresql/roster-file-tables'
import { evidenceCorrectionAudit } from '../../../db/postgresql/official-evidence-tables'
import pg from 'pg'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startHttpFixture } from '../../support/http'
import { minimalPdf } from '../../support/minimal-pdf'

const createDatabase = useIsolatedPostgresCases()

it('bounds fixed evidence preflight and history materialization across unrelated source growth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence101-bounded-')), filesDir = join(dir, 'files')
  mkdirSync(filesDir)
  const bytes = minimalPdf({ pages: 3 }); writeFileSync(join(filesDir, 'notice.pdf'), bytes)
  const db = createDatabase()
  const file = singlePostgresFixtureRow(await db.insert(storedFile).values({
    relPath: 'notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: BigInt(Buffer.byteLength(bytes)),
    sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: '2026-10-19',
  }).returning())
  await db.insert(rosterFileClassification).values({ fileId: file.id, source: 'jxj', kind: 'announcement' })
  const owner = singlePostgresFixtureRow(await db.insert(enterprise).values({ name: '固定目标', nameNorm: '固定目标' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(recordTable).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', source: 'jxj' }).returning())
  const event = singlePostgresFixtureRow(await db.insert(recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022 }).returning())
  const evidence = singlePostgresFixtureRow(await db.insert(recordEvidence).values({ recordEventId: event.id, sourceFile: 'notice.pdf', attachment: '附件1', listNo: 1, page: 1 }).returning())
  const before = JSON.stringify({ coordinate: { sourceFile: 'notice.pdf', page: 1 }, file: { sha256: 'historical-file-identity' } })
  await db.insert(evidenceCorrectionAudit).values(Array.from({ length: 210 }, () => ({
    evidenceId: evidence.id, eventId: event.id, entryPoint: 'legacy_pages' as const,
    actor: JSON.stringify({ type: 'legacy', id: 'synthetic-fixture' }), basis: 'synthetic historical fixture',
    before, after: before, createdAt: '2026-10-19',
  })))
  await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: 'unrelated-source', rdjb: '2',
    queriedAt: '2026-10-19', status: 'success', rawResponse: 'raw-sentinel'.repeat(1024),
    relations: [{ sequenceNo: 1, rawFields: { rawSentinel: 'raw-sentinel'.repeat(1024) } }] })
  const reader = usePostgresDirectoryDb()
  // Use the driver result to measure actual rows returned, across all connections.
  let calls = 0, rows = 0, materializedBytes = 0, rawReads = 0
  const query = pg.Client.prototype.query
  const observe = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const result = Reflect.apply(query, this, args)
    if (result instanceof Promise) {
      return result.then((output: pg.QueryResult) => {
        const input = args[0] as string | pg.QueryConfig
        const statement = typeof input === 'string' ? input : input.text
        if (!/^\s*(select|with)\b/i.test(statement)) return output
        calls++
        rows += output.rows.length
        const materialized = JSON.stringify(output.rows)
        materializedBytes += Buffer.byteLength(materialized)
        if (/raw_response|raw_fields|provenance/.test(statement) || materialized.includes('raw-sentinel')) rawReads++
        return output
      })
    }
    return result
  } as typeof query)
  const app = await startHttpFixture({ routes: {
    '/point': r => handlePostgresOfficialEvidenceRead({ ...r, kind: 'evidence', action: 'get', id: evidence.id }, { db: reader }),
    '/audit': r => handlePostgresOfficialEvidenceRead({ ...r, kind: 'evidence', action: 'audit', id: evidence.id }, { db: reader }),
    '/preflight': r => handlePostgresEvidenceCorrectionWrite({ ...r, action: 'preflight' }, { filesDir, apiToken: 'synthetic-token' }),
  } })
  // Establish the connection before measuring the first point request.
  await reader.$client.query('SELECT 1')
  const observations: Record<string, unknown>[] = []
  const measure = async (path: string, unrelated: number, body?: unknown) => {
    calls = 0; rows = 0; materializedBytes = 0; rawReads = 0
    const started = performance.now()
    const response = await fetch(app.baseUrl + path, body ? { method: 'POST', headers: { connection: 'close', authorization: 'Bearer synthetic-token', 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { connection: 'close' } })
    expect(response.status).toBe(200)
    const raw = await response.text()
    const measured = { path, unrelated, calls, rows, materializedBytes, rawReads, responseBytes: Buffer.byteLength(raw), milliseconds: performance.now() - started }
    observations.push(measured)
    expect(calls).toBeGreaterThan(0)
    expect(rows).toBeGreaterThan(0)
    expect(rawReads).toBe(0)
    expect(rows).toBeLessThanOrEqual(path === '/audit?page=5&pageSize=50' ? 54 : 10)
    expect(materializedBytes).toBeLessThan(64 * 1024)
    return { value: JSON.parse(raw), measured }
  }
  try {
    let baseMetrics: unknown
    for (const unrelated of [0, 200, 1000]) {
      if (unrelated > 0) await db.transaction(async tx => {
        const existing = unrelated === 200 ? 0 : 200
        const otherEvents = await tx.insert(recordEvent).values(Array.from({ length: unrelated - existing }, (_, i) => ({
          recordId: record.id, eventType: 'award' as const, year: 2000 + existing + i,
        }))).returning({ id: recordEvent.id })
        await tx.insert(recordEvidence).values(otherEvents.map((row, i) => ({
          recordEventId: row.id, sourceFile: 'unrelated/' + (existing + i) + '.pdf', listNo: 1, page: 1,
        })))
      })
      const point = await measure('/point', unrelated)
      const req = { idempotencyKey: 'bounded', actor: { type: 'agent', id: 'synthetic' }, basis: 'explicit verified source', operations: [{ evidenceId: evidence.id, eventId: event.id, recordId: record.id, enterpriseId: owner.id, expectedVersion: point.value.version, coordinate: { sourceFile: 'notice.pdf', attachment: '附件1', listNo: 1, page: 2 } }] }
      await measure('/preflight', unrelated, req)
      const audit = await measure('/audit?page=5&pageSize=50', unrelated)
      expect(audit.value).toMatchObject({ total: 210, page: 5, rows: Array.from({ length: 10 }, () => expect.objectContaining({ evidenceId: evidence.id })) })
      const stable = observations.slice(-3).map(({ calls, rows, materializedBytes, rawReads, responseBytes }) => ({ calls, rows, materializedBytes, rawReads, responseBytes }))
      if (baseMetrics) expect(stable).toEqual(baseMetrics)
      else baseMetrics = stable
    }

    console.info('TICKET101_DRIVER_MATERIALIZATION ' + JSON.stringify(observations))
    const plan = await db.$client.query("EXPLAIN (FORMAT JSON) SELECT id FROM record_evidence WHERE source_file = $1 AND list_no = $2", ['notice.pdf', 1])
    console.info('TICKET101_COORDINATE_EXPLAIN ' + JSON.stringify(plan.rows))
  } finally { await app.close(); observe.mockRestore(); rmSync(dir, { recursive: true, force: true }) }
}, 30000)
