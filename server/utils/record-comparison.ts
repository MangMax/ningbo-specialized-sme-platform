import { createHash } from 'node:crypto'
import { and, eq, getTableColumns, inArray, isNull, or, sql } from 'drizzle-orm'
import type { useDb } from '../../db/client'
import * as schema from '../../db/schema'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { RDJB_TITLE_CODES, sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { TITLES } from '../../lib/labels'
import { comparisonSourceCatalogInput, recordComparisonInput, type ComparisonSourceCatalogInput, type RecordComparisonInput, type HistoricalClassification } from '../../lib/roster/record-comparison'
import { comparisonFormalCounts, iterateComparisonFormalEvents } from './record-comparison-formal'
import { listRecordCorrespondences, readScopedRecordCorrespondences } from './record-correspondence'

type Db = ReturnType<typeof useDb>
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
function groupBy<T, K>(rows: T[], key: (row: T) => K) {
  const groups = new Map<K, T[]>()
  for (const row of rows) { const k = key(row); const bucket = groups.get(k); if (bucket) bucket.push(row); else groups.set(k, [row]) }
  return groups
}
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
  if (parsed.asOf) {
    const eligible = db.select({ id: schema.platformQuery.id, queriedAt: schema.platformQuery.queriedAt }).from(schema.platformQuery)
      .where(inArray(schema.platformQuery.id, parsed.queryIds)).all().filter(row => before(row.queriedAt, parsed.asOf))
    if (eligible.length !== parsed.queryIds.length) throw new Error('source_set_missing_or_out_of_scope')
  }
  const queries = db.select({ ...getTableColumns(schema.platformQuery), rawResponse: sql<null>`null` }).from(schema.platformQuery).where(inArray(schema.platformQuery.id, parsed.queryIds)).orderBy(schema.platformQuery.id).all().filter(row => before(row.queriedAt, parsed.asOf))
  const batches = db.select().from(schema.platformExportBatch).where(inArray(schema.platformExportBatch.id, parsed.exportBatchIds)).orderBy(schema.platformExportBatch.id).all().filter(row => row.importStatus === 'imported' && before(row.collectedOn, parsed.asOf))
  const documents = db.select().from(schema.sourceDocument).where(inArray(schema.sourceDocument.id, parsed.officialSourceDocumentIds)).orderBy(schema.sourceDocument.id).all().filter(row => row.source === 'jxj' && (!parsed.asOf || before(row.issueDate, parsed.asOf)))
  if (queries.length !== parsed.queryIds.length || batches.length !== parsed.exportBatchIds.length || documents.length !== parsed.officialSourceDocumentIds.length) throw new Error('source_set_missing_or_out_of_scope')
  const queryMap = new Map(queries.map(row => [row.id, row]))
  const batchMap = new Map(batches.map(row => [row.id, row]))
  const relations = db.select({ ...getTableColumns(schema.platformRelation), rawFields: sql<null>`null`, sourceText: sql<null>`null` }).from(schema.platformRelation).where(inArray(schema.platformRelation.queryId, parsed.queryIds)).orderBy(schema.platformRelation.id).all().map(relation => ({ relation, query: queryMap.get(relation.queryId)! }))
  const exports = db.select({ ...getTableColumns(schema.platformExportRow), rawFields: sql<null>`null` }).from(schema.platformExportRow).where(inArray(schema.platformExportRow.batchId, parsed.exportBatchIds)).orderBy(schema.platformExportRow.id).all().map(row => ({ row, batch: batchMap.get(row.batchId)! }))
  const c = schema.recordCorrespondence
  const relationIds = db.select({ id: schema.platformRelation.id }).from(schema.platformRelation).where(inArray(schema.platformRelation.queryId, parsed.queryIds))
  const exportIds = db.select({ id: schema.platformExportRow.id }).from(schema.platformExportRow).where(inArray(schema.platformExportRow.batchId, parsed.exportBatchIds))
  const edgeScope = and(or(isNull(c.relationId), inArray(c.relationId, relationIds)), or(isNull(c.exportRowId), inArray(c.exportRowId, exportIds)))
  const scopedEdgeIds = db.select({ id: c.id }).from(c).where(edgeScope)
  const allEdges = readScopedRecordCorrespondences(db, db.select().from(c).where(edgeScope).orderBy(c.id).all().filter(edge => before(edge.createdAt, parsed.asOf)))
  const revisedAfterCutoff = new Set(parsed.asOf ? db.select({ correspondenceId: schema.recordCorrespondenceAudit.correspondenceId, decidedAt: schema.recordCorrespondenceAudit.decidedAt }).from(schema.recordCorrespondenceAudit).where(inArray(schema.recordCorrespondenceAudit.correspondenceId, scopedEdgeIds)).all().filter(audit => !before(audit.decidedAt, parsed.asOf)).map(audit => audit.correspondenceId) : [])
  const unavailableEdges = allEdges.filter(edge => parsed.asOf && ((!before(edge.decidedAt, parsed.asOf) && edge.decidedAt !== null) || revisedAfterCutoff.has(edge.id)))
  const unavailableIds = new Set(unavailableEdges.map(edge => edge.id))
  const edges = allEdges.filter(edge => !unavailableIds.has(edge.id))
  return { input: parsed, queries, batches, documents, relations, exports, edges, unavailableEdges }
}
export function getRecordComparison(db: Db, input: RecordComparisonInput, verifiedEvidence?: VerifiedComparisonEvidence) {
  return consumeComparison(iterateRecordComparison(db, input, verifiedEvidence))
}
/** Same comparison computation, with cooperative boundaries for HTTP/MCP reads. */
export function* iterateRecordComparison(db: Db, input: RecordComparisonInput, verifiedEvidence?: VerifiedComparisonEvidence) {
  return yield* compareRecords(db, selected(db, input), verifiedEvidence)
}
function consumeComparison<T>(steps: Generator<void, T>) {
  while (true) { const step = steps.next(); if (step.done) return step.value }
}
function* compareRecords(db: Db, source: ReturnType<typeof selected>, verifiedEvidence?: VerifiedComparisonEvidence, paginate = true) {
  if (source.input.asOf && verifiedEvidence) verifiedEvidence = {
    officialScopes: verifiedEvidence.officialScopes.filter(proof => before(proof.verifiedAt, source.input.asOf)),
    currentScopes: verifiedEvidence.currentScopes.filter(proof => before(proof.verifiedAt, source.input.asOf)),
  }
  const { queries, batches, documents, relations, exports, edges } = source
  const relationMap = new Map(relations.map(item => [item.relation.id, item]))
  const exportMap = new Map(exports.map(item => [item.row.id, item]))
  const documentPaths = new Set(documents.map(row => row.path))
  yield
  const selectedEdges = edges.filter(edge => (edge.relationId == null || relationMap.has(edge.relationId)) && (edge.exportRowId == null || exportMap.has(edge.exportRowId)))
  const unavailableEdges = source.unavailableEdges.filter(edge => (edge.relationId == null || relationMap.has(edge.relationId)) && (edge.exportRowId == null || exportMap.has(edge.exportRowId)))
  const later = selectedEdges.filter(edge => edge.type === 'later_process' && edge.status === 'confirmed' && !edge.requiresRevalidation && edge.relationId != null && relationMap.has(edge.relationId))
  const edgesByEvent = groupBy(selectedEdges.filter(edge => edge.type !== 'later_process'), edge => edge.eventId)
  const unavailableEvents = new Set(unavailableEdges.filter(historicalEdge).map(edge => edge.eventId))
  const unavailableRelations = new Set(unavailableEdges.map(edge => edge.relationId))
  const laterByOwner = groupBy(later, edge => `${edge.enterpriseId}:${edge.titleCode}`)
  const laterByRelation = groupBy(later, edge => edge.relationId)
  const linkedRelationIds = new Set(selectedEdges.filter(edge => edge.eventId != null && edge.status === 'confirmed' && historicalEdge(edge)).map(edge => edge.relationId))
  const candidateRelationIds = new Set(selectedEdges.filter(edge => edge.status === 'candidate' && edge.eventId != null).map(edge => edge.relationId))
  const coverageCache = new Map<string, boolean>()
  const covers = (title: string, uscc: string | null) => {
    const key = JSON.stringify([title, uscc])
    if (!coverageCache.has(key)) coverageCache.set(key, queries.some(query => (query.interface === 'business_list' || query.interface === 'recognized_list') && exactQueryCoverage(query, title, uscc)))
    return coverageCache.get(key)!
  }
  const analyzeEvent = ({ event, record, uscc, inSelectedSource }: ReturnType<typeof iterateComparisonFormalEvents> extends Generator<infer T> ? T : never) => {
    const eventEdges = (edgesByEvent.get(event.id) ?? [])
    const followups = (laterByOwner.get(`${record.enterpriseId}:${record.titleCode}`) ?? []).filter(edge => edge.predecessorEventId == null || edge.predecessorEventId === event.id)
    let decision = inSelectedSource ? conclusion(event, eventEdges, relationMap) : { classification: 'unresolved' as const, reasons: ['official_source_not_selected'] }
    if (unavailableEvents.has(event.id)) decision = { classification: 'unresolved', reasons: ['post_cutoff_decision_state_unavailable'] }
    if (decision.classification === 'unresolved' && !eventEdges.some(edge => historicalEdge(edge) && (edge.status === 'confirmed' || edge.status === 'candidate')) && !unavailableEvents.has(event.id) && inSelectedSource &&
      covers(record.titleCode, record.usccRaw ?? uscc)) {
      decision = { classification: 'official_without_correspondence', reasons: ['complete_selected_interface_scope_no_confirmed_edge'] }
    }
    return { event, record, eventEdges, followups, decision }
  }
  const buildRow = ({ event, record, eventEdges, followups, decision }: ReturnType<typeof analyzeEvent>, officialEvidence: Array<typeof schema.recordEvidence.$inferSelect>) => {
    const linked = unique(eventEdges.flatMap(edge => edge.relationId == null ? [] : [edge.relationId])).map(id => relationMap.get(id)).filter((item): item is NonNullable<typeof item> => !!item)
    return { event: { id: event.id, recordId: event.recordId, eventType: event.eventType, year: event.year, batchSeq: event.batchSeq, decidedYear: event.decidedYear, reviewOutcome: event.reviewOutcome }, record: { id: record.id, enterpriseId: record.enterpriseId, titleCode: record.titleCode, source: record.source, usccRaw: record.usccRaw, nameRaw: record.nameRaw }, evidence: officialEvidence.map(item => ({ id: item.id, sourceFile: item.sourceFile, attachment: item.attachment, listNo: item.listNo, page: item.page, inSelectedSource: documentPaths.has(item.sourceFile) })), classification: decision.classification, reasons: decision.reasons, correspondences: eventEdges.map(publicEdge), platformRows: linked.map(item => publicRelation(item.relation, item.query)), laterProcesses: followups.map(edge => ({ correspondence: publicEdge(edge), relation: publicRelation(relationMap.get(edge.relationId!)!.relation, relationMap.get(edge.relationId!)!.query) })) }
  }
  const pageEvents: ReturnType<typeof analyzeEvent>[] = []
  const formalCounts = yield* comparisonFormalCounts(db)
  const classificationCounts = { historical_aligned: 0, historical_conflict: 0, official_without_correspondence: 0, unresolved: formalCounts.events }
  let laterProcessAffectedEvents = 0
  let total = 0
  const officialEventRows = formalCounts.events
  let visited = 0
  const laterOwners = [...laterByOwner.values()].map(owners => ({ enterpriseId: owners[0]!.enterpriseId, titleCode: owners[0]!.titleCode }))
  yield
  for (const formal of iterateComparisonFormalEvents(db, documents.map(document => document.id), source.input, laterOwners)) {
    if (++visited % 128 === 0) yield
    const row = analyzeEvent(formal)
    classificationCounts.unresolved--
    classificationCounts[row.decision.classification]++
    if (row.followups.length) laterProcessAffectedEvents++
    if ((source.input.enterpriseId == null || row.record.enterpriseId === source.input.enterpriseId) && (!source.input.titleCode || row.record.titleCode === source.input.titleCode) && (!source.input.classification || row.decision.classification === source.input.classification)) {
      if (!paginate || total >= (source.input.page - 1) * source.input.pageSize && total < source.input.page * source.input.pageSize) pageEvents.push(row)
      total++
    }
  }
  // Counts need light global facts, but only the emitted page needs complete
  // evidence. The legacy preview consumes classifications and identities only;
  // its complete candidate scan must not hydrate unused attachment text.
  const rows: ReturnType<typeof buildRow>[] = []
  if (!paginate) for (const row of pageEvents) rows.push(buildRow(row, []))
  else for (let offset = 0; offset < pageEvents.length; offset += 128) {
    const page = pageEvents.slice(offset, offset + 128)
    const evidence = db.select().from(schema.recordEvidence).where(inArray(schema.recordEvidence.recordEventId, page.map(row => row.event.id))).orderBy(schema.recordEvidence.id).all()
    const byEvent = groupBy(evidence, item => item.recordEventId)
    for (const row of page) rows.push(buildRow(row, byEvent.get(row.event.id) ?? []))
    yield
  }
  const recognized = relations.filter(item => item.query.interface === 'recognized_list')
  const exportsByIdentity = groupBy(exports, item => JSON.stringify([item.batch.titleCode, normalizeUscc(item.row.usccRaw)]))
  const queryFingerprints = new Map<number, string>()
  const proofFingerprint = (query: Query) => {
    if (!queryFingerprints.has(query.id)) queryFingerprints.set(query.id, queryProofFingerprint(query))
    return queryFingerprints.get(query.id)!
  }
  const observations = recognized.flatMap(({ relation, query }) => {
    const title = relationTitle(relation, query)
    const uscc = normalizeUscc(relation.usccRaw)
    const matches = uscc && title ? (exportsByIdentity.get(JSON.stringify([title, uscc])) ?? []) : []
    const proof = verifiedEvidence?.currentScopes.find(item => item.queryId === query.id && item.titleCode === title && batches.some(batch => batch.id === item.exportBatchId && batch.sha256 === item.exportSha256) && item.querySourceFingerprint === proofFingerprint(query) && queryCoverage(query).titleCoverage.some(unit => unit.titleCode === title && unit.complete))
    const provenMatches = proof ? matches.filter(item => item.batch.id === proof.exportBatchId) : []
    const fieldConflict = provenMatches.some(item => Boolean(relation.nameRaw && item.row.nameRaw && relation.nameRaw !== item.row.nameRaw))
    const reasons = proof ? [] : ['version_equivalence_unknown', 'export_scope_equivalence_unknown']
    if (!consistentScope(query, title ?? '')) reasons.push('query_conditions_or_completeness_not_comparable')
    if (!uscc || !title) reasons.push('row_identity_or_title_unknown')
    return [{ recognized: publicRelation(relation, query), exportRows: matches.map(item => publicExport(item.row, item.batch)), observation: matches.length ? 'same_uscc_title_observed' : 'no_matching_selected_export_observed', qualification: proof && uscc && title ? (fieldConflict ? 'field_conflict' as const : provenMatches.length ? 'matched' as const : 'interface_only' as const) : 'not_comparable' as const, proofId: proof?.proofId ?? null, reasons }]
  })
  const matchedExportIds = new Set(observations.flatMap(item => item.exportRows.map(row => row.id)))
  const observationsByExport = new Map<number, typeof observations>()
  for (const observation of observations) for (const row of observation.exportRows) {
    const bucket = observationsByExport.get(row.id)
    if (bucket) bucket.push(observation); else observationsByExport.set(row.id, [observation])
  }
  const exportObservations = exports.map(({ row, batch }) => {
    const paired = (observationsByExport.get(row.id) ?? [])
    const recognizedRelationIds = paired.map(item => item.recognized.id)
    const proof = verifiedEvidence?.currentScopes.find(item => item.exportBatchId === batch.id && item.titleCode === batch.titleCode && item.exportSha256 === batch.sha256 && queries.some(query => query.id === item.queryId && item.querySourceFingerprint === proofFingerprint(query) && consistentScope(query, batch.titleCode)))
    const pairedProof = paired.find(item => item.proofId)
    const effectiveProofId = pairedProof?.proofId ?? proof?.proofId ?? null
    return { exportRow: publicExport(row, batch), recognizedRelationIds, qualification: paired.some(item => item.qualification === 'field_conflict') ? 'field_conflict' as const : paired.some(item => item.qualification === 'matched') ? 'matched' as const : proof && !recognizedRelationIds.length ? 'export_only' as const : 'not_comparable' as const, proofId: effectiveProofId, reasons: effectiveProofId ? [] : ['version_equivalence_unknown', 'export_scope_equivalence_unknown'] }
  })
  const laterRelationIds = new Set(later.map(edge => edge.relationId))
  const laterProcessPlatformRows = relations.filter(item => laterRelationIds.has(item.relation.id))
  const unlinkedPlatformRows = relations.filter(item => !linkedRelationIds.has(item.relation.id) && !laterRelationIds.has(item.relation.id))
  const withoutOfficial = unlinkedPlatformRows.filter(item => item.relation.enterpriseId != null && item.relation.verificationStatus === 'confirmed' && item.relation.year != null && !unavailableRelations.has(item.relation.id) && !candidateRelationIds.has(item.relation.id) && (item.query.interface === 'recognized_list' || /通过|获批|认定/.test(item.relation.status ?? '')) &&
    officialProof(verifiedEvidence, documents, item.relation.enterpriseId!, relationTitle(item.relation, item.query) ?? '', item.relation.year))
  const withoutOfficialIds = new Set(withoutOfficial.map(item => item.relation.id))
  const counts = { officialEventRows, distinctEvents: officialEventRows, distinctPlatformRows: unique(relations.map(item => item.relation.id)).length, distinctEnterpriseTitles: formalCounts.enterpriseTitles, historical_aligned: classificationCounts.historical_aligned, historical_conflict: classificationCounts.historical_conflict, official_without_correspondence: classificationCounts.official_without_correspondence, unresolved: classificationCounts.unresolved, laterProcessRows: unique(later.map(edge => edge.relationId)).length, laterProcessAffectedEvents, platformWithoutOfficialRows: withoutOfficial.length, unresolvedPlatformRows: unlinkedPlatformRows.length - withoutOfficial.length, recognizedRows: recognized.length, exportRows: exports.length, observedRecognizedExportPairs: observations.reduce((n, item) => n + item.exportRows.length, 0), observedExportRows: matchedExportIds.size }
  return { rows, total, page: source.input.page, pageSize: source.input.pageSize, grain: { rows: 'official_event_id', platform: 'relation_id', export: 'batch_id_source_row_no', later: 'enterprise_id_title_code_relation_id' }, counts, sourceSet: { queryIds: source.input.queryIds, exportBatchIds: source.input.exportBatchIds, officialSourceDocumentIds: source.input.officialSourceDocumentIds, asOf: source.input.asOf ?? null }, coverage: queries.map(queryCoverage), officialCoverage: { qualification: verifiedEvidence?.officialScopes.length ? 'verified' as const : 'unknown' as const, reasons: verifiedEvidence?.officialScopes.length ? [] : ['official_source_completeness_not_persisted'], selectedDocumentIds: documents.map(row => row.id), proofIds: verifiedEvidence?.officialScopes.map(item => item.proofId) ?? [] }, currentSourceConsistency: { qualification: observations.length && observations.every(item => item.qualification !== 'not_comparable') && exportObservations.every(item => item.qualification !== 'not_comparable') ? 'comparable' as const : 'not_comparable' as const, reasons: observations.some(item => item.qualification === 'not_comparable') || exportObservations.some(item => item.qualification === 'not_comparable') ? ['version_equivalence_unknown', 'export_scope_equivalence_unknown'] : [], recognizedObservations: observations, exportObservations }, historicalDecisionUnavailable: unavailableEdges.map(edge => ({ id: edge.id, type: edge.type, eventId: edge.eventId, relationId: edge.relationId, reason: 'post_cutoff_decision_state_unavailable' as const })), platformWithoutOfficial: { rows: unlinkedPlatformRows.map(item => { const proof = withoutOfficialIds.has(item.relation.id) ? officialProof(verifiedEvidence, documents, item.relation.enterpriseId!, relationTitle(item.relation, item.query) ?? '', item.relation.year) : null; return { relation: publicRelation(item.relation, item.query), qualification: proof ? 'platform_without_official' as const : 'unresolved' as const, proofId: proof?.proofId ?? null, reasons: proof ? [] : [item.relation.enterpriseId == null || item.relation.verificationStatus !== 'confirmed' ? 'row_identity_unverified' : unavailableRelations.has(item.relation.id) ? 'post_cutoff_decision_state_unavailable' : 'official_source_completeness_not_persisted'] } }), total: unlinkedPlatformRows.length }, laterProcessPlatformRows: laterProcessPlatformRows.map(item => ({ relation: publicRelation(item.relation, item.query), correspondences: (laterByRelation.get(item.relation.id) ?? []).map(publicEdge) })), exportBatches: batches.map(batch => ({ id: batch.id, titleCode: batch.titleCode, year: batch.year, collectedOn: batch.collectedOn, sha256: batch.sha256, rowCount: batch.rowCount, replacedBatchId: batch.replacedBatchId })) }
}
export function previewRecordCorrespondenceImpact(db: Db, input: RecordComparisonInput) {
  const source = selected(db, input)
  const comparison = consumeComparison(compareRecords(db, source, undefined, false))
  const reason = schema.differenceReason
  const cutoff = input.asOf ? sql`julianday(${reason.recordedAt}) <= julianday(${input.asOf})` : undefined
  const filtered = and(cutoff, input.enterpriseId == null ? undefined : eq(reason.enterpriseId, input.enterpriseId), input.titleCode ? eq(reason.titleCode, input.titleCode) : undefined)
  const { legacyRows, total, pageReasons } = db.transaction(tx => ({
    legacyRows: tx.select({ count: sql<number>`count(*)` }).from(reason).where(cutoff).get()!.count,
    total: tx.select({ count: sql<number>`count(*)` }).from(reason).where(filtered).get()!.count,
    pageReasons: tx.select({ id: reason.id, enterpriseId: reason.enterpriseId, titleCode: reason.titleCode, direction: reason.direction, status: reason.status, reasonCode: reason.reasonCode, measureCode: reason.measureCode, evidenceQueryId: reason.evidenceQueryId, evidenceRelationId: reason.evidenceRelationId, verificationStatus: reason.verificationStatus, recordedAt: reason.recordedAt })
      .from(reason).where(filtered).orderBy(reason.id).limit(input.pageSize).offset((input.page - 1) * input.pageSize).all(),
  }))
  const owners = new Map(db.selectDistinct({ id: schema.enterprise.id, uscc: schema.enterprise.usccNorm }).from(schema.enterprise).innerJoin(schema.record, eq(schema.record.enterpriseId, schema.enterprise.id)).where(and(eq(schema.record.source, 'jxj'), input.enterpriseId == null ? undefined : eq(schema.enterprise.id, input.enterpriseId), input.titleCode ? eq(schema.record.titleCode, input.titleCode) : undefined)).all().map(row => [row.id, row.uscc]))
  const relationsByOwner = groupBy(source.relations, item => `${item.relation.enterpriseId}:${relationTitle(item.relation, item.query)}`)
  const comparisonByOwner = groupBy(comparison.rows, row => `${row.record.enterpriseId}:${row.record.titleCode}`)
  const legacy = pageReasons.map(item => {
    const related = comparisonByOwner.get(`${item.enterpriseId}:${item.titleCode}`) ?? []
    return { id: item.id, original: { enterpriseId: item.enterpriseId, titleCode: item.titleCode, direction: item.direction, status: item.status, reasonCode: item.reasonCode, measureCode: item.measureCode, evidenceQueryId: item.evidenceQueryId, evidenceRelationId: item.evidenceRelationId, verificationStatus: item.verificationStatus, recordedAt: item.recordedAt }, disposition: 'legacy_pending_review' as const, possibleCategories: unique(related.map(row => row.classification)), possibleEventIds: related.map(row => row.event.id) }
  })
  const proposedCandidates = comparison.rows.flatMap(row => (relationsByOwner.get(`${row.record.enterpriseId}:${row.record.titleCode}`) ?? []).filter(({ relation, query }) => normalizeUscc(relation.usccRaw) && normalizeUscc(relation.usccRaw) === normalizeUscc(row.record.usccRaw ?? owners.get(row.record.enterpriseId)) && relationTitle(relation, query) === row.record.titleCode && (query.interface === 'recognized_list' ? row.event.eventType === 'award' && row.event.year != null && relation.year === row.event.year : row.event.year != null && (row.event.eventType === 'review' ? row.event.decidedYear != null && relation.year === row.event.decidedYear && relation.declareKind === 'review' : relation.year === row.event.year && relation.declareKind === 'apply')) && !row.correspondences.some(edge => edge.relationId === relation.id) && !comparison.historicalDecisionUnavailable.some(edge => edge.eventId === row.event.id && edge.relationId === relation.id)).map(({ relation, query }) => ({ eventId: row.event.id, relationId: relation.id, queryId: query.id, type: query.interface === 'recognized_list' ? 'event_recognized' : 'event_process', status: 'candidate' as const, qualification: 'requires_explicit_review' as const, reasons: ['batch_and_fact_require_review'] })))
  return { rows: legacy, total, page: input.page, pageSize: input.pageSize, grain: 'difference_reason_id', counts: { legacyRows, possibleAlignedEvents: comparison.counts.historical_aligned, possibleConflictEvents: comparison.counts.historical_conflict, unresolvedEvents: comparison.counts.unresolved, proposedCandidateEdges: proposedCandidates.length, potentialCandidateAuditWrites: proposedCandidates.length, plannedAuditWrites: 0 }, proposedCandidates, unresolved: comparison.rows.filter(row => row.classification === 'unresolved').map(row => ({ eventId: row.event.id, reasons: row.reasons })), dataIssues: [...comparison.coverage.filter(item => item.reasons.length).map(item => ({ queryId: item.queryId, eventId: null, reasons: item.reasons })), ...comparison.rows.filter(row => row.classification === 'unresolved' && row.reasons.some(reason => reason !== 'official_coverage_unproved')).map(row => ({ queryId: null, eventId: row.event.id, reasons: row.reasons }))], modelIssues: [...comparison.officialCoverage.reasons, ...comparison.currentSourceConsistency.reasons], sourceSet: comparison.sourceSet, note: 'Read-only candidate and impact preview; no legacy decision or correspondence is changed.' }
}

