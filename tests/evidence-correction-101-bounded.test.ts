import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { handleEvidenceCorrectionRequest } from '../server/utils/roster-evidence-correction-api'
import { startHttpFixture } from './helpers/http-fixture'
import { minimalPdf } from './helpers/minimal-pdf'

it('bounds fixed evidence preflight and history materialization across unrelated source growth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence101-bounded-')), filesDir = join(dir, 'files')
  mkdirSync(filesDir)
  const bytes = minimalPdf({ pages: 3 }); writeFileSync(join(filesDir, 'notice.pdf'), bytes)
  const db = useDb({ dbPath: join(dir, 'isolated.db') })
  db.insert(schema.storedFile).values({ relPath: 'notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), source: 'jxj', kind: 'announcement' }).run()
  const owner = db.insert(schema.enterprise).values({ name: '固定目标', nameNorm: '固定目标' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022 }).returning().get()
  const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'notice.pdf', attachment: '附件1', listNo: 1, page: 1 }).returning().get()
  const before = { coordinate: { sourceFile: 'notice.pdf', page: 1 }, file: { sha256: 'historical-file-identity' } }
  db.transaction(() => { for (let i = 0; i < 210; i++) db.insert(schema.evidenceCorrectionAudit).values({ evidenceId: evidence.id, eventId: event.id, entryPoint: 'legacy_pages', actor: { type: 'legacy', id: 'synthetic-fixture' }, basis: 'synthetic historical fixture', before, after: before, createdAt: '2026-10-19' }).run() })
  // Instrument the real driver's materialized rows; results are never replaced.
  let calls = 0, rows = 0, materializedBytes = 0, rawReads = 0
  const size = (v: unknown): number => typeof v === 'string' ? Buffer.byteLength(v) : typeof v === 'number' ? 8 : v && typeof v === 'object' ? Object.values(v).reduce<number>((n, x) => n + size(x), 0) : 0
  const prepare = db.$client.prepare.bind(db.$client)
  db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    for (const method of ['get', 'all'] as const) {
      const execute = statement[method].bind(statement)
      Object.assign(statement, { [method]: (...params: unknown[]) => { const result = execute(...params); calls++; rows += method === 'all' ? (result as unknown[]).length : result ? 1 : 0; materializedBytes += size(result); if (/raw_response|raw_fields|provenance/.test(args[0])) rawReads++; return result } })
    }
    return statement
  }) as typeof prepare
  const app = await startHttpFixture({ routes: {
    '/point': r => handleEvidenceCorrectionRequest({ ...r, action: 'get', id: evidence.id }, { db }),
    '/audit': r => handleEvidenceCorrectionRequest({ ...r, action: 'audit', id: evidence.id }, { db }),
    '/preflight': r => handleEvidenceCorrectionRequest({ ...r, action: 'preflight' }, { db, filesDir, apiToken: 'synthetic-token' }),
  } })
  const observations: Record<string, unknown>[] = []
  const measure = async (path: string, unrelated: number, body?: unknown) => {
    calls = 0; rows = 0; materializedBytes = 0; rawReads = 0
    const started = performance.now()
    const response = await fetch(app.baseUrl + path, body ? { method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
    expect(response.status).toBe(200)
    const raw = await response.text()
    const measured = { path, unrelated, calls, rows, materializedBytes, rawReads, responseBytes: Buffer.byteLength(raw), milliseconds: performance.now() - started }
    observations.push(measured)
    expect(rawReads).toBe(0)
    expect(rows).toBeLessThanOrEqual(path === '/audit?page=5&pageSize=50' ? 54 : 10)
    expect(materializedBytes).toBeLessThan(64 * 1024)
    return { value: JSON.parse(raw), measured }
  }
  try {
    let baseMetrics: unknown
    for (const unrelated of [0, 200, 1000]) {
      if (unrelated > 0) db.transaction(() => {
        const existing = unrelated === 200 ? 0 : 200
        for (let i = existing; i < unrelated; i++) {
          const otherEvent = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2000 + i }).returning().get()
          db.insert(schema.recordEvidence).values({ recordEventId: otherEvent.id, sourceFile: 'unrelated/' + i + '.pdf', listNo: 1, page: 1 }).run()
          const q = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'unrelated-' + i, rdjb: '2', queriedAt: '2026-10-19', status: 'success', rawResponse: 'raw-sentinel'.repeat(1024) }).returning().get()
          const relation = db.insert(schema.platformRelation).values({ queryId: q.id, sequenceNo: 1, rawFields: { rawSentinel: 'raw-sentinel'.repeat(1024) } }).returning({ id: schema.platformRelation.id }).get()
          db.insert(schema.recordCorrespondence).values({ edgeKey: 'unrelated-' + i, type: 'event_process', role: 'context_only', eventId: otherEvent.id, predecessorEventId: otherEvent.id, relationId: relation.id, titleCode: 'specialized_sme', status: 'candidate', revision: 1, targetIdentity: {}, provenance: { rawSentinel: 'raw-sentinel'.repeat(1024) }, sourceFingerprint: 'synthetic', ruleId: 'manual', ruleVersion: '1', createdAt: '2026-10-19' }).run()
        }
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
    if (process.env.TICKET101_METRICS) writeFileSync(process.env.TICKET101_METRICS, JSON.stringify({ sourceSha: process.env.TICKET101_SOURCE_SHA ?? 'uncommitted candidate', unrelatedRawBytesPerRow: 36900, observations, impactExplain: db.$client.prepare('EXPLAIN QUERY PLAN SELECT count(*) FROM record_correspondence WHERE event_id = ? OR predecessor_event_id = ?').all(event.id, event.id), coordinateExplain: db.$client.prepare('EXPLAIN QUERY PLAN SELECT id FROM record_evidence WHERE source_file = ? AND list_no = ?').all('notice.pdf', 1) }, null, 2))
    console.info('TICKET101_DRIVER_MATERIALIZATION ' + JSON.stringify(observations))
    console.info('TICKET101_COORDINATE_EXPLAIN ' + JSON.stringify(db.$client.prepare('EXPLAIN QUERY PLAN SELECT id FROM record_evidence WHERE source_file = ? AND list_no = ?').all('notice.pdf', 1)))
  } finally { await app.close(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
}, 30000)
