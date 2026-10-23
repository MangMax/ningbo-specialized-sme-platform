// Separate, intentionally hydrated writer/oracle lane. No candidate implementation.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { useDb } from '../../../db/client'
import { preflightRosterImport, commitRosterImport } from '../../../server/utils/roster-import'
import { recognizedResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
it('current importer canonicalizes JSON and records its existing deep-source commit refusal', () => {
  const out = process.env.SPIKE_WRITER_OUT!
  const db = useDb({ dbPath: join(out, 'writer-synthetic.db') })
  const texts = [
    ['escaped-unicode','{"s":"\\u0061"}'], ['integer-key-order','{"10":1,"2":2}'],
    ['duplicate-key','{"x":1,"x":2}'], ['number-spelling','{"n":1.0,"e":1e+02,"z":-0}'],
    ['integer-rounding','{"n":9007199254740993}'], ['surrogate','{"s":"\\uD800"}'],
    ['deep-1001','{"nested":'+'['.repeat(1001)+'0'+']'.repeat(1001)+'}'],
  ]
  const report: unknown[] = []
  try {
    for (const [name, text] of texts) {
      const input = JSON.parse(text!)
      const request = { idempotencyKey: `222/${name}`, sourceKind: 'alias_evidence' as const, sourceIdentity: 'synthetic/222',
        payload: { platformQueries: [{ interface: 'business_list' as const, queryKey: `synthetic/${name}`, rdjb: '2',
          queriedAt: '2026-10-23T00:00:00.000Z', status: 'success' as const, relations: [{ sequenceNo: 1, rawFields: input }] }] } }
      expect(preflightRosterImport(db, request).preflight.conflicts).toEqual([])
      const result = commitRosterImport(db, request)
      if (name === 'deep-1001') {
        // Observed baseline behavior, not an approved input exclusion or a fix.
        // The first research expectation of success failed; retain that original log.
        expect(result.status).toBe('failed')
        expect(result.error).toContain('malformed JSON')
        expect(db.$client.prepare('select count(*) n from platform_query where query_key=?').get(`synthetic/${name}`)).toEqual({ n: 0 })
        report.push({ name, preflightConflicts: 0, commitStatus: result.status, error: result.error, rolledBack: true })
        continue
      }
      expect(result.status).toBe('committed')
      const stored = db.$client.prepare('select r.raw_fields body from platform_relation r join platform_query q on q.id=r.query_id where q.query_key=?').get(`synthetic/${name}`) as { body: string }
      expect(stored.body).toBe(JSON.stringify(input))
      expect(JSON.stringify(JSON.parse(stored.body))).toBe(stored.body)
      report.push({ name, bytes: Buffer.byteLength(stored.body), sha256: sha(stored.body), fixedPoint: true })
    }
    const evidence: PlatformLiveQueryResult = {
      source: 'queryBusList', status: 'success', effectiveConditions: { uscc: '91330211255994457P', combination: 'and' },
      titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-23T00:00:00.000Z', completedAt: '2026-10-23T00:01:00.000Z',
      rows: [{ id: 'synthetic-row', qymc: '合成企业', tyshxydm: '91330211255994457P', '10': 'ten', '2': 'two', original: '\ud800\0中文😀' }],
      pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
      fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
    }
    const request = { idempotencyKey: '222/recognized', sourceKind: 'alias_evidence' as const, sourceIdentity: 'synthetic/222', payload: { platformQueries: [recognizedResultToImport(evidence)] } }
    expect(preflightRosterImport(db, request).preflight.conflicts).toEqual([])
    expect(commitRosterImport(db, request).status).toBe('committed')
    const stored = db.$client.prepare("select collection_evidence body from platform_query where interface='recognized_list'").get() as { body: string }
    expect(stored.body).toBe(JSON.stringify(evidence))
    report.push({ name: 'recognized-collection', bytes: Buffer.byteLength(stored.body), sha256: sha(stored.body), fixedPoint: JSON.stringify(JSON.parse(stored.body)) === stored.body })
    writeFileSync(join(out, 'writer.json'), JSON.stringify(report, null, 2))
  } finally { db.$client.close() }
})