function chunked<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

interface SourceEnterpriseLink {
  relationId: number
  sequenceNo: number
  enterpriseId: number
  enterpriseName: string
  nameRaw: string | null
  matchBasis: string
  /** 平台原行名与已确认曾用名一致时，才把它标成曾用名。 */
  aliasConfirmed: boolean
  /** 由归并审计备注解析出的原企业 ID；不是猜测。 */
  mergedFromEnterpriseId: number | null
}

/**
 * 只给本页 query IDs 补企业对象：
 * - `confirmedEnterprises` 保留 relation 级一对多，同时带 `nameRaw`；
 *   已确认主体与平台原行名并列返回，归并不替换原行名。
 * - `recordNames` 只收未关联/未确认关系的原行名称，UI 标“未确认主体”。
 * 两个查询都以本页查询 ID 为界，不扫描全库。
 */
function sourceEnterpriseLinks(db: Db, queryPageIds: number[]) {
  if (!queryPageIds.length) return new Map<number, { confirmedEnterprises: SourceEnterpriseLink[]; recordNames: string[] }>()
  const relationRows = db.select({
    queryId: schema.platformRelation.queryId,
    relationId: schema.platformRelation.id,
    sequenceNo: schema.platformRelation.sequenceNo,
    enterpriseId: schema.platformRelation.enterpriseId,
    nameRaw: schema.platformRelation.nameRaw,
    matchBasis: schema.platformRelation.matchBasis,
    verificationStatus: schema.platformRelation.verificationStatus,
    enterpriseName: schema.enterprise.name,
  }).from(schema.platformRelation)
    .leftJoin(schema.enterprise, eq(schema.enterprise.id, schema.platformRelation.enterpriseId))
    .where(inArray(schema.platformRelation.queryId, queryPageIds))
    .orderBy(schema.platformRelation.queryId, schema.platformRelation.id).all()
  const confirmed = relationRows.filter(row => row.verificationStatus === 'confirmed' && row.enterpriseId != null && row.enterpriseName != null)
  const enterpriseIds = [...new Set(confirmed.map(row => row.enterpriseId!))]
  const nameNorms = new Set(confirmed.flatMap(row => row.nameRaw ? [normalizeName(row.nameRaw)] : []))
  const aliases = new Map<string, { note: string | null }>()
  for (const ids of chunked(enterpriseIds, 400)) {
    if (!nameNorms.size) break
    const rows = db.select({
      enterpriseId: schema.enterpriseAlias.enterpriseId,
      nameNorm: schema.enterpriseAlias.nameNorm,
      note: schema.enterpriseAlias.note,
    }).from(schema.enterpriseAlias)
      .where(and(inArray(schema.enterpriseAlias.enterpriseId, ids), eq(schema.enterpriseAlias.verificationStatus, 'confirmed'), sql`${schema.enterpriseAlias.nameNorm} in (select value from json_each(${JSON.stringify([...nameNorms])}))`)).all()
    for (const alias of rows) aliases.set(`${alias.enterpriseId}\u0000${alias.nameNorm}`, alias)
  }
  const links = new Map<number, { confirmedEnterprises: SourceEnterpriseLink[]; recordNames: string[] }>()
  for (const row of relationRows) {
    const entry = links.get(row.queryId) ?? { confirmedEnterprises: [], recordNames: [] }
    if (row.verificationStatus === 'confirmed' && row.enterpriseId != null && row.enterpriseName != null) {
      const nameNorm = row.nameRaw ? normalizeName(row.nameRaw) : ''
      const alias = nameNorm ? aliases.get(`${row.enterpriseId}\u0000${nameNorm}`) : undefined
      const merged = alias?.note ? /归并自\s*enterprise:(\d+)/.exec(alias.note) : null
      entry.confirmedEnterprises.push({
        relationId: row.relationId,
        sequenceNo: row.sequenceNo,
        enterpriseId: row.enterpriseId,
        enterpriseName: row.enterpriseName,
        nameRaw: row.nameRaw ?? null,
        matchBasis: row.matchBasis,
        aliasConfirmed: Boolean(alias),
        mergedFromEnterpriseId: merged ? Number(merged[1]) : null,
      })
    } else if (row.nameRaw?.trim() && !entry.recordNames.includes(row.nameRaw)) {
      entry.recordNames.push(row.nameRaw)
    }
    links.set(row.queryId, entry)
  }
  return links
}

