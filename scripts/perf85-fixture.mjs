#!/usr/bin/env node
// #85: synthetic input only. All writes stay in a newly created private SQLite file.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { useDb, schema: s } = await jiti.import('../db/client.ts')

export function createFixture(scale = 1) {
  assert.ok([1, 2, 5].includes(scale), 'scale must be 1, 2 or 5')
  const dir = mkdtempSync(join(tmpdir(), 'perf85-synthetic-'))
  const dbPath = join(dir, 'roster.db')
  const db = useDb({ dbPath })
  assert.equal(db.$client.prepare('select count(*) n from record_correspondence').get().n, 0)
  const targetCount = 120
  const unrelatedCount = 120 * scale
  const original = 'SYNTHETIC_SOURCE_'.repeat(2048)
  const provenance = 'SYNTHETIC_PROVENANCE_'.repeat(1536)
  const auditBody = 'SYNTHETIC_AUDIT_'.repeat(2048)
  const rawQuery = 'SYNTHETIC_ARCHIVE_'.repeat(4096)
  const enterprise = db.insert(s.enterprise).values({ name: 'PERF85_TARGET', nameNorm: 'PERF85_TARGET', usccNorm: 'PERF85TARGET' }).returning().get()
  const other = db.insert(s.enterprise).values({ name: 'PERF85_UNRELATED', nameNorm: 'PERF85_UNRELATED', usccNorm: 'PERF85OTHER' }).returning().get()
  const records = [enterprise, other].map(e => db.insert(s.record).values({ enterpriseId: e.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: e.usccNorm }).returning().get())
  const batch = db.insert(s.importBatch).values({ idempotencyKey: 'perf85-fixture', sourceKind: 'correspondence_decision', sourceIdentity: 'synthetic/perf85', status: 'committed' }).returning().get()
  const ids = []
  let exportEdge
  const add = (index, selected) => {
    const owner = selected ? enterprise : other
    const record = records[selected ? 0 : 1]
    const event = db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022, decidedYear: 2022 }).returning().get()
    db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: `synthetic/perf85/${index}.pdf`, page: index + 1 }).run()
    const query = db.insert(s.platformQuery).values({ interface: 'business_list', queryKey: `${owner.usccNorm}-${index}`, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-20T00:00:00Z', status: 'partial', rawResponse: rawQuery, collectionEvidence: { source: 'synthetic', status: 'partial', rows: [{ original: rawQuery }], pages: [{ rdjb: '2', page: 1, fetchedCount: 1, status: 'success' }] } }).returning().get()
    const relation = db.insert(s.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: owner.id, usccRaw: owner.usccNorm, rawFields: { original, index }, sourceText: `SYNTHETIC_SOURCE_${index}`, declareKind: 'apply', year: 2022, matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
    const status = selected && index === 0 ? 'confirmed' : selected && index % 23 === 0 ? 'rejected' : selected && index % 29 === 0 ? 'unlinked' : 'candidate'
    const row = db.insert(s.recordCorrespondence).values({ edgeKey: `perf85-${selected ? 'selected' : 'unrelated'}-${index}`, type: 'event_process', role: 'context_only', eventId: event.id, relationId: relation.id, enterpriseId: owner.id, titleCode: 'specialized_sme', status, revision: status === 'candidate' ? 1 : 2, targetIdentity: { synthetic: true }, provenance: { original: provenance, synthetic: true }, sourceFingerprint: 'intentionally-stale-synthetic-fingerprint', ruleId: 'perf85', ruleVersion: 'v1', createdAt: '2026-10-20T00:00:00Z', decidedAt: status === 'candidate' ? null : '2026-10-20T01:00:00Z' }).returning().get()
    db.insert(s.recordCorrespondenceAudit).values({ correspondenceId: row.id, batchId: batch.id, idempotencyKey: `perf85-audit-${row.id}`, fromStatus: null, toStatus: status, expectedRevision: 0, resultingRevision: row.revision, actorType: 'agent', actorId: 'synthetic', basis: 'synthetic benchmark fixture', ruleId: 'perf85', ruleVersion: 'v1', evidence: { original: auditBody }, decidedAt: '2026-10-20T01:00:00Z' }).run()
    if (selected) ids.push({ id: row.id, eventId: event.id, relationId: relation.id, status, revision: row.revision })
  }
  db.transaction(() => {
    for (let i = 0; i < targetCount; i++) add(i, true)
    const exportBatch = db.insert(s.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: 'synthetic-perf85.xlsx', sha256: 'synthetic-perf85', rowCount: 1, importStatus: 'imported' }).returning().get()
    const exportRow = db.insert(s.platformExportRow).values({ batchId: exportBatch.id, sourceRowNo: 1, usccRaw: enterprise.usccNorm, nameRaw: enterprise.name, rawFields: { original } }).returning().get()
    const edge = db.insert(s.recordCorrespondence).values({ edgeKey: 'perf85-export-context', type: 'event_export_context', role: 'current_snapshot_context', eventId: ids[0].eventId, exportRowId: exportRow.id, enterpriseId: enterprise.id, titleCode: 'specialized_sme', status: 'candidate', revision: 1, targetIdentity: { synthetic: true }, provenance: { original: provenance }, sourceFingerprint: 'synthetic-export-fingerprint', ruleId: 'perf85', ruleVersion: 'v1', createdAt: '2026-10-20T00:00:00Z' }).returning().get()
    exportEdge = { id: edge.id, eventId: ids[0].eventId, exportRowId: exportRow.id }
    for (let i = 0; i < unrelatedCount; i++) add(i, false)
  })
  const counts = Object.fromEntries(['enterprise', 'record_event', 'record_evidence', 'platform_query', 'platform_relation', 'record_correspondence', 'record_correspondence_audit'].map(table => [table, db.$client.prepare(`select count(*) n from ${table}`).get().n]))
  const manifest = { synthetic: true, scale, targetEnterpriseId: enterprise.id, targetCount, unrelatedCount, counts, ids, exportEdge, filters: { enterpriseId: enterprise.id, titleCode: 'specialized_sme', type: 'event_process', role: 'context_only', ruleVersion: 'v1' }, dbPath }
  db.$client.pragma('wal_checkpoint(TRUNCATE)')
  db.$client.close()
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { ...manifest, dir, manifestPath: join(dir, 'manifest.json') }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const scale = Number(process.argv[2] ?? 1)
  const fixture = createFixture(scale)
  console.log(JSON.stringify({ dbPath: fixture.dbPath, manifestPath: fixture.manifestPath, counts: fixture.counts, synthetic: true, scale }))
}
