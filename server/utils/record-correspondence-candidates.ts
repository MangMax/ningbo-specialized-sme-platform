import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { RDJB_TITLE_CODES, sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { listRecordCorrespondences } from './record-correspondence'
import { safeCollectionEvidence, sanitizeEvidence } from './record-correspondence-read'

type Db = BetterSQLite3Database<typeof schema>
export interface CandidateInput { eventId?: number; enterpriseId?: number; titleCode?: string; queryIds: number[]; exportBatchIds: number[]; ruleVersion: string; page: number; pageSize: number }
export function generateCandidates(db: Db, input: CandidateInput) {
  const event = input.eventId ? db.select({ event: schema.recordEvent, record: schema.record }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(eq(schema.recordEvent.id, input.eventId)).get() : null
  if (input.eventId && (!event || event.record.source !== 'jxj')) return null
  const enterpriseId = event?.record.enterpriseId ?? input.enterpriseId!
  const titleCode = event?.record.titleCode ?? input.titleCode!
  const enterprise = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, enterpriseId)).get()
  if (!enterprise || !db.select().from(schema.title).where(eq(schema.title.code, titleCode)).get()) return null
  const identity = normalizeUscc(event?.record.usccRaw ?? enterprise.usccNorm)
  const queries = input.queryIds.length ? db.select().from(schema.platformQuery).where(inArray(schema.platformQuery.id, input.queryIds)).all() : []
  const batches = input.exportBatchIds.length ? db.select().from(schema.platformExportBatch).where(inArray(schema.platformExportBatch.id, input.exportBatchIds)).all() : []
  if (queries.length !== new Set(input.queryIds).size || batches.length !== new Set(input.exportBatchIds).size) return null
  const rows: Record<string, unknown>[] = []
  for (const query of queries) {
    if (!['success', 'partial'].includes(query.status)) continue
    const relations = db.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId, query.id)).all()
    for (const relation of relations) {
      const rowTitle = query.interface === 'recognized_list' ? RDJB_TITLE_CODES[sourcePositionForSequence(query.collectionEvidence, relation.sequenceNo).sourceRdjb ?? ''] ?? query.titleCode : query.titleCode ?? RDJB_TITLE_CODES[query.rdjb]
      const rowUscc = normalizeUscc(relation.usccRaw)
      if (!identity || !rowUscc || identity !== rowUscc || rowTitle !== titleCode || (relation.enterpriseId && relation.enterpriseId !== enterpriseId)) continue
      const edge = event ? { type: query.interface === 'recognized_list' ? 'event_recognized' : 'event_process', eventId: event.event.id, relationId: relation.id, role: query.interface === 'recognized_list' ? 'recognized_corrob' : 'context_only' } : query.interface === 'recognized_list' ? null : { type: 'later_process', enterpriseId, titleCode, relationId: relation.id, role: relation.declareKind === 'review' ? 'followup_review' : relation.declareKind === 'update' ? 'followup_update' : 'followup_apply' }
      if (!edge) continue
      const prior = listRecordCorrespondences(db, { relationId: relation.id }).find(r => r.eventId === (event?.event.id ?? null) && r.type === edge.type && r.role === edge.role)
      const conflicts = [] as string[]
      if (event && event.event.year == null) conflicts.push('official_year_missing')
      if (relation.year == null) conflicts.push('platform_year_missing')
      if (event && event.event.batchSeq == null) conflicts.push('official_batch_missing')
      if (event?.event.year != null && relation.year != null && event.event.year !== relation.year) conflicts.push('year_mismatch')
      if (query.interface !== 'recognized_list' && !relation.declareKind) conflicts.push('process_type_unknown')
      if (!relation.awardBatchLabel && !relation.batch) conflicts.push('platform_batch_missing')
      rows.push({ edge, status: 'candidate', ruleId: 'archived-row-exact-identity-title', ruleVersion: input.ruleVersion, evidence: { identity: { enterpriseId, officialUsccRaw: event?.record.usccRaw ?? enterprise.usccNorm, rowUsccRaw: relation.usccRaw }, title: { official: titleCode, row: rowTitle }, temporal: { eventYear: event?.event.year ?? null, eventBatchSeq: event?.event.batchSeq ?? null, relationYear: relation.year, relationBatch: relation.batch, awardBatchLabel: relation.awardBatchLabel }, source: { queryId: query.id, relationId: relation.id, sequenceNo: relation.sequenceNo, queriedAt: query.queriedAt, status: query.status } }, conflicts, existingCorrespondenceId: prior?.id ?? null, revision: prior?.revision ?? null })
    }
  }
  for (const batch of batches) {
    if (!event || batch.importStatus !== 'imported' || batch.titleCode !== titleCode || !identity) continue
    for (const row of db.select().from(schema.platformExportRow).where(eq(schema.platformExportRow.batchId, batch.id)).all()) {
      if (normalizeUscc(row.usccRaw) !== identity) continue
      const edge = { type: 'event_export_context', eventId: event.event.id, exportRowId: row.id, role: 'current_snapshot_context' }
      const prior = listRecordCorrespondences(db, { exportRowId: row.id }).find(r => r.eventId === event.event.id && r.type === edge.type)
      rows.push({ edge, status: 'candidate', ruleId: 'archived-row-exact-identity-title', ruleVersion: input.ruleVersion, evidence: { identity: { enterpriseId, officialUsccRaw: event.record.usccRaw, rowUsccRaw: row.usccRaw }, title: { official: titleCode, row: batch.titleCode }, temporal: { eventYear: event.event.year, exportYear: batch.year, comparability: 'unknown' }, source: { exportBatchId: batch.id, exportRowId: row.id, sourceRowNo: row.sourceRowNo, sha256: batch.sha256, collectedOn: batch.collectedOn } }, conflicts: ['scope_version_not_proven'], existingCorrespondenceId: prior?.id ?? null, revision: prior?.revision ?? null })
    }
  }
  const relationCandidates = rows.filter(row => (row.edge as { type: string }).type !== 'event_export_context')
  if (relationCandidates.length > 1) for (const row of relationCandidates) (row.conflicts as string[]).push('multiple_candidate_rows')
  return { rows: rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: rows.length, page: input.page, pageSize: input.pageSize, coverage: queries.map(({ rawResponse: _rawResponse, collectionEvidence, ...query }) => ({ ...query, collectionEvidence: safeCollectionEvidence(collectionEvidence) })), exportBatches: batches.map(({ id, titleCode, year, collectedOn, sha256 }) => ({ id, titleCode, year, collectedOn, sha256 })) }
}
