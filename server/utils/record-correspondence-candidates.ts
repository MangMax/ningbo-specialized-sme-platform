import { asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { RDJB_TITLE_CODES, sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { safeCollectionEvidence } from './record-correspondence-read'
import { normalizePlatformRelation, PLATFORM_PROCESS_RAW_KEYS } from '../../lib/platform/normalization'

type Db = BetterSQLite3Database<typeof schema>
export interface CandidateInput { eventId?: number; enterpriseId?: number; titleCode?: string; queryIds: number[]; exportBatchIds: number[]; ruleVersion: string; page: number; pageSize: number }
/** Keep SQLite parameter lists bounded, preserving historical ID ordering and duplicate-ID semantics. */
function batchesOf(ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  return Array.from({ length: Math.ceil(sorted.length / 400) }, (_, i) => sorted.slice(i * 400, (i + 1) * 400))
}
export function generateCandidates(db: Db, input: CandidateInput) {
  const event = input.eventId ? db.select({ event: schema.recordEvent, record: schema.record }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(eq(schema.recordEvent.id, input.eventId)).get() : null
  if (input.eventId && (!event || event.record.source !== 'jxj')) return null
  const enterpriseId = event?.record.enterpriseId ?? input.enterpriseId!
  const titleCode = event?.record.titleCode ?? input.titleCode!
  const enterprise = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, enterpriseId)).get()
  if (!enterprise || !db.select().from(schema.title).where(eq(schema.title.code, titleCode)).get()) return null
  const identity = normalizeUscc(event?.record.usccRaw ?? enterprise.usccNorm)
  const { rawResponse: _rawResponse, collectionEvidence, ...queryColumns } = getTableColumns(schema.platformQuery)
  // These public candidates never expose raw_response or archived row arrays.
  const queries = batchesOf(input.queryIds).flatMap(ids => db.select({ ...queryColumns, collectionEvidence: sql`json_remove(${collectionEvidence}, '$.rows')`.mapWith(collectionEvidence) }).from(schema.platformQuery).where(inArray(schema.platformQuery.id, ids)).orderBy(asc(schema.platformQuery.id)).all())
  const batches = batchesOf(input.exportBatchIds).flatMap(ids => db.select().from(schema.platformExportBatch).where(inArray(schema.platformExportBatch.id, ids)).orderBy(asc(schema.platformExportBatch.id)).all())
  if (queries.length !== new Set(input.queryIds).size || batches.length !== new Set(input.exportBatchIds).size) return null
  const r = schema.platformRelation, x = schema.platformExportRow, c = schema.recordCorrespondence
  // Extract only process facts in SQLite; the full archived row can be arbitrarily large.
  // -> plus json() preserves JSON types (notably true must not become year=1).
  const processRaw = sql`case when json_valid(${r.rawFields}) then json_object(${sql.join(PLATFORM_PROCESS_RAW_KEYS.flatMap(key => [sql`${key}`, sql`json(${r.rawFields} -> ${`$.${key}`})`]), sql`, `)}) else null end`.mapWith(r.rawFields)
  const queriesById = new Map(queries.map(q => [q.id, q]))
  const relations = batchesOf(queries.filter(q => ['success', 'partial'].includes(q.status)).map(q => q.id)).flatMap(ids => db.select({ id: r.id, queryId: r.queryId, sequenceNo: r.sequenceNo, enterpriseId: r.enterpriseId, usccRaw: r.usccRaw, declareKind: r.declareKind, year: r.year, batch: r.batch, awardBatchLabel: r.awardBatchLabel, status: r.status, appliedAt: r.appliedAt, province: r.province, rawFields: processRaw }).from(r).where(inArray(r.queryId, ids)).orderBy(asc(r.queryId), asc(r.sequenceNo)).all())
    .map(row => normalizePlatformRelation(queriesById.get(row.queryId)!.interface, row))
  const exports = batchesOf(event && identity ? batches.filter(b => b.importStatus === 'imported' && b.titleCode === titleCode).map(b => b.id) : []).flatMap(ids => db.select({ id: x.id, batchId: x.batchId, sourceRowNo: x.sourceRowNo, usccRaw: x.usccRaw }).from(x).where(inArray(x.batchId, ids)).orderBy(asc(x.batchId), asc(x.sourceRowNo)).all())
  const relevantRelations = relations.filter(r => identity && normalizeUscc(r.usccRaw) === identity && (!r.enterpriseId || r.enterpriseId === enterpriseId))
  const relevantExports = exports.filter(r => identity && normalizeUscc(r.usccRaw) === identity)
  const priors = [...batchesOf(relevantRelations.map(r => r.id)).map(ids => inArray(c.relationId, ids)), ...batchesOf(relevantExports.map(r => r.id)).map(ids => inArray(c.exportRowId, ids))]
    .flatMap(where => db.select({ id: c.id, eventId: c.eventId, type: c.type, role: c.role, relationId: c.relationId, exportRowId: c.exportRowId, revision: c.revision }).from(c).where(where).orderBy(asc(c.id)).all())
  const relationsByQuery = Map.groupBy(relevantRelations, r => r.queryId)
  const exportsByBatch = Map.groupBy(relevantExports, r => r.batchId)
  const relationPriors = Map.groupBy(priors.filter(r => r.relationId != null), r => r.relationId)
  const exportPriors = Map.groupBy(priors.filter(r => r.exportRowId != null), r => r.exportRowId)
  const rows: Record<string, unknown>[] = []
  for (const query of queries) {
    if (!['success', 'partial'].includes(query.status)) continue
    for (const relation of relationsByQuery.get(query.id) ?? []) {
      const rowTitle = query.interface === 'recognized_list' ? RDJB_TITLE_CODES[sourcePositionForSequence(query.collectionEvidence, relation.sequenceNo).sourceRdjb ?? ''] ?? query.titleCode : query.titleCode ?? RDJB_TITLE_CODES[query.rdjb]
      const rowUscc = normalizeUscc(relation.usccRaw)
      if (!identity || !rowUscc || identity !== rowUscc || rowTitle !== titleCode || (relation.enterpriseId && relation.enterpriseId !== enterpriseId)) continue
      const edge = event ? { type: query.interface === 'recognized_list' ? 'event_recognized' : 'event_process', eventId: event.event.id, relationId: relation.id, role: query.interface === 'recognized_list' ? 'recognized_corrob' : 'context_only' } : query.interface === 'recognized_list' ? null : { type: 'later_process', enterpriseId, titleCode, relationId: relation.id, role: relation.declareKind === 'review' ? 'followup_review' : relation.declareKind === 'update' ? 'followup_update' : 'followup_apply' }
      if (!edge) continue
      const prior = (relationPriors.get(relation.id) ?? []).find(r => r.eventId === (event?.event.id ?? null) && r.type === edge.type && r.role === edge.role)
      const conflicts = [] as string[]
      if (relation.normalizationConflicts.length) conflicts.push('platform_field_conflict')
      if (event && event.event.year == null) conflicts.push('official_year_missing')
      if (relation.year == null) conflicts.push('platform_year_missing')
      if (event && event.event.batchSeq == null) conflicts.push('official_batch_missing')
      if (event?.event.year != null && relation.year != null && event.event.year !== relation.year) conflicts.push('year_mismatch')
      if (query.interface !== 'recognized_list' && !['apply', 'update', 'review'].includes(relation.declareKind ?? '')) conflicts.push('process_type_unknown')
      if (!relation.awardBatchLabel && !relation.batch) conflicts.push('platform_batch_missing')
      rows.push({ edge, status: 'candidate', ruleId: 'archived-row-exact-identity-title', ruleVersion: input.ruleVersion, evidence: { identity: { enterpriseId, officialUsccRaw: event?.record.usccRaw ?? enterprise.usccNorm, rowUsccRaw: relation.usccRaw }, title: { official: titleCode, row: rowTitle }, process: { declareKind: relation.declareKind, appliedAt: relation.appliedAt, status: relation.status, normalizationConflicts: relation.normalizationConflicts }, temporal: { eventYear: event?.event.year ?? null, eventBatchSeq: event?.event.batchSeq ?? null, relationYear: relation.year, relationBatch: relation.batch, awardBatchLabel: relation.awardBatchLabel }, source: { queryId: query.id, relationId: relation.id, sequenceNo: relation.sequenceNo, queriedAt: query.queriedAt, status: query.status } }, conflicts, existingCorrespondenceId: prior?.id ?? null, revision: prior?.revision ?? null })
    }
  }
  for (const batch of batches) {
    if (!event || batch.importStatus !== 'imported' || batch.titleCode !== titleCode || !identity) continue
    for (const row of exportsByBatch.get(batch.id) ?? []) {
      if (normalizeUscc(row.usccRaw) !== identity) continue
      const edge = { type: 'event_export_context', eventId: event.event.id, exportRowId: row.id, role: 'current_snapshot_context' }
      const prior = (exportPriors.get(row.id) ?? []).find(r => r.eventId === event.event.id && r.type === edge.type)
      rows.push({ edge, status: 'candidate', ruleId: 'archived-row-exact-identity-title', ruleVersion: input.ruleVersion, evidence: { identity: { enterpriseId, officialUsccRaw: event.record.usccRaw, rowUsccRaw: row.usccRaw }, title: { official: titleCode, row: batch.titleCode }, temporal: { eventYear: event.event.year, exportYear: batch.year, comparability: 'unknown' }, source: { exportBatchId: batch.id, exportRowId: row.id, sourceRowNo: row.sourceRowNo, sha256: batch.sha256, collectedOn: batch.collectedOn } }, conflicts: ['scope_version_not_proven'], existingCorrespondenceId: prior?.id ?? null, revision: prior?.revision ?? null })
    }
  }
  const relationCandidates = rows.filter(row => (row.edge as { type: string }).type !== 'event_export_context')
  if (relationCandidates.length > 1) for (const row of relationCandidates) (row.conflicts as string[]).push('multiple_candidate_rows')
  return { rows: rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: rows.length, page: input.page, pageSize: input.pageSize, coverage: queries.map(({ collectionEvidence, ...query }) => ({ ...query, collectionEvidence: safeCollectionEvidence(collectionEvidence) })), exportBatches: batches.map(({ id, titleCode, year, collectedOn, sha256 }) => ({ id, titleCode, year, collectedOn, sha256 })) }
}
