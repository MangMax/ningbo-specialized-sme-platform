import { asc,eq,inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../layers/sme-roster/lib/domain'
import type { ScopedPlatformObservation } from '../../layers/sme-roster/lib/platform/business-record'
import type { PlatformObservationFact } from '../../layers/sme-roster/lib/platform/observation-facts'
import { RDJB_TITLE_CODES,sourcePositionForSequence } from '../../layers/sme-roster/lib/platform/recognized-evidence'
import { platformRowTitle } from '../../layers/sme-roster/lib/platform/row-title'
import { readCandidateTargetFacts,readCandidateTargetPositions,readCandidateTargetQueries,readCandidateTargetRelations,selectCandidateTargetPage } from './candidate-target-sources'
import { readPlatformBusinessGroups } from '../../layers/sme-roster/server/utils/platform-business-record-read'
import { safeCollectionEvidence } from './record-correspondence-read'
import { correspondenceTable,externalRelationColumn } from './record-correspondence-store'

type Db = BetterSQLite3Database<typeof schema>
export interface CandidateInput { eventId?: number; enterpriseId?: number; titleCode?: string; queryIds: number[]; exportBatchIds: number[]; ruleVersion: string; page: number; pageSize: number }
/** Keep SQLite parameter lists bounded, preserving historical ID ordering and duplicate-ID semantics. */
function batchesOf(ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  return Array.from({ length: Math.ceil(sorted.length / 400) }, (_, i) => sorted.slice(i * 400, (i + 1) * 400))
}
export function generateCandidates(db: Db, input: CandidateInput, selection?: { relationIds: number[]; total: number }) {
  return db.transaction(() => generateCandidateSnapshot(db, input, selection))
}
function generateCandidateSnapshot(db: Db, input: CandidateInput, selection?: { relationIds: number[]; total: number }) {
  const event = input.eventId ? db.select({ event: schema.recordEvent, record: schema.record }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).where(eq(schema.recordEvent.id, input.eventId)).get() : null
  if (input.eventId && (!event || event.record.source !== 'jxj')) return null
  const enterpriseId = event?.record.enterpriseId ?? input.enterpriseId!
  const titleCode = event?.record.titleCode ?? input.titleCode!
  const enterprise = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, enterpriseId)).get()
  if (!enterprise || !db.select().from(schema.title).where(eq(schema.title.code, titleCode)).get()) return null
  const identity = normalizeUscc(event?.record.usccRaw ?? enterprise.usccNorm)
  // These public candidates never expose raw_response or archived row arrays.
  const queries = batchesOf(input.queryIds).flatMap(ids => readCandidateTargetQueries(db, ids))
  const batches = batchesOf(input.exportBatchIds).flatMap(ids => db.select().from(schema.platformExportBatch).where(inArray(schema.platformExportBatch.id, ids)).orderBy(asc(schema.platformExportBatch.id)).all())
  if (queries.length !== new Set(input.queryIds).size || batches.length !== new Set(input.exportBatchIds).size) return null
  const targetPage = !selection ? selectCandidateTargetPage(db, { queryIds: input.queryIds, enterpriseId, identity, titleCode, event: !!event, page: input.page, pageSize: input.pageSize }) : null
  const x = schema.platformExportRow, c = correspondenceTable(db)
  const queriesById = new Map(queries.map(q => [q.id, q]))
  // Identity/scope columns only. Source-specific facts are read after scoping below.
  const relations = batchesOf(queries.filter(q => ['success', 'partial'].includes(q.status)).map(q => q.id)).flatMap(ids => readCandidateTargetRelations(db, ids, selection?.relationIds ?? targetPage?.ids))
  const exports = batchesOf(event && identity ? batches.filter(b => b.importStatus === 'imported' && b.titleCode === titleCode).map(b => b.id) : []).flatMap(ids => db.select({ id: x.id, batchId: x.batchId, sourceRowNo: x.sourceRowNo, usccRaw: x.usccRaw }).from(x).where(inArray(x.batchId, ids)).orderBy(asc(x.batchId), asc(x.sourceRowNo)).all())
  const relevantRelations = relations.filter(r => (!r.enterpriseId || r.enterpriseId === enterpriseId) && ((identity && normalizeUscc(r.usccRaw) === identity) || (selection && !normalizeUscc(r.usccRaw) && r.enterpriseId === enterpriseId && r.verificationStatus === 'confirmed')))
  // Scope by selected query/owner/title/role first; only then read source-specific facts.
  const factsByRelation = new Map<number, PlatformObservationFact>()
  for (const [interfaceName, scopedRows] of Map.groupBy(relevantRelations, row => queriesById.get(row.queryId)!.interface)) {
    for (const [relationId, fact] of (readCandidateTargetFacts)(db, interfaceName, scopedRows.map(row => row.id))) factsByRelation.set(relationId, fact)
  }
  const positions = new Map(batchesOf(relevantRelations.map(r => r.id)).flatMap(ids => [...readCandidateTargetPositions(db, ids)]))
  const relevantExports = exports.filter(r => identity && normalizeUscc(r.usccRaw) === identity)
  const priors = batchesOf(relevantExports.map(r => r.id)).map(ids => inArray(c.exportRowId, ids))
    .flatMap(where => db.select({ id: c.id, eventId: c.eventId, type: c.type, role: c.role, relationId: externalRelationColumn(db), exportRowId: c.exportRowId, revision: c.revision }).from(c).where(where).orderBy(asc(c.id)).all())
  const relationsByQuery = Map.groupBy(relevantRelations, r => r.queryId)
  const exportsByBatch = Map.groupBy(relevantExports, r => r.batchId)
  const exportPriors = Map.groupBy(priors.filter(r => r.exportRowId != null), r => r.exportRowId)
  const rows: Record<string, unknown>[] = []
  const platformRows = new Map<number, Record<string, unknown>>()
  const observations: ScopedPlatformObservation[] = []
  for (const query of queries) {
    if (!['success', 'partial'].includes(query.status)) continue
    for (const relation of relationsByQuery.get(query.id) ?? []) {
      const facts = factsByRelation.get(relation.id)
      const position = positions?.get(relation.id) ?? sourcePositionForSequence(query.collectionEvidence, relation.sequenceNo)
      const rowTitle = query.interface === 'recognized_list' ? RDJB_TITLE_CODES[position.sourceRdjb ?? ''] ?? query.titleCode : query.titleCode ?? RDJB_TITLE_CODES[platformRowTitle(query.rdjb, { rdjb: relation.rowTitleRaw })]
      const rowUscc = normalizeUscc(relation.usccRaw)
      if (rowTitle !== titleCode) continue
      const edge = event ? { type: query.interface === 'recognized_list' ? 'event_recognized' : 'event_process', eventId: event.event.id, relationId: relation.id, role: query.interface === 'recognized_list' ? 'recognized_corrob' : 'context_only' } : query.interface === 'recognized_list' ? null : { type: 'later_process', enterpriseId, titleCode, relationId: relation.id, role: facts?.declareKind === 'review' ? 'followup_review' : facts?.declareKind === 'update' ? 'followup_update' : 'followup_apply' }
      if (!edge) continue
      const conflicts = [] as string[]
      if (facts?.normalizationConflicts.length) conflicts.push('platform_field_conflict')
      const rawUscc = normalizeUscc(facts?.usccRaw ?? relation.usccRaw)
      if (rawUscc && rawUscc !== rowUscc) conflicts.push('identity_conflict')
      if (facts?.titleRaw && RDJB_TITLE_CODES[facts.titleRaw] && RDJB_TITLE_CODES[facts.titleRaw] !== rowTitle) conflicts.push('title_conflict')
      const awardYear = event?.event.year ?? null
      const decisionYear = event?.event.decidedYear ?? null
      const isReview = event?.event.eventType === 'review'
      const comparisonYear = isReview ? decisionYear : awardYear
      if (event && comparisonYear == null) conflicts.push(isReview ? 'official_decision_year_missing' : 'official_year_missing')
      if (facts?.year == null) conflicts.push('platform_year_missing')
      if (event && event.event.batchSeq == null) conflicts.push('official_batch_missing')
      if (query.interface !== 'recognized_list' && comparisonYear != null && facts?.year != null && facts.year !== comparisonYear) conflicts.push('year_mismatch')
      if (query.interface !== 'recognized_list' && !['apply', 'update', 'review'].includes(facts?.declareKind ?? '')) conflicts.push('process_type_unknown')
      if (!facts?.awardBatchLabel && !facts?.batch) conflicts.push('platform_batch_missing')
      if (selection && event && facts?.declareKind && ((event.event.eventType === 'award' && facts.declareKind !== 'apply') || (event.event.eventType === 'review' && facts.declareKind !== 'review'))) conflicts.push('process_type_mismatch')
      if (selection && event && facts?.appliedAt) {
        const decisionYearForApplication = event.event.decidedYear ?? (event.event.eventType === 'award' ? event.event.year : null)
        if (decisionYearForApplication && Number(facts.appliedAt.slice(0, 4)) > decisionYearForApplication) conflicts.push('application_after_decision')
      }
      if (selection && event?.event.batchSeq != null && facts?.batch && /^\d{4}-\d+$/.test(facts.batch) && Number(facts.batch.split('-')[1]) !== event.event.batchSeq) conflicts.push('batch_mismatch')
      const evidence = { identity: { enterpriseId, officialUsccRaw: event?.record.usccRaw ?? enterprise.usccNorm, rowUsccRaw: relation.usccRaw, rawUscc: facts?.usccRaw ?? relation.usccRaw ?? null }, title: { official: titleCode, row: rowTitle, rawRdjb: facts?.titleRaw ?? null }, process: { eventType: event?.event.eventType ?? null, declareKind: facts?.declareKind ?? null, appliedAt: facts?.appliedAt ?? null, status: facts?.status ?? null, normalizationConflicts: facts?.normalizationConflicts ?? [] }, temporal: { eventYear: awardYear, eventBatchSeq: event?.event.batchSeq ?? null, relationYear: facts?.year ?? null, relationBatch: facts?.batch ?? null, awardBatchLabel: facts?.awardBatchLabel ?? null, awardYear, decisionYear, comparisonYear }, source: { interface: query.interface, ...position, queryId: query.id, relationId: relation.id, sequenceNo: relation.sequenceNo, queriedAt: query.queriedAt, status: query.status } }
      platformRows.set(relation.id, { edge, status: 'candidate', ruleId: 'archived-row-exact-identity-title', ruleVersion: input.ruleVersion, evidence })
      observations.push({ relationId: relation.id, queryId: query.id, sequenceNo: relation.sequenceNo, interface: query.interface, relationKey: relation.relationKey, queriedAt: query.queriedAt, queryStatus: query.status, queryKey: query.queryKey, rdjb: query.rdjb, queryTitleCode: query.titleCode, titleCode: rowTitle, enterpriseId: relation.enterpriseId, usccRaw: relation.usccRaw, nameRaw: relation.nameRaw, verificationStatus: relation.verificationStatus, matchBasis: relation.matchBasis, target: { eventId: event?.event.id ?? null, enterpriseId, titleCode, type: edge.type, role: edge.role }, evidence, conflicts })
    }
  }
  // Every original business filter above runs before canonical metadata/decision reads.
  for (const group of readPlatformBusinessGroups(db, observations)) {
    const representative = group.observationRefs.find(o => o.relationId === group.representativeRelationId)!
    const decisions = representative.existingCorrespondences.filter(p => p.eventId === representative.target.eventId && p.enterpriseId === enterpriseId && p.titleCode === titleCode && p.type === representative.target.type)
    const prior = decisions.find(p => p.role === representative.target.role) ?? (selection ? decisions[0] : undefined)
    rows.push({ ...platformRows.get(group.representativeRelationId)!, ...group, existingCorrespondenceId: prior?.id ?? null, revision: prior?.revision ?? null, existingStatus: prior?.status ?? null, recommendation: prior ? 'existing_decision' : 'candidate' })
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
  if ((selection?.total ?? targetPage?.total ?? relationCandidates.length) > 1) for (const row of relationCandidates) (row.conflicts as string[]).push('multiple_candidate_rows')
  const exportCandidates = rows.filter(row => (row.edge as { type: string }).type === 'event_export_context')
  const selectedExports = targetPage ? exportCandidates.slice(Math.max(0, (input.page - 1) * input.pageSize - targetPage.total), Math.max(0, input.page * input.pageSize - targetPage.total)) : []
  return { rows: targetPage ? [...relationCandidates, ...selectedExports] : rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: targetPage ? targetPage.total + exportCandidates.length : rows.length, page: input.page, pageSize: input.pageSize, coverage: queries.map(({ collectionEvidence, ...query }) => ({ ...query, collectionEvidence: safeCollectionEvidence(collectionEvidence) })), exportBatches: batches.map(({ id, titleCode, year, collectedOn, sha256 }) => ({ id, titleCode, year, collectedOn, sha256 })) }
}
