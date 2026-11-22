import type { record as RecordTable, recordEvent as RecordEventTable, recordEvidence as RecordEvidenceTable } from '../../../../db/postgresql/ledger-tables'
import type { platformCollection as PlatformCollectionTable, platformCollectionPage as PlatformCollectionPageTable, platformExportBatch as PlatformExportBatchTable, platformExportRow as PlatformExportRowTable } from '../../../../db/postgresql/platform-tables'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { TITLES } from '../../lib/labels'
import type { PlatformBusinessMetadata } from '../../lib/platform/business-record'
import type { PlatformStoredQuery } from '../../lib/platform/read'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { platformRowTitle } from '../../lib/platform/row-title'
import { fileNameOf } from '../../../core/lib/preview'
import { groupComparisonBusinessObservations, recordComparisonInput, type ComparisonSourceCatalogInput, type HistoricalClassification, type RecordComparisonInput } from '../../lib/roster/record-comparison'
import type { StoredFileContentIdentity } from '../../../core/server/utils/file-identity'
import type { OfficialSourceDocument } from './official-source-directory-postgres'
import type { CorrespondenceRead } from './record-correspondence-model'
import type { BusinessMetadataRow } from './platform-business-record-postgres'
import type { readPostgresObservationComparisonFacts } from './record-correspondence-target-postgres'
import type { projectPostgresUnfinishedPositions } from '../../lib/platform/postgres-collection-scope'

type ComparisonTargetQueryFacts = {
  id: number
  collection: typeof PlatformCollectionTable.$inferSelect & Pick<PlatformStoredQuery, 'interface' | 'status'>
  evidencePresent: boolean
  pages: (typeof PlatformCollectionPageTable.$inferSelect)[]
  unfinished: ReturnType<typeof projectPostgresUnfinishedPositions>
  conditions: Record<string, unknown> | null
  scopes: string[]
}

export type Query = Pick<PlatformStoredQuery, 'id' | 'interface' | 'queryKey' | 'queriedAt' | 'status' | 'titleCode' | 'rdjb'> & { comparisonFacts: ComparisonTargetQueryFacts }

type ComparisonIdentity = {
  id: number
  observationId: number
  queryId: number
  sequenceNo: number
  relationKey: string | null
  enterpriseId: number | null
  matchBasis: string
  verificationStatus: string
  nameRaw: string | null
  usccRaw: string | null
}

type ObservationComparisonFact = Awaited<ReturnType<typeof readPostgresObservationComparisonFacts>> extends Map<number, infer Fact> ? Fact : never
export type Relation = ComparisonIdentity & Omit<ObservationComparisonFact, 'sqlFactTitle'>

type Event = Omit<typeof RecordEventTable.$inferSelect, 'formalValidity'>

type Edge = CorrespondenceRead

export const unique = <T>(rows: T[]) => [...new Set(rows)]

function groupBy<T, K>(rows: T[], key: (row: T) => K) {
  const groups = new Map<K, T[]>()
  for (const row of rows) { const k = key(row); const bucket = groups.get(k); if (bucket) bucket.push(row); else groups.set(k, [row]) }
  return groups
}

export const comparisonBefore = (time: string | null, asOf?: string) => !asOf || (time !== null && (time.length === 10 ? time <= new Date(asOf).toISOString().slice(0, 10) : Date.parse(time) <= Date.parse(asOf)))

const historicalEdge = (edge: Edge) => edge.type === 'event_process' || edge.type === 'event_recognized'

function processTimingMatches(event: Event, relation: Relation) {
  if (event.year == null || relation.year == null) return false
  if (event.eventType === 'review') return event.decidedYear != null && relation.year === event.decidedYear && relation.declareKind === 'review'
  return relation.year === event.year && relation.declareKind === 'apply'
}

const publicEdge = (edge: Edge) => ({ id: edge.id, type: edge.type, role: edge.role, eventId: edge.eventId, relationId: edge.relationId, exportRowId: edge.exportRowId, predecessorEventId: edge.predecessorEventId, status: edge.status, revision: edge.revision, requiresRevalidation: edge.requiresRevalidation, ruleId: edge.ruleId, ruleVersion: edge.ruleVersion, decidedAt: edge.decidedAt })

