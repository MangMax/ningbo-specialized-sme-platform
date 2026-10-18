import { createHash } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { RDJB_TITLE_CODES, sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { TITLES } from '../../lib/labels'
import { comparisonSourceCatalogInput, recordComparisonInput, type ComparisonSourceCatalogInput, type RecordComparisonInput, type HistoricalClassification } from '../../lib/roster/record-comparison'
import { listRecordCorrespondences } from './record-correspondence'

type Db = BetterSQLite3Database<typeof schema>
type Query = typeof schema.platformQuery.$inferSelect
type Relation = typeof schema.platformRelation.$inferSelect
type Event = typeof schema.recordEvent.$inferSelect
type Edge = ReturnType<typeof listRecordCorrespondences>[number]
/** Only an authorized evidence reader may supply these verified, persisted attestations.
 * HTTP/MCP currently have no such reader; client-supplied assertions are not accepted. */
export interface VerifiedComparisonEvidence {
  officialScopes: Array<{ proofId: string; sourceDocumentIds: number[]; titleCode: string; fromYear: number; throughYear: number; enterpriseIds: number[] | null; verifiedAt: string }>
  currentScopes: Array<{ proofId: string; queryId: number; exportBatchId: number; titleCode: string; querySourceFingerprint: string; exportSha256: string; scopeEquivalent: true; versionEquivalent: true; verifiedAt: string }>
}
export function queryProofFingerprint(query: Query) {
  return createHash('sha256').update(JSON.stringify({ id: query.id, interface: query.interface, queryKey: query.queryKey, rdjb: query.rdjb, titleCode: query.titleCode, queriedAt: query.queriedAt, status: query.status, collectionEvidence: query.collectionEvidence })).digest('hex')
}
const positive = (n: number) => Number.isSafeInteger(n) && n > 0
const unique = <T>(rows: T[]) => [...new Set(rows)]
const before = (time: string | null, asOf?: string) => !asOf || (time !== null && (time.length === 10 ? time <= new Date(asOf).toISOString().slice(0, 10) : Date.parse(time) <= Date.parse(asOf)))
const historicalEdge = (edge: Edge) => edge.type === 'event_process' || edge.type === 'event_recognized'
function processTimingMatches(event: Event, relation: Relation) {
  if (event.year == null || relation.year == null) return false
  if (event.eventType === 'review') return event.decidedYear != null && relation.year === event.decidedYear && relation.declareKind === 'review'
  return relation.year === event.year && relation.declareKind === 'apply'
}
const publicEdge = (edge: Edge) => ({ id: edge.id, type: edge.type, role: edge.role, eventId: edge.eventId, relationId: edge.relationId, exportRowId: edge.exportRowId, predecessorEventId: edge.predecessorEventId, status: edge.status, revision: edge.revision, requiresRevalidation: edge.requiresRevalidation, ruleId: edge.ruleId, ruleVersion: edge.ruleVersion, decidedAt: edge.decidedAt })
const publicRelation = (relation: Relation, query: Query) => ({ id: relation.id, queryId: query.id, interface: query.interface, sequenceNo: relation.sequenceNo, relationKey: relation.relationKey, enterpriseId: relation.enterpriseId, usccRaw: relation.usccRaw, nameRaw: relation.nameRaw, status: relation.status, declareKind: relation.declareKind, appliedAt: relation.appliedAt, awardBatchLabel: relation.awardBatchLabel, year: relation.year, verificationStatus: relation.verificationStatus, queriedAt: query.queriedAt, titleCode: relationTitle(relation, query), rdjb: query.rdjb, sourceRdjb: sourcePositionForSequence(query.collectionEvidence, relation.sequenceNo).sourceRdjb, sourcePage: sourcePositionForSequence(query.collectionEvidence, relation.sequenceNo).sourcePage })
const publicExport = (row: typeof schema.platformExportRow.$inferSelect, batch: typeof schema.platformExportBatch.$inferSelect) => ({ id: row.id, batchId: batch.id, sourceRowNo: row.sourceRowNo, usccRaw: row.usccRaw, nameRaw: row.nameRaw, district: row.district, province: row.province, city: row.city, regStatus: row.regStatus, titleCode: batch.titleCode, collectedOn: batch.collectedOn, sha256: batch.sha256 })
const rdjbFor = (title: string) => Object.entries(RDJB_TITLE_CODES).find(([, value]) => value === title)?.[0]
function relationTitle(relation: Relation, query: Query): string | null {
  const source = query.interface === 'recognized_list' ? sourcePositionForSequence(query.collectionEvidence, relation.sequenceNo).sourceRdjb : null
  const sole = query.rdjb.split(',').filter(Boolean)
  return (source ? RDJB_TITLE_CODES[source] : null) ?? query.titleCode ?? (sole.length === 1 ? RDJB_TITLE_CODES[sole[0]!] : null) ?? null
}
function queryCoverage(query: Query) {
  const evidence = query.collectionEvidence
  const reasons: string[] = []
  if (!evidence) reasons.push('collection_evidence_missing')
  if (query.status !== 'success' && query.status !== 'no_record') reasons.push(`query_${query.status}`)
  if (query.status === 'partial' || query.status === 'failed') reasons.push('incomplete_or_continuation')
  if (evidence && (evidence.completeness !== 'complete' || !evidence.fullRange || evidence.unfinished.length)) reasons.push('incomplete_or_continuation')
  const selected = evidence?.titleScope.rdjb ?? query.rdjb.split(',').filter(Boolean)
  const titleCoverage = selected.map(rdjb => {
    const pages = evidence?.pages.filter(page => page.rdjb === rdjb) ?? []
    const complete = Boolean(evidence?.completeness === 'complete' && evidence.fullRange && !evidence.unfinished.some(position => position.rdjb === rdjb) && pages.length && pages.every(page => page.status === 'success') && pages[0]?.page === 1 && (pages.at(-1)?.maxPage != null ? pages.at(-1)?.page === pages.at(-1)?.maxPage : pages.at(-1)?.declaredTotal != null ? pages.reduce((count, page) => count + page.fetchedCount, 0) === pages.at(-1)?.declaredTotal : pages.at(-1)?.fetchedCount === 0))
    return { rdjb, titleCode: RDJB_TITLE_CODES[rdjb] ?? null, complete, pageCount: pages.length, unfinished: evidence?.unfinished.filter(position => position.rdjb === rdjb).map(position => position.page) ?? [] }
  })
  return { queryId: query.id, interface: query.interface, status: query.status, queriedAt: query.queriedAt, rdjb: query.rdjb, titleCode: query.titleCode, effectiveConditions: evidence?.effectiveConditions ?? null, completeness: evidence?.completeness ?? 'unknown', fullRange: evidence?.fullRange ?? false, titleCoverage, reasons }
}
function consistentScope(query: Query, title: string) {
  const coverage = queryCoverage(query)
  const titleUnit = coverage.titleCoverage.find(unit => unit.titleCode === title)
  const conditions = coverage.effectiveConditions
  return Boolean(titleUnit?.complete && conditions?.combination === 'and' && !conditions.name && !conditions.uscc && !conditions.sqsj && !conditions.rddqrq && !conditions.whpcyear && !conditions.whpc && !conditions.szq)
}
function exactQueryCoverage(query: Query, title: string, uscc: string | null) {
  const coverage = queryCoverage(query)
  const conditions = coverage.effectiveConditions
  return Boolean(coverage.titleCoverage.some(unit => unit.titleCode === title && unit.complete) && conditions?.combination === 'and' &&
    (!conditions.uscc || normalizeUscc(conditions.uscc) === normalizeUscc(uscc)) &&
    !conditions.name && !conditions.sqsj && !conditions.rddqrq && !conditions.whpcyear && !conditions.whpc && !conditions.szq)
}
function officialProof(evidence: VerifiedComparisonEvidence | undefined, documents: Array<typeof schema.sourceDocument.$inferSelect>, enterpriseId: number, titleCode: string, year: number | null) {
  if (!year) return null
  const selected = new Set(documents.map(document => document.id))
  return evidence?.officialScopes.find(proof => proof.titleCode === titleCode && proof.fromYear <= year && year <= proof.throughYear &&
    proof.sourceDocumentIds.length > 0 && proof.sourceDocumentIds.every(id => selected.has(id)) &&
    (proof.enterpriseIds === null || proof.enterpriseIds.includes(enterpriseId))) ?? null
}
function conclusion(event: Event, edges: Edge[], relations: Map<number, { relation: Relation; query: Query }>): { classification: HistoricalClassification; reasons: string[] } {
  const historical = edges.filter(edge => edge.status === 'confirmed' && !edge.requiresRevalidation && historicalEdge(edge))
  if (!historical.length) return { classification: 'unresolved', reasons: [...(event.year == null ? ['official_event_year_unknown'] : []), edges.some(edge => historicalEdge(edge) && edge.status === 'candidate') ? 'candidate_not_confirmed' : 'official_coverage_unproved'] }
  let supported = false
  let conflict = false
  const reasons: string[] = []
  for (const edge of historical) {
    if (edge.type === 'event_recognized') { reasons.push('recognized_row_has_no_verified_event_version'); continue }
    const source = edge.relationId == null ? null : relations.get(edge.relationId)
    if (!source) { reasons.push('selected_process_row_missing'); continue }
    const { relation } = source
    if (!processTimingMatches(event, relation)) { reasons.push('event_process_fact_or_timing_unknown'); continue }
    const status = relation.status ?? ''
    const pass = /通过|获批|认定/.test(status) && !/未通过|不通过/.test(status)
    const fail = /退回|驳回|未通过|不通过/.test(status)
    const pending = /待审核|审核中|在途|省已审/.test(status)
    if (event.eventType === 'award') {
      if (fail || pending) conflict = true
      else if (pass && edge.role === 'supports_award') supported = true
      else reasons.push('process_status_or_role_not_decisive')
    } else if (event.reviewOutcome === 'failed') {
      if (pass) conflict = true
      else if (fail && edge.role === 'supports_review') supported = true
      else reasons.push('review_status_or_role_not_decisive')
    } else if (event.reviewOutcome === 'passed') {
      if (fail || pending) conflict = true
      else if (pass && edge.role === 'supports_review') supported = true
      else reasons.push('review_status_or_role_not_decisive')
    } else reasons.push('official_review_outcome_unknown')
  }
  return conflict ? { classification: 'historical_conflict', reasons: ['confirmed_same_event_status_conflict'] } : supported ? { classification: 'historical_aligned', reasons: [] } : { classification: 'unresolved', reasons: unique(reasons) }
}
function selected(db: Db, input: RecordComparisonInput) {
  const parsed = recordComparisonInput.parse(input)
  for (const key of ['queryIds', 'exportBatchIds', 'officialSourceDocumentIds'] as const) if (unique(parsed[key]).length !== parsed[key].length) throw new Error(`duplicate_${key}`)
  const queries = db.select().from(schema.platformQuery).all().filter(row => parsed.queryIds.includes(row.id) && before(row.queriedAt, parsed.asOf))
  const batches = db.select().from(schema.platformExportBatch).all().filter(row => parsed.exportBatchIds.includes(row.id) && row.importStatus === 'imported' && (!parsed.asOf || row.collectedOn <= parsed.asOf.slice(0, 10)))
  const documents = db.select().from(schema.sourceDocument).all().filter(row => parsed.officialSourceDocumentIds.includes(row.id) && row.source === 'jxj' && (!parsed.asOf || before(row.issueDate, parsed.asOf)))
  if (queries.length !== parsed.queryIds.length || batches.length !== parsed.exportBatchIds.length || documents.length !== parsed.officialSourceDocumentIds.length) throw new Error('source_set_missing_or_out_of_scope')
  const queryMap = new Map(queries.map(row => [row.id, row]))
  const batchMap = new Map(batches.map(row => [row.id, row]))
  const relations = db.select().from(schema.platformRelation).all().filter(row => queryMap.has(row.queryId)).map(relation => ({ relation, query: queryMap.get(relation.queryId)! }))
  const exports = db.select().from(schema.platformExportRow).all().filter(row => batchMap.has(row.batchId)).map(row => ({ row, batch: batchMap.get(row.batchId)! }))
  const allEdges = listRecordCorrespondences(db).filter(edge => before(edge.createdAt, parsed.asOf))
  const revisedAfterCutoff = new Set(parsed.asOf ? db.select().from(schema.recordCorrespondenceAudit).all().filter(audit => !before(audit.decidedAt, parsed.asOf)).map(audit => audit.correspondenceId) : [])
  const unavailableEdges = allEdges.filter(edge => parsed.asOf && ((!before(edge.decidedAt, parsed.asOf) && edge.decidedAt !== null) || revisedAfterCutoff.has(edge.id)))
  const unavailableIds = new Set(unavailableEdges.map(edge => edge.id))
  const edges = allEdges.filter(edge => !unavailableIds.has(edge.id))
  return { input: parsed, queries, batches, documents, relations, exports, edges, unavailableEdges }
}
export function getRecordComparison(db: Db, input: RecordComparisonInput, verifiedEvidence?: VerifiedComparisonEvidence) {
  const source = selected(db, input)
  if (source.input.asOf && verifiedEvidence) verifiedEvidence = {
    officialScopes: verifiedEvidence.officialScopes.filter(proof => before(proof.verifiedAt, source.input.asOf)),
    currentScopes: verifiedEvidence.currentScopes.filter(proof => before(proof.verifiedAt, source.input.asOf)),
  }
  const { queries, batches, documents, relations, exports, edges } = source
  const relationMap = new Map(relations.map(item => [item.relation.id, item]))
  const exportMap = new Map(exports.map(item => [item.row.id, item]))
  const documentPaths = new Set(documents.map(row => row.path))
  const evidence = db.select().from(schema.recordEvidence).all()
  const records = new Map(db.select().from(schema.record).all().map(row => [row.id, row]))
  const officialEvents = db.select().from(schema.recordEvent).all().filter(event => ['award', 'review'].includes(event.eventType) && records.get(event.recordId)?.source === 'jxj')
  const selectedEdges = edges.filter(edge => (edge.relationId == null || relationMap.has(edge.relationId)) && (edge.exportRowId == null || exportMap.has(edge.exportRowId)))
  const unavailableEdges = source.unavailableEdges.filter(edge => (edge.relationId == null || relationMap.has(edge.relationId)) && (edge.exportRowId == null || exportMap.has(edge.exportRowId)))
  const later = selectedEdges.filter(edge => edge.type === 'later_process' && edge.status === 'confirmed' && !edge.requiresRevalidation && edge.relationId != null && relationMap.has(edge.relationId))
  const rows = officialEvents.map(event => {
    const record = records.get(event.recordId)!
    const officialEvidence = evidence.filter(item => item.recordEventId === event.id).map(item => ({ id: item.id, sourceFile: item.sourceFile, attachment: item.attachment, listNo: item.listNo, page: item.page, inSelectedSource: documentPaths.has(item.sourceFile) }))
    const eventEdges = selectedEdges.filter(edge => edge.eventId === event.id && edge.type !== 'later_process')
    const linked = unique(eventEdges.flatMap(edge => edge.relationId == null ? [] : [edge.relationId])).map(id => relationMap.get(id)).filter((item): item is NonNullable<typeof item> => !!item)
    const followups = later.filter(edge => edge.enterpriseId === record.enterpriseId && edge.titleCode === record.titleCode && (edge.predecessorEventId == null || edge.predecessorEventId === event.id))
    let decision = officialEvidence.some(item => item.inSelectedSource) ? conclusion(event, eventEdges, relationMap) : { classification: 'unresolved' as const, reasons: ['official_source_not_selected'] }
    if (unavailableEdges.some(edge => edge.eventId === event.id && historicalEdge(edge))) decision = { classification: 'unresolved', reasons: ['post_cutoff_decision_state_unavailable'] }
    if (decision.classification === 'unresolved' && !eventEdges.some(edge => historicalEdge(edge) && (edge.status === 'confirmed' || edge.status === 'candidate')) && !unavailableEdges.some(edge => edge.eventId === event.id && historicalEdge(edge)) && officialEvidence.some(item => item.inSelectedSource) &&
      queries.some(query => (query.interface === 'business_list' || query.interface === 'recognized_list') && exactQueryCoverage(query, record.titleCode, record.usccRaw ?? db.select().from(schema.enterprise).all().find(owner => owner.id === record.enterpriseId)?.usccNorm ?? null))) {
      decision = { classification: 'official_without_correspondence', reasons: ['complete_selected_interface_scope_no_confirmed_edge'] }
    }
    return { event: { id: event.id, recordId: event.recordId, eventType: event.eventType, year: event.year, batchSeq: event.batchSeq, decidedYear: event.decidedYear, reviewOutcome: event.reviewOutcome }, record: { id: record.id, enterpriseId: record.enterpriseId, titleCode: record.titleCode, source: record.source, usccRaw: record.usccRaw, nameRaw: record.nameRaw }, evidence: officialEvidence, classification: decision.classification, reasons: decision.reasons, correspondences: eventEdges.map(publicEdge), platformRows: linked.map(item => publicRelation(item.relation, item.query)), laterProcesses: followups.map(edge => ({ correspondence: publicEdge(edge), relation: publicRelation(relationMap.get(edge.relationId!)!.relation, relationMap.get(edge.relationId!)!.query) })) }
  })
  const recognized = relations.filter(item => item.query.interface === 'recognized_list')
  const observations = recognized.flatMap(({ relation, query }) => {
    const title = relationTitle(relation, query)
    const uscc = normalizeUscc(relation.usccRaw)
    const matches = uscc && title ? exports.filter(item => item.batch.titleCode === title && normalizeUscc(item.row.usccRaw) === uscc) : []
    const proof = verifiedEvidence?.currentScopes.find(item => item.queryId === query.id && item.titleCode === title && batches.some(batch => batch.id === item.exportBatchId && batch.sha256 === item.exportSha256) && item.querySourceFingerprint === queryProofFingerprint(query) && queryCoverage(query).titleCoverage.some(unit => unit.titleCode === title && unit.complete))
    const provenMatches = proof ? matches.filter(item => item.batch.id === proof.exportBatchId) : []
    const fieldConflict = provenMatches.some(item => Boolean(relation.nameRaw && item.row.nameRaw && relation.nameRaw !== item.row.nameRaw))
    const reasons = proof ? [] : ['version_equivalence_unknown', 'export_scope_equivalence_unknown']
    if (!consistentScope(query, title ?? '')) reasons.push('query_conditions_or_completeness_not_comparable')
    if (!uscc || !title) reasons.push('row_identity_or_title_unknown')
    return [{ recognized: publicRelation(relation, query), exportRows: matches.map(item => publicExport(item.row, item.batch)), observation: matches.length ? 'same_uscc_title_observed' : 'no_matching_selected_export_observed', qualification: proof && uscc && title ? (fieldConflict ? 'field_conflict' as const : provenMatches.length ? 'matched' as const : 'interface_only' as const) : 'not_comparable' as const, proofId: proof?.proofId ?? null, reasons }]
  })
  const matchedExportIds = new Set(observations.flatMap(item => item.exportRows.map(row => row.id)))
  const exportObservations = exports.map(({ row, batch }) => {
    const paired = observations.filter(item => item.exportRows.some(match => match.id === row.id))
    const recognizedRelationIds = paired.map(item => item.recognized.id)
    const proof = verifiedEvidence?.currentScopes.find(item => item.exportBatchId === batch.id && item.titleCode === batch.titleCode && item.exportSha256 === batch.sha256 && queries.some(query => query.id === item.queryId && item.querySourceFingerprint === queryProofFingerprint(query) && consistentScope(query, batch.titleCode)))
    const pairedProof = paired.find(item => item.proofId)
    const effectiveProofId = pairedProof?.proofId ?? proof?.proofId ?? null
    return { exportRow: publicExport(row, batch), recognizedRelationIds, qualification: paired.some(item => item.qualification === 'field_conflict') ? 'field_conflict' as const : paired.some(item => item.qualification === 'matched') ? 'matched' as const : proof && !recognizedRelationIds.length ? 'export_only' as const : 'not_comparable' as const, proofId: effectiveProofId, reasons: effectiveProofId ? [] : ['version_equivalence_unknown', 'export_scope_equivalence_unknown'] }
  })
  const laterRelationIds = new Set(later.map(edge => edge.relationId))
  const laterProcessPlatformRows = relations.filter(item => laterRelationIds.has(item.relation.id))
  const unlinkedPlatformRows = relations.filter(item => !selectedEdges.some(edge => edge.relationId === item.relation.id && edge.eventId != null && edge.status === 'confirmed' && historicalEdge(edge)) && !laterRelationIds.has(item.relation.id))
  const withoutOfficial = unlinkedPlatformRows.filter(item => item.relation.enterpriseId != null && item.relation.verificationStatus === 'confirmed' && item.relation.year != null && !unavailableEdges.some(edge => edge.relationId === item.relation.id) && !selectedEdges.some(edge => edge.relationId === item.relation.id && edge.status === 'candidate' && edge.eventId != null) && (item.query.interface === 'recognized_list' || /通过|获批|认定/.test(item.relation.status ?? '')) &&
    officialProof(verifiedEvidence, documents, item.relation.enterpriseId!, relationTitle(item.relation, item.query) ?? '', item.relation.year))
  const counts = { officialEventRows: rows.length, distinctEvents: unique(rows.map(row => row.event.id)).length, distinctPlatformRows: unique(relations.map(item => item.relation.id)).length, distinctEnterpriseTitles: unique(rows.map(row => `${row.record.enterpriseId}:${row.record.titleCode}`)).length, historical_aligned: rows.filter(row => row.classification === 'historical_aligned').length, historical_conflict: rows.filter(row => row.classification === 'historical_conflict').length, official_without_correspondence: rows.filter(row => row.classification === 'official_without_correspondence').length, unresolved: rows.filter(row => row.classification === 'unresolved').length, laterProcessRows: unique(later.map(edge => edge.relationId)).length, laterProcessAffectedEvents: rows.filter(row => row.laterProcesses.length).length, platformWithoutOfficialRows: withoutOfficial.length, unresolvedPlatformRows: unlinkedPlatformRows.length - withoutOfficial.length, recognizedRows: recognized.length, exportRows: exports.length, observedRecognizedExportPairs: observations.reduce((n, item) => n + item.exportRows.length, 0), observedExportRows: matchedExportIds.size }
  const filtered = rows.filter(row => (source.input.enterpriseId == null || row.record.enterpriseId === source.input.enterpriseId) && (!source.input.titleCode || row.record.titleCode === source.input.titleCode) && (!source.input.classification || row.classification === source.input.classification))
  return { rows: filtered.slice((source.input.page - 1) * source.input.pageSize, source.input.page * source.input.pageSize), total: filtered.length, page: source.input.page, pageSize: source.input.pageSize, grain: { rows: 'official_event_id', platform: 'relation_id', export: 'batch_id_source_row_no', later: 'enterprise_id_title_code_relation_id' }, counts, sourceSet: { queryIds: source.input.queryIds, exportBatchIds: source.input.exportBatchIds, officialSourceDocumentIds: source.input.officialSourceDocumentIds, asOf: source.input.asOf ?? null }, coverage: queries.map(queryCoverage), officialCoverage: { qualification: verifiedEvidence?.officialScopes.length ? 'verified' as const : 'unknown' as const, reasons: verifiedEvidence?.officialScopes.length ? [] : ['official_source_completeness_not_persisted'], selectedDocumentIds: documents.map(row => row.id), proofIds: verifiedEvidence?.officialScopes.map(item => item.proofId) ?? [] }, currentSourceConsistency: { qualification: observations.length && observations.every(item => item.qualification !== 'not_comparable') && exportObservations.every(item => item.qualification !== 'not_comparable') ? 'comparable' as const : 'not_comparable' as const, reasons: observations.some(item => item.qualification === 'not_comparable') || exportObservations.some(item => item.qualification === 'not_comparable') ? ['version_equivalence_unknown', 'export_scope_equivalence_unknown'] : [], recognizedObservations: observations, exportObservations }, historicalDecisionUnavailable: unavailableEdges.map(edge => ({ id: edge.id, type: edge.type, eventId: edge.eventId, relationId: edge.relationId, reason: 'post_cutoff_decision_state_unavailable' as const })), platformWithoutOfficial: { rows: unlinkedPlatformRows.map(item => { const proof = withoutOfficial.includes(item) ? officialProof(verifiedEvidence, documents, item.relation.enterpriseId!, relationTitle(item.relation, item.query) ?? '', item.relation.year) : null; return { relation: publicRelation(item.relation, item.query), qualification: proof ? 'platform_without_official' as const : 'unresolved' as const, proofId: proof?.proofId ?? null, reasons: proof ? [] : [item.relation.enterpriseId == null || item.relation.verificationStatus !== 'confirmed' ? 'row_identity_unverified' : unavailableEdges.some(edge => edge.relationId === item.relation.id) ? 'post_cutoff_decision_state_unavailable' : 'official_source_completeness_not_persisted'] } }), total: unlinkedPlatformRows.length }, laterProcessPlatformRows: laterProcessPlatformRows.map(item => ({ relation: publicRelation(item.relation, item.query), correspondences: later.filter(edge => edge.relationId === item.relation.id).map(publicEdge) })), exportBatches: batches.map(batch => ({ id: batch.id, titleCode: batch.titleCode, year: batch.year, collectedOn: batch.collectedOn, sha256: batch.sha256, rowCount: batch.rowCount, replacedBatchId: batch.replacedBatchId })) }
}
export function previewRecordCorrespondenceImpact(db: Db, input: RecordComparisonInput) {
  const first = getRecordComparison(db, { ...input, page: 1, pageSize: 200 })
  const comparisonRows = [...first.rows]
  for (let page = 2; comparisonRows.length < first.total; page++) {
    comparisonRows.push(...getRecordComparison(db, { ...input, page, pageSize: 200 }).rows)
  }
  const comparison = { ...first, rows: comparisonRows }
  const all = db.select().from(schema.differenceReason).all().filter(reason => (!input.asOf || before(reason.recordedAt, input.asOf)))
  const source = selected(db, input)
  const legacy = all.map(reason => {
    const related = comparison.rows.filter(row => row.record.enterpriseId === reason.enterpriseId && row.record.titleCode === reason.titleCode)
    return { id: reason.id, original: { enterpriseId: reason.enterpriseId, titleCode: reason.titleCode, direction: reason.direction, status: reason.status, reasonCode: reason.reasonCode, measureCode: reason.measureCode, evidenceQueryId: reason.evidenceQueryId, evidenceRelationId: reason.evidenceRelationId, verificationStatus: reason.verificationStatus, recordedAt: reason.recordedAt }, disposition: 'legacy_pending_review' as const, possibleCategories: unique(related.map(row => row.classification)), possibleEventIds: related.map(row => row.event.id) }
  })
  const proposedCandidates = comparison.rows.flatMap(row => source.relations.filter(({ relation, query }) => relation.enterpriseId === row.record.enterpriseId && normalizeUscc(relation.usccRaw) && normalizeUscc(relation.usccRaw) === normalizeUscc(row.record.usccRaw ?? db.select().from(schema.enterprise).all().find(owner => owner.id === row.record.enterpriseId)?.usccNorm) && relationTitle(relation, query) === row.record.titleCode && (query.interface === 'recognized_list' ? row.event.eventType === 'award' && row.event.year != null && relation.year === row.event.year : row.event.year != null && (row.event.eventType === 'review' ? row.event.decidedYear != null && relation.year === row.event.decidedYear && relation.declareKind === 'review' : relation.year === row.event.year && relation.declareKind === 'apply')) && !row.correspondences.some(edge => edge.relationId === relation.id) && !comparison.historicalDecisionUnavailable.some(edge => edge.eventId === row.event.id && edge.relationId === relation.id)).map(({ relation, query }) => ({ eventId: row.event.id, relationId: relation.id, queryId: query.id, type: query.interface === 'recognized_list' ? 'event_recognized' : 'event_process', status: 'candidate' as const, qualification: 'requires_explicit_review' as const, reasons: ['batch_and_fact_require_review'] })))
  const filtered = legacy.filter(row => (input.enterpriseId == null || row.original.enterpriseId === input.enterpriseId) && (!input.titleCode || row.original.titleCode === input.titleCode))
  return { rows: filtered.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: filtered.length, page: input.page, pageSize: input.pageSize, grain: 'difference_reason_id', counts: { legacyRows: legacy.length, possibleAlignedEvents: comparison.counts.historical_aligned, possibleConflictEvents: comparison.counts.historical_conflict, unresolvedEvents: comparison.counts.unresolved, proposedCandidateEdges: proposedCandidates.length, potentialCandidateAuditWrites: proposedCandidates.length, plannedAuditWrites: 0 }, proposedCandidates, unresolved: comparison.rows.filter(row => row.classification === 'unresolved').map(row => ({ eventId: row.event.id, reasons: row.reasons })), dataIssues: [...comparison.coverage.filter(item => item.reasons.length).map(item => ({ queryId: item.queryId, eventId: null, reasons: item.reasons })), ...comparison.rows.filter(row => row.classification === 'unresolved' && row.reasons.some(reason => reason !== 'official_coverage_unproved')).map(row => ({ queryId: null, eventId: row.event.id, reasons: row.reasons }))], modelIssues: [...comparison.officialCoverage.reasons, ...comparison.currentSourceConsistency.reasons], sourceSet: comparison.sourceSet, note: 'Read-only candidate and impact preview; no legacy decision or correspondence is changed.' }
}

/** Picker data only. Stable ID order; selecting a source always requires an explicit UI action. */
export function listRecordComparisonSources(db: Db, input: ComparisonSourceCatalogInput) {
  const filter = comparisonSourceCatalogInput.parse(input)
  const documents = db.select().from(schema.sourceDocument).all().filter(row => row.source === 'jxj').map(row => ({ kind: 'official_document' as const, id: row.id, label: row.title, subtitle: row.docNumber, titleCode: null, titleName: null, observedAt: row.issueDate, status: 'available', selectable: true, path: row.path }))
  const queries = db.select().from(schema.platformQuery).all().map(row => ({ kind: 'query' as const, id: row.id, label: `${row.interface === 'business_list' ? '业务关联' : row.interface === 'apply_list' ? '申报流程' : '已认定名单'} · ${row.titleCode ? TITLES[row.titleCode] : row.rdjb || '多称号'} · ${row.queryKey}`, subtitle: row.interface, titleCode: row.titleCode, titleName: row.titleCode ? TITLES[row.titleCode] : null, observedAt: row.queriedAt, status: row.status, selectable: true, rdjb: row.rdjb, completeness: row.collectionEvidence?.completeness ?? 'unknown', fullRange: row.collectionEvidence?.fullRange ?? false, conditions: row.collectionEvidence?.effectiveConditions ?? null }))
  const batches = db.select().from(schema.platformExportBatch).all().map(row => ({ kind: 'export_batch' as const, id: row.id, label: `${TITLES[row.titleCode]} · ${row.year} · ${row.originalFilename}`, subtitle: row.originalFilename, titleCode: row.titleCode, titleName: TITLES[row.titleCode], observedAt: row.collectedOn, status: row.importStatus, selectable: row.importStatus === 'imported', sha256: row.sha256, rowCount: row.rowCount, replacedBatchId: row.replacedBatchId }))
  const all = [...documents, ...queries, ...batches]
  const rows = all.filter(row => !filter.kind || row.kind === filter.kind)
  return { rows: rows.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize), total: rows.length, page: filter.page, pageSize: filter.pageSize, counts: { official_document: documents.length, query: queries.length, export_batch: batches.length }, selection: 'explicit', completeness: 'not_implied_by_catalog' }
}