/** Picker data only. Stable ID order; selecting a source always requires an explicit UI action. */
export function listRecordComparisonSources(db: Db, input: ComparisonSourceCatalogInput) {
  return consumeComparison(iterateRecordComparisonSources(db, input))
}
export function* iterateRecordComparisonSources(db: Db, input: ComparisonSourceCatalogInput) {
  const filter = comparisonSourceCatalogInput.parse(input)
  const qids = filter.ids === undefined ? undefined : inArray(schema.platformQuery.id, filter.ids)
  const dids = and(eq(schema.sourceDocument.source, 'jxj'), filter.ids === undefined ? undefined : inArray(schema.sourceDocument.id, filter.ids))
  const bids = filter.ids === undefined ? undefined : inArray(schema.platformExportBatch.id, filter.ids)
  // SQLite's native whole-index Count can block the first request while leaf
  // pages enter its pager. Stream scalar IDs from the existing covering index
  // so a cold count also cooperates, without decoding query/archive objects.
  let queryCount = 0
  if (filter.ids === undefined) {
    const ids = db.$client.prepare('select id from platform_query indexed by platform_query_key_idx').pluck().iterate()
    for (const _id of ids) { if (++queryCount % 256 === 0) yield }
  } else queryCount = db.select({ n: sql<number>`count(*)` }).from(schema.platformQuery).where(qids).get()!.n
  const counts = {
    official_document: db.select({ n: sql<number>`count(*)` }).from(schema.sourceDocument).where(dids).get()!.n,
    query: queryCount,
    export_batch: db.select({ n: sql<number>`count(*)` }).from(schema.platformExportBatch).where(bids).get()!.n,
  }
  // The unfiltered catalog keeps its original document/query/export concatenation.
  // Intersect the requested page with each kind before touching its rows.
  let offset = (filter.page - 1) * filter.pageSize
  let remaining = filter.pageSize
  const window = (kind: keyof typeof counts) => {
    if (filter.kind && filter.kind !== kind) return { offset: 0, limit: 0 }
    const skip = Math.min(offset, counts[kind]); offset -= skip
    const limit = Math.min(remaining, counts[kind] - skip); remaining -= limit
    return { offset: skip, limit }
  }
  const dw = window('official_document'), qw = window('query'), bw = window('export_batch')
  const documents = dw.limit ? db.select().from(schema.sourceDocument).where(dids).orderBy(schema.sourceDocument.id).limit(dw.limit).offset(dw.offset).all().map(row => ({ kind: 'official_document' as const, id: row.id, label: row.title, subtitle: row.docNumber, titleCode: null, titleName: null, observedAt: row.issueDate, status: 'available', selectable: true, path: row.path })) : []
  const q = schema.platformQuery
  // OFFSET on the rowid table walks leaf pages containing archive payloads.
  // Sort only IDs from the existing covering key index, then seek the page's rows.
  // Explicit ID hydration already has bounded primary-key seeks.
  const queryPageIds = db.select({ id: sql<number>`${q.id}` }).from(filter.ids === undefined ? sql`${q} indexed by platform_query_key_idx` : q)
    .where(qids).orderBy(q.id).limit(qw.limit).offset(qw.offset)
  const pageQueryIds = qw.limit ? db.select({ id: q.id }).from(q).where(inArray(q.id, queryPageIds)).orderBy(q.id).all().map(row => row.id) : []
  const enterpriseLinks = sourceEnterpriseLinks(db, pageQueryIds)
  const queries = qw.limit ? db.select({ id: q.id, interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, titleCode: q.titleCode, queriedAt: q.queriedAt, status: q.status,
    completeness: sql<string | null>`json_extract(${q.collectionEvidence}, '$.completeness')`,
    fullRange: sql<number | null>`json_extract(${q.collectionEvidence}, '$.fullRange')`,
    conditions: sql<string | null>`json_extract(${q.collectionEvidence}, '$.effectiveConditions')`,
  }).from(q).where(inArray(q.id, pageQueryIds)).orderBy(q.id).all().map(row => ({ kind: 'query' as const, id: row.id, label: `${row.interface === 'business_list' ? '业务关联' : row.interface === 'apply_list' ? '申报流程' : '已认定名单'} · ${row.titleCode ? TITLES[row.titleCode] : row.rdjb || '多称号'} · ${row.queryKey}`, subtitle: row.interface, titleCode: row.titleCode, titleName: row.titleCode ? TITLES[row.titleCode] : null, observedAt: row.queriedAt, status: row.status, selectable: true, rdjb: row.rdjb, completeness: row.completeness ?? 'unknown', fullRange: Boolean(row.fullRange), conditions: row.conditions == null ? null : JSON.parse(row.conditions), ...(enterpriseLinks.get(row.id) ?? { confirmedEnterprises: [], recordNames: [] }) })) : []
  const batches = bw.limit ? db.select().from(schema.platformExportBatch).where(bids).orderBy(schema.platformExportBatch.id).limit(bw.limit).offset(bw.offset).all().map(row => ({ kind: 'export_batch' as const, id: row.id, label: `${TITLES[row.titleCode]} · ${row.year} · ${row.originalFilename}`, subtitle: row.originalFilename, titleCode: row.titleCode, titleName: TITLES[row.titleCode], observedAt: row.collectedOn, status: row.importStatus, selectable: row.importStatus === 'imported', sha256: row.sha256, rowCount: row.rowCount, replacedBatchId: row.replacedBatchId })) : []
  return { rows: [...documents, ...queries, ...batches], total: filter.kind ? counts[filter.kind] : counts.official_document + counts.query + counts.export_batch, page: filter.page, pageSize: filter.pageSize, counts, selection: 'explicit', completeness: 'not_implied_by_catalog' }
}