const publicRelation = (relation: Relation, query: Query) => ({ id: relation.id, queryId: query.id, interface: query.interface, sequenceNo: relation.sequenceNo, relationKey: relation.relationKey, enterpriseId: relation.enterpriseId, usccRaw: relation.usccRaw, nameRaw: relation.nameRaw, status: relation.status, declareKind: relation.declareKind, appliedAt: relation.appliedAt, awardBatchLabel: relation.awardBatchLabel, year: relation.year, normalizationConflicts: relation.normalizationConflicts, verificationStatus: relation.verificationStatus, queriedAt: query.queriedAt, titleCode: relationTitle(relation, query), rdjb: query.rdjb, sourceRdjb: comparisonPosition(query, relation.sequenceNo).sourceRdjb, sourcePage: comparisonPosition(query, relation.sequenceNo).sourcePage })

const publicExport = (row: typeof PlatformExportRowTable.$inferSelect, batch: typeof PlatformExportBatchTable.$inferSelect) => ({ id: row.id, batchId: batch.id, sourceRowNo: row.sourceRowNo, usccRaw: row.usccRaw, nameRaw: row.nameRaw, district: row.district, province: row.province, city: row.city, regStatus: row.regStatus, titleCode: batch.titleCode, collectedOn: batch.collectedOn, sha256: batch.sha256 })

function comparisonPosition(query: Query, sequenceNo: number) {
  if (!query.comparisonFacts.evidencePresent) return { sourceRdjb: null, sourcePage: null }
  const page = query.comparisonFacts.pages.find(page => page.status === 'success' && page.sequenceStart !== null && page.sequenceEnd !== null && sequenceNo >= page.sequenceStart && sequenceNo <= page.sequenceEnd)
  return { sourceRdjb: page?.rdjb ?? null, sourcePage: page?.pageNo ?? null }
}

function relationTitle(relation: Relation, query: Query): string | null {
  const source = query.interface === 'recognized_list' ? comparisonPosition(query, relation.sequenceNo).sourceRdjb : null
  const rowTitle = platformRowTitle(query.rdjb, relation.rawFields)
  return (source ? RDJB_TITLE_CODES[source] : null) ?? query.titleCode ?? RDJB_TITLE_CODES[rowTitle] ?? null
}

function queryCoverage(query: Query, currentTitles: ReadonlySet<string> | undefined) {
  const facts = query.comparisonFacts
  const present = facts.evidencePresent
  const completeness = present ? facts.collection.completeness : 'unknown'
  const fullRange = present && Boolean(facts.collection.fullRange)
  const unfinished = (present ? facts.unfinished : []).map(p => ({ rdjb: p.rdjb, page: p.pageNo }))
  const allPages = (present ? facts.pages : []).map(p => ({ rdjb: p.rdjb, page: p.pageNo, status: p.status, maxPage: p.maxPage, declaredTotal: p.declaredTotal, fetchedCount: p.fetchedCount ?? 0 }))
  const conditions = facts.conditions
  const reasons: string[] = []
  if (!present) reasons.push('collection_evidence_missing')
  if (query.status !== 'success' && query.status !== 'no_record') reasons.push(`query_${query.status}`)
  if (query.status === 'partial' || query.status === 'failed') reasons.push('incomplete_or_continuation')
  if (present && (completeness !== 'complete' || !fullRange || unfinished.length)) reasons.push('incomplete_or_continuation')
  const selected = present ? facts.scopes : query.rdjb.split(',').filter(Boolean)
  const unavailableTitles = new Set(allPages
    .filter(page => page.rdjb !== null && page.fetchedCount > 0 && !currentTitles?.has(page.rdjb))
    .map(page => page.rdjb))
  if (unavailableTitles.size) reasons.push('no_current_rows_for_positive_scope')
  const titleCoverage = selected.map(rdjb => {
    const pages = allPages.filter(page => page.rdjb === rdjb)
    const lastPage = pages.at(-1)
    const reachedEnd = lastPage?.maxPage != null ? lastPage.page === lastPage.maxPage
      : lastPage?.declaredTotal != null ? pages.reduce((count, page) => count + page.fetchedCount, 0) === lastPage.declaredTotal
        : lastPage?.fetchedCount === 0
    const complete = present && completeness === 'complete' && fullRange && !unavailableTitles.has(rdjb) &&
      !unfinished.some(position => position.rdjb === rdjb) && pages[0]?.page === 1 &&
      pages.every(page => page.status === 'success') && reachedEnd
    return { rdjb, titleCode: RDJB_TITLE_CODES[rdjb] ?? null, complete, pageCount: pages.length, unfinished: unfinished.filter(position => position.rdjb === rdjb).map(position => position.page) }
  })
  return { queryId: query.id, interface: query.interface, status: query.status, queriedAt: query.queriedAt, rdjb: query.rdjb, titleCode: query.titleCode, effectiveConditions: conditions, completeness, fullRange, titleCoverage, reasons }
}

function consistentScope(coverage: ReturnType<typeof queryCoverage>, title: string) {
  const titleUnit = coverage.titleCoverage.find(unit => unit.titleCode === title)
  const conditions = coverage.effectiveConditions
  return Boolean(titleUnit?.complete && conditions?.combination === 'and' && !conditions.name && !conditions.uscc && !conditions.sqsj && !conditions.rddqrq && !conditions.whpcyear && !conditions.whpc && !conditions.szq)
}

function exactQueryCoverage(coverage: ReturnType<typeof queryCoverage>, title: string, uscc: string | null) {
  const conditions = coverage.effectiveConditions
  return Boolean(coverage.titleCoverage.some(unit => unit.titleCode === title && unit.complete) && conditions?.combination === 'and' &&
    (!conditions.uscc || normalizeUscc(conditions.uscc) === normalizeUscc(uscc)) &&
    !conditions.name && !conditions.sqsj && !conditions.rddqrq && !conditions.whpcyear && !conditions.whpc && !conditions.szq)
}

function conclusion(event: Event, edges: Edge[], relations: Map<number, { relation: Relation; query: Query }>): { classification: HistoricalClassification; reasons: string[] } {
  // Keep legacy field conflicts visible even when the edge needs revalidation,
  // without hiding a contradiction proved by another valid same-event edge.
  const fieldConflictReasons = edges.some(edge => edge.status === 'confirmed' && edge.type === 'event_process' &&
    edge.relationId != null && relations.get(edge.relationId)?.relation.normalizationConflicts.length) ? ['platform_field_conflict'] : []
  const historical = edges.filter(edge => edge.status === 'confirmed' && !edge.requiresRevalidation && historicalEdge(edge))
  if (!historical.length && fieldConflictReasons.length) return { classification: 'unresolved', reasons: fieldConflictReasons }
  if (!historical.length) return { classification: 'unresolved', reasons: [...(event.year == null ? ['official_event_year_unknown'] : []), edges.some(edge => historicalEdge(edge) && edge.status === 'candidate') ? 'candidate_not_confirmed' : 'official_coverage_unproved'] }
  let supported = false
  let conflict = false
  const reasons: string[] = []
  for (const edge of historical) {
    if (edge.type === 'event_recognized') { reasons.push('recognized_row_has_no_verified_event_version'); continue }
    const source = edge.relationId == null ? null : relations.get(edge.relationId)
    if (!source) { reasons.push('selected_process_row_missing'); continue }
    const { relation } = source
    if (relation.normalizationConflicts.length) continue
    if (!processTimingMatches(event, relation)) { reasons.push('event_process_fact_or_timing_unknown'); continue }
    const status = String(relation.status ?? '')
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
  if (conflict) return { classification: 'historical_conflict', reasons: ['confirmed_same_event_status_conflict', ...fieldConflictReasons] }
  if (fieldConflictReasons.length) return { classification: 'unresolved', reasons: fieldConflictReasons }
  return supported ? { classification: 'historical_aligned', reasons: [] } : { classification: 'unresolved', reasons: unique(reasons) }
}

export function validatedComparisonInput(input: RecordComparisonInput) {
  const parsed = recordComparisonInput.parse(input)
  for (const key of ['queryIds', 'exportBatchIds', 'officialSourceDocumentIds'] as const) if (unique(parsed[key]).length !== parsed[key].length) throw new Error(`duplicate_${key}`)
  return parsed
}

export type SelectedRecordComparison = {
  input: ReturnType<typeof validatedComparisonInput>
  queries: Query[]
  batches: (typeof PlatformExportBatchTable.$inferSelect)[]
  documents: (OfficialSourceDocument & { contentIdentity: {
    registered: StoredFileContentIdentity | null
    status: 'unknown'
    historical: 'unknown'
  } })[]
  relations: Array<{ relation: Relation; query: Query }>
  exports: Array<{ row: Omit<typeof PlatformExportRowTable.$inferSelect, 'rawFields'> & { rawFields: null }; batch: typeof PlatformExportBatchTable.$inferSelect }>
  edges: Edge[]
  unavailableEdges: Edge[]
  businessMetadata: Map<number, BusinessMetadataRow>
}

export type FormalEvent = {
  event: Event
  record: Pick<typeof RecordTable.$inferSelect, 'id' | 'enterpriseId' | 'titleCode' | 'source' | 'usccRaw' | 'nameRaw'>
  uscc: string | null
  inSelectedSource: boolean
}

type FormalCount = { events: number; enterpriseTitles: number }

type PageEvidence = { evidence: typeof RecordEvidenceTable.$inferSelect; registered: StoredFileContentIdentity | null }

export type ComparisonRead =
  | undefined
  | { type: 'count' }
  | { type: 'events'; paths: string[]; laterOwners: Array<{ enterpriseId: number | null; titleCode: string }> }
  | { type: 'evidence'; ids: number[] }

export type ReadResult = FormalCount | Iterable<FormalEvent> | PageEvidence[] | undefined

export function* compareRecordInputs(source: SelectedRecordComparison) {
  const { queries, batches, documents, relations, exports, edges } = source
  const relationMap = new Map(relations.map(item => [item.relation.id, item]))
  const exportMap = new Map(exports.map(item => [item.row.id, item]))
  const documentPaths = new Set(documents.map(row => row.path))
  yield undefined
  const selectedEdges = edges.filter(edge => (edge.relationId == null || relationMap.has(edge.relationId)) && (edge.exportRowId == null || exportMap.has(edge.exportRowId)))
  const unavailableEdges = source.unavailableEdges.filter(edge => (edge.relationId == null || relationMap.has(edge.relationId)) && (edge.exportRowId == null || exportMap.has(edge.exportRowId)))
  const later = selectedEdges.filter(edge => edge.type === 'later_process' && edge.status === 'confirmed' && !edge.requiresRevalidation && edge.relationId != null && relationMap.has(edge.relationId))
  const edgesByEvent = groupBy(selectedEdges.filter(edge => edge.type !== 'later_process'), edge => edge.eventId)
  const unavailableEvents = new Set(unavailableEdges.filter(historicalEdge).map(edge => edge.eventId))
  const unavailableRelations = new Set(unavailableEdges.map(edge => edge.relationId))
  const laterByOwner = groupBy(later, edge => `${edge.enterpriseId}:${edge.titleCode}`)
  const laterByRelation = groupBy(later, edge => edge.relationId)
  const linkedRelationIds = new Set(selectedEdges.filter(edge => edge.eventId != null && edge.status === 'confirmed' && historicalEdge(edge)).map(edge => edge.relationId))
  const currentTitleScopes = new Map<number, Set<string>>()
  for (const { query, relation } of relations) {
    const { sourceRdjb } = comparisonPosition(query, relation.sequenceNo)
    if (sourceRdjb == null) continue
    let titles = currentTitleScopes.get(query.id)
    if (!titles) currentTitleScopes.set(query.id, titles = new Set())
    titles.add(sourceRdjb)
  }
  const coverage = queries.map(query => queryCoverage(query, currentTitleScopes.get(query.id)))
  const coverageByQuery = new Map(coverage.map(item => [item.queryId, item]))
  const coverageCache = new Map<string, boolean>()
  const covers = (title: string, uscc: string | null) => {
    const key = JSON.stringify([title, uscc])
    if (!coverageCache.has(key)) coverageCache.set(key, coverage.some(item => (item.interface === 'business_list' || item.interface === 'recognized_list') && exactQueryCoverage(item, title, uscc)))
    return coverageCache.get(key)!
  }
  const analyzeEvent = ({ event, record, uscc, inSelectedSource }: FormalEvent) => {
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
  const buildRow = ({ event, record, eventEdges, followups, decision }: ReturnType<typeof analyzeEvent>, officialEvidence: PageEvidence[]) => {
    const linked = unique(eventEdges.flatMap(edge => edge.relationId == null ? [] : [edge.relationId])).map(id => relationMap.get(id)).filter((item): item is NonNullable<typeof item> => !!item)
    return { event: { id: event.id, recordId: event.recordId, eventType: event.eventType, year: event.year, batchSeq: event.batchSeq, decidedYear: event.decidedYear, reviewOutcome: event.reviewOutcome }, record: { id: record.id, enterpriseId: record.enterpriseId, titleCode: record.titleCode, source: record.source, usccRaw: record.usccRaw, nameRaw: record.nameRaw }, evidence: officialEvidence.map(({ evidence: item, registered }) => ({ id: item.id, sourceFile: item.sourceFile, contentIdentity: { registered, status: 'unknown' as const, historical: 'unknown' as const }, attachment: item.attachment, listNo: item.listNo, page: item.page, inSelectedSource: documentPaths.has(item.sourceFile) })), classification: decision.classification, reasons: decision.reasons, correspondences: eventEdges.map(publicEdge), platformRows: linked.map(item => publicRelation(item.relation, item.query)), laterProcesses: followups.map(edge => ({ correspondence: publicEdge(edge), relation: publicRelation(relationMap.get(edge.relationId!)!.relation, relationMap.get(edge.relationId!)!.query) })) }
  }
  const pageEvents: ReturnType<typeof analyzeEvent>[] = []
  const countResult: ReadResult = yield { type: 'count' } as const
  const formalCounts = countResult as FormalCount
  const classificationCounts = { historical_aligned: 0, historical_conflict: 0, official_without_correspondence: 0, unresolved: formalCounts.events }
  let laterProcessAffectedEvents = 0
  let total = 0
  const officialEventRows = formalCounts.events
  let visited = 0
  const laterOwners = [...laterByOwner.values()].map(owners => ({ enterpriseId: owners[0]!.enterpriseId, titleCode: owners[0]!.titleCode }))
  const eventResult: ReadResult = yield { type: 'events', paths: documents.map(document => document.path), laterOwners } as const
  const formalEvents = eventResult as Iterable<FormalEvent>
  for (const formal of formalEvents) {
    if (++visited % 128 === 0) yield undefined
    const row = analyzeEvent(formal)
    classificationCounts.unresolved--
    classificationCounts[row.decision.classification]++
    if (row.followups.length) laterProcessAffectedEvents++
    if ((source.input.enterpriseId == null || row.record.enterpriseId === source.input.enterpriseId) && (!source.input.titleCode || row.record.titleCode === source.input.titleCode) && (!source.input.classification || row.decision.classification === source.input.classification)) {
      if (total >= (source.input.page - 1) * source.input.pageSize && total < source.input.page * source.input.pageSize) pageEvents.push(row)
      total++
    }
  }
  // Counts need light global facts, but only the emitted page needs complete
  // evidence.
  const rows: ReturnType<typeof buildRow>[] = []
  for (let offset = 0; offset < pageEvents.length; offset += 128) {
    const page = pageEvents.slice(offset, offset + 128)
    const evidenceResult: ReadResult = yield { type: 'evidence', ids: page.map(row => row.event.id) } as const
    const evidence = evidenceResult as PageEvidence[]
    const byEvent = groupBy(evidence, item => item.evidence.recordEventId)
    for (const row of page) rows.push(buildRow(row, byEvent.get(row.event.id) ?? []))
    yield undefined
  }
  const recognized = relations.filter(item => item.query.interface === 'recognized_list')
  const exportsByIdentity = groupBy(exports, item => JSON.stringify([item.batch.titleCode, normalizeUscc(item.row.usccRaw)]))
  const equivalenceUnknown = ['version_equivalence_unknown', 'export_scope_equivalence_unknown']
  const officialCoverageUnknown = 'official_source_completeness_not_persisted'
  const observations = recognized.map(({ relation, query }) => {
    const title = relationTitle(relation, query)
    const uscc = normalizeUscc(relation.usccRaw)
    const matches = uscc && title ? (exportsByIdentity.get(JSON.stringify([title, uscc])) ?? []) : []
    const reasons = [...equivalenceUnknown]
    if (!consistentScope(coverageByQuery.get(query.id)!, title ?? '')) reasons.push('query_conditions_or_completeness_not_comparable')
    if (!uscc || !title) reasons.push('row_identity_or_title_unknown')
    return {
      recognized: publicRelation(relation, query), exportRows: matches.map(item => publicExport(item.row, item.batch)),
      observation: matches.length ? 'same_uscc_title_observed' : 'no_matching_selected_export_observed',
      qualification: 'not_comparable' as const, reasons,
    }
  })
  const recognizedIdsByExport = new Map<number, number[]>()
  for (const observation of observations) for (const row of observation.exportRows) {
    const bucket = recognizedIdsByExport.get(row.id)
    if (bucket) bucket.push(observation.recognized.id)
    else recognizedIdsByExport.set(row.id, [observation.recognized.id])
  }
  const exportObservations = exports.map(({ row, batch }) => ({
    exportRow: publicExport(row, batch), recognizedRelationIds: recognizedIdsByExport.get(row.id) ?? [],
    qualification: 'not_comparable' as const, reasons: equivalenceUnknown,
  }))
  const laterRelationIds = new Set(later.map(edge => edge.relationId))
  const laterProcessPlatformRows = relations.filter(item => laterRelationIds.has(item.relation.id))
  const unlinkedPlatformRows = relations.filter(item => !linkedRelationIds.has(item.relation.id) && !laterRelationIds.has(item.relation.id))
  const counts = {
    officialEventRows, distinctEvents: officialEventRows, distinctPlatformRows: unique(relations.map(item => item.relation.id)).length,
    distinctEnterpriseTitles: formalCounts.enterpriseTitles, ...classificationCounts,
    laterProcessRows: unique(later.map(edge => edge.relationId)).length, laterProcessAffectedEvents,
    platformWithoutOfficialRows: 0, unresolvedPlatformRows: unlinkedPlatformRows.length,
    recognizedRows: recognized.length, exportRows: exports.length,
    observedRecognizedExportPairs: observations.reduce((n, item) => n + item.exportRows.length, 0), observedExportRows: recognizedIdsByExport.size,
  }
  const comparison = {
    rows, total, page: source.input.page, pageSize: source.input.pageSize,
    grain: { rows: 'official_event_id', platform: 'relation_id', export: 'batch_id_source_row_no', later: 'enterprise_id_title_code_relation_id' },
    counts,
    sourceSet: { queryIds: source.input.queryIds, exportBatchIds: source.input.exportBatchIds, officialSourceDocumentIds: source.input.officialSourceDocumentIds, asOf: source.input.asOf ?? null },
    coverage,
    officialCoverage: { qualification: 'unknown' as const, reasons: [officialCoverageUnknown], selectedDocumentIds: documents.map(row => row.id) },
    currentSourceConsistency: {
      qualification: 'not_comparable' as const,
      reasons: observations.length || exportObservations.length ? equivalenceUnknown : [],
      recognizedObservations: observations, exportObservations,
    },
    historicalDecisionUnavailable: unavailableEdges.map(edge => ({ id: edge.id, type: edge.type, eventId: edge.eventId, relationId: edge.relationId, reason: 'post_cutoff_decision_state_unavailable' as const })),
    platformWithoutOfficial: {
      rows: unlinkedPlatformRows.map(({ relation, query }) => ({
        relation: publicRelation(relation, query), qualification: 'unresolved' as const,
        reasons: [relation.enterpriseId == null || relation.verificationStatus !== 'confirmed' ? 'row_identity_unverified'
          : unavailableRelations.has(relation.id) ? 'post_cutoff_decision_state_unavailable' : officialCoverageUnknown],
      })),
      total: unlinkedPlatformRows.length,
    },
    laterProcessPlatformRows: laterProcessPlatformRows.map(item => ({ relation: publicRelation(item.relation, item.query), correspondences: (laterByRelation.get(item.relation.id) ?? []).map(publicEdge) })),
    exportBatches: batches.map(batch => ({ id: batch.id, titleCode: batch.titleCode, year: batch.year, collectedOn: batch.collectedOn, sha256: batch.sha256, rowCount: batch.rowCount, replacedBatchId: batch.replacedBatchId })),
  }
  // Add grouping only after the original observation-level comparison is complete.
  const byUnlinked = new Map(comparison.platformWithoutOfficial.rows.map(row => [row.relation.id, row]))
  const byCurrent = new Map(observations.map(row => [row.recognized.id, row]))
  const byCorrespondence = groupBy(selectedEdges, edge => edge.relationId)
  const byUnavailable = groupBy(comparison.historicalDecisionUnavailable, edge => edge.relationId)
  const scopedObservations = relations.filter(({ relation, query }) =>
    (source.input.enterpriseId == null || relation.enterpriseId === source.input.enterpriseId) &&
    (!source.input.titleCode || relationTitle(relation, query) === source.input.titleCode))
    .map(({ relation, query }) => {
      const meta = source.businessMetadata.get(relation.id)
      const groupState = !meta?.identityState ? 'not_indexed' : meta.identityState !== 'resolved' ? meta.identityState : meta.contentState !== 'verified' || meta.recordId == null || meta.versionId == null ? 'unverifiable' : 'verified'
      const businessRecord: PlatformBusinessMetadata = {
        recordId: meta?.recordId ?? null, versionId: meta?.versionId ?? null, interface: query.interface,
        platformKey: meta?.platformKey ?? null, groupState, identityState: meta?.identityState ?? 'not_indexed',
        contentState: meta?.contentState ?? 'not_indexed', keySource: meta?.keySource ?? null,
        projectionRuleVersion: meta?.projectionRuleVersion ?? null, hashAlgorithm: meta?.hashAlgorithm ?? null, contentHash: meta?.contentHash ?? null,
      }
      return {
        relation: publicRelation(relation, query), businessRecord,
        linkState: linkedRelationIds.has(relation.id) ? 'linked' as const : laterRelationIds.has(relation.id) ? 'later_process' as const : 'unlinked' as const,
        correspondences: (byCorrespondence.get(relation.id) ?? []).map(publicEdge),
        historicalDecisionUnavailable: byUnavailable.get(relation.id) ?? [],
        currentSource: byCurrent.get(relation.id) ?? null, withoutOfficial: byUnlinked.get(relation.id) ?? null,
      }
    })
  const business = groupComparisonBusinessObservations(scopedObservations, source.input.businessPage ?? 1, source.input.businessPageSize ?? 25)
  return { ...comparison, ...business, businessGroups: { ...business.businessGroups, scope: {
    queryIds: source.input.queryIds, asOf: source.input.asOf ? new Date(source.input.asOf).toISOString() : null,
    enterpriseId: source.input.enterpriseId ?? null, titleCode: source.input.titleCode ?? null,
    classificationApplied: false as const, countsBeforePagination: true as const,
    grain: 'known_record_with_verified_versions_and_unknown_content_or_isolated_unknown_identity' as const,
  } } }

}

export interface SourceEnterpriseLink {
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

type CatalogIdentity = ComparisonIdentity & { relationId: number; enterpriseName: string | null }

export function projectSourceEnterpriseLinks(relationRows: CatalogIdentity[], aliases: ReadonlyMap<string, { note: string | null }>) {
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

type CatalogCounts = { official_document: number; query: number; export_batch: number }

export function comparisonCatalogWindows(filter: ComparisonSourceCatalogInput, counts: CatalogCounts) {
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
  return { dw: window('official_document'), qw: window('query'), bw: window('export_batch') }
}

export function projectCatalogDocument(row: OfficialSourceDocument, registered: StoredFileContentIdentity | null) {
  return { kind: 'official_document' as const, id: row.id, label: row.title ?? fileNameOf(row.path), subtitle: row.docNumber, titleCode: null, titleName: null, observedAt: row.issueDate, status: 'available', selectable: true, path: row.path, contentIdentity: { registered, status: 'unknown' as const, historical: 'unknown' as const } }
}

export function projectCatalogQuery(row: typeof PlatformCollectionTable.$inferSelect & { conditions: Record<string, unknown> | null }, enterpriseLinks: ReturnType<typeof projectSourceEnterpriseLinks>) {
  return { kind: 'query' as const, id: row.id, label: `${row.interface === 'business_list' ? '业务关联' : row.interface === 'apply_list' ? '申报流程' : '已认定名单'} · ${row.titleCode ? TITLES[row.titleCode] : row.rdjb || '多称号'} · ${row.queryKey}`, subtitle: row.interface, titleCode: row.titleCode, titleName: row.titleCode ? TITLES[row.titleCode] : null, observedAt: row.queriedAt, status: row.status, selectable: true, rdjb: row.rdjb, completeness: row.completeness ?? 'unknown', fullRange: Boolean(row.fullRange), conditions: row.conditions, ...(enterpriseLinks.get(row.id) ?? { confirmedEnterprises: [], recordNames: [] }) }
}

export function projectCatalogExport(row: typeof PlatformExportBatchTable.$inferSelect) {
  return { kind: 'export_batch' as const, id: row.id, label: `${TITLES[row.titleCode]} · ${row.year} · ${row.originalFilename}`, subtitle: row.originalFilename, titleCode: row.titleCode, titleName: TITLES[row.titleCode], observedAt: row.collectedOn, status: row.importStatus, selectable: row.importStatus === 'imported', sha256: row.sha256, rowCount: row.rowCount, replacedBatchId: row.replacedBatchId }
}
