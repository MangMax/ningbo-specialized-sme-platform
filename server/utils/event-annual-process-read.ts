import type Database from 'better-sqlite3'
import { and,asc,eq,inArray,or,sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { alias } from 'drizzle-orm/sqlite-core'
import { createHash } from 'node:crypto'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import type { PlatformBusinessGroup,ScopedPlatformObservation } from '../../lib/platform/business-record'
import type { PlatformObservationFact } from '../../lib/platform/observation-facts'
import { targetSchema } from '../../lib/platform/target-schema'
import { ANNUAL_PROCESS_RULE_VERSION,buildAnnualProcess,type AnnualProcessCoverage,type AnnualProcessScopeGap,type AnnualProcessSourceRefs,type EventAnnualProcessRead } from '../../lib/roster/annual-process'
import { identityFunctions } from '../../lib/roster/enterprise-read-snapshot'
import { ANNUAL_COMPARISON_RAW_LIMIT,readTargetAnnualHistory,readTargetAnnualSources } from './annual-process-target-sources'
import { readPlatformBusinessGroups,readPlatformBusinessMetadata } from './platform-business-record-read'
import { correspondenceTable,externalRelationColumn } from './record-correspondence-store'

type Db = BetterSQLite3Database<typeof schema>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export type { AnnualProcessSourceRefs,EventAnnualProcessRead } from '../../lib/roster/annual-process'

/** Complete current archived event scope. No preflight, ledger writes, projection or network access.
 * Display pagination belongs to the public adapter, after this full-scope qualification.
 */
export function readEventAnnualProcess(db: Db, eventId: number): EventAnnualProcessRead | null {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('Invalid event ID')
  return db.transaction(() => readSnapshot(db, eventId))
}
type ScalarQuery = { toSQL(): { sql: string; params: unknown[] } }
type Rows = Array<{ id: number; queryId: number; sequenceNo: number; relationKey: string | null; enterpriseId: number | null; usccRaw: string | null; nameRaw: string | null; verificationStatus: 'confirmed' | 'pending'; matchBasis: 'uscc' | 'alias' | 'manual' | 'none'; declareKind: string | null; appliedAt: string | null; year: number | null; province: string | null; batch: string | null; awardBatchLabel: string | null; status: string | Buffer | null; rawFields: Record<string, unknown> | null; sourcePage: number | null; sourceRdjb: string | null; identityOnlySource: number }>
type Titles = Array<{ relationId: number; queryId: number; relationKey: string | null; usccRaw: string | null; titleCode: string | null }>
type Queries = Array<{ queryId: number; interface: 'apply_list' | 'business_list' | 'recognized_list'; queryKey: string; rdjb: string; titleCode: string | null; queriedAt: string; status: 'success' | 'failed' | 'no_record' | 'not_queried' | 'partial'; completeness: string | null; fullRangeValue: number | null }>
function eventScope(db: Db, eventId: number, admitHeader?: (query: ScalarQuery, keys: string[]) => void) {
  const v = schema.recordEvent, rec = schema.record, ent = schema.enterprise
  // Explicit event projection: the admitted header has a fixed arity, so a new
  // record_event column must not widen it or silently change the source digest.
  const headerQuery = db.select({ event: { id: v.id, recordId: v.recordId, eventType: v.eventType, year: v.year, batchSeq: v.batchSeq, sortKey: v.sortKey, reviewOutcome: v.reviewOutcome, decidedYear: v.decidedYear, revision: v.revision }, record: { id: rec.id, enterpriseId: rec.enterpriseId, titleCode: rec.titleCode, usccRaw: rec.usccRaw, source: rec.source }, enterprise: { nameNorm: ent.nameNorm, usccNorm: ent.usccNorm } })
    .from(v).innerJoin(rec, eq(v.recordId, rec.id)).innerJoin(ent, eq(rec.enterpriseId, ent.id)).where(eq(v.id, eventId))
  admitHeader?.(headerQuery, ['id', 'recordId', 'eventType', 'year', 'batchSeq', 'sortKey', 'reviewOutcome', 'decidedYear', 'revision', 'record_id', 'enterpriseId', 'titleCode', 'usccRaw', 'source', 'nameNorm', 'usccNorm'])
  const joined = headerQuery.get()
  if (!joined || joined.record.source !== 'jxj' || !['award', 'review'].includes(joined.event.eventType)) return null
  const event = { id: joined.event.id, eventType: joined.event.eventType, year: joined.event.year, decidedYear: joined.event.decidedYear, reviewOutcome: joined.event.reviewOutcome,
    record: { enterpriseId: joined.record.enterpriseId, titleCode: joined.record.titleCode, usccRaw: joined.record.usccRaw ?? joined.enterprise.usccNorm } }
  const owner = event.record.enterpriseId, titleCode = event.record.titleCode
  const identity = normalizeUscc(event.record.usccRaw)
  const businessYear = event.eventType === 'review' ? event.decidedYear : event.year
  const kind: 'review' | 'apply' = event.eventType === 'review' ? 'review' : 'apply'
  return { headerQuery, joined, event, owner, titleCode, businessYear, kind, identity }
}
function prepareObservations(scope: NonNullable<ReturnType<typeof eventScope>>, rows: Rows, titleScopeRows: Titles, queries: Queries, metadata: ReturnType<typeof readPlatformBusinessMetadata>, suppliedFacts: Map<number, PlatformObservationFact>) {
  const { joined, event, owner, titleCode, businessYear, kind } = scope
  const eventId = event.id
  const coverage: AnnualProcessCoverage[] = queries.map(row => ({ queryId: row.queryId, interface: row.interface, queriedAt: row.queriedAt, status: row.status, completeness: row.completeness, fullRange: row.fullRangeValue == null ? null : row.fullRangeValue === 1 }))
  const queryMap = new Map(queries.map(row => [row.queryId, row]))
  const normalizedRows = rows.map(row => {
    const facts = suppliedFacts.get(row.id)
    if (!facts) throw new Error('annual_observation_fact_missing')
    return { row, query: queryMap.get(row.queryId)!, facts }
  })
  const keyOf = (row: typeof rows[number]) => row.relationKey?.trim() || metadata.get(row.id)?.platformKey || null
  const titleSeeds = normalizedRows.filter(({ query }) => query.titleCode === titleCode || query.rdjb === ({ innovative_sme: '1', specialized_sme: '2', little_giant: '3' } as Record<string, string>)[titleCode])
  const stable = ['declareKind', 'appliedAt', 'year', 'province', 'batch', 'awardBatchLabel'] as const
  const scopeGaps: AnnualProcessScopeGap[] = []
  const unresolvedSources: AnnualProcessSourceRefs['observations'] = []
  const observations: ScopedPlatformObservation[] = normalizedRows.flatMap(({ row, query, facts: f }) => {
    const explicitTitle = query.titleCode ?? ({ '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' } as Record<string, string>)[query.rdjb] ?? null
    const explicitTitles = new Set(titleScopeRows.filter(w => normalizeUscc(w.usccRaw) === normalizeUscc(row.usccRaw) && (w.relationKey?.trim() || metadata.get(w.relationId)?.platformKey) === keyOf(row)).map(w => w.titleCode).filter(Boolean))
    // A uniquely known other native title is outside this event, not a gap in it.
    if (!explicitTitle && explicitTitles.size === 1 && !explicitTitles.has(titleCode)) return []
    const titleWitnesses = explicitTitle || explicitTitles.size !== 1 || !explicitTitles.has(titleCode) ? [] : titleSeeds.filter(seed =>
      seed.query.interface !== query.interface && keyOf(seed.row) && keyOf(seed.row) === keyOf(row) && normalizeUscc(row.usccRaw) && normalizeUscc(row.usccRaw) === normalizeUscc(seed.row.usccRaw) &&
      metadata.get(row.id)?.identityState === 'resolved' && metadata.get(seed.row.id)?.identityState === 'resolved' &&
      !f.normalizationConflicts.length && !seed.facts.normalizationConflicts.length && f.declareKind && seed.facts.declareKind && f.appliedAt && seed.facts.appliedAt &&
      stable.every(field => f[field] == null || seed.facts[field] == null || f[field] === seed.facts[field]))
    // queryList has no native title column. Only a matching independently titled
    // business observation may establish this new annual view's title lineage.
    // Original queryTitleCode stays null, and no old proof boundary is expanded.
    if (!explicitTitle && !titleWitnesses.length) {
      const identityOnly = row.identityOnlySource === 1 && !keyOf(row) && !f.declareKind && !f.appliedAt && !f.status && !f.normalizationConflicts.length
      if (!identityOnly && (!f.declareKind || !['apply', 'review', 'update'].includes(f.declareKind) || f.declareKind === kind) && (businessYear == null || f.year == null || f.year === businessYear)) {
        scopeGaps.push({ relationId: row.id, queryId: row.queryId, interface: query.interface, year: f.year, declareKind: f.declareKind, appliedAt: f.appliedAt, reasons: [explicitTitles.size > 1 ? 'title_scope_conflict' : 'title_scope_unknown'] })
        unresolvedSources.push({ queryId: row.queryId, relationId: row.id, interface: query.interface, recordId: metadata.get(row.id)?.recordId ?? null, versionId: metadata.get(row.id)?.versionId ?? null,
          sourceFingerprint: hash({ query, relationId: row.id, relationKey: row.relationKey, enterpriseId: row.enterpriseId, usccRaw: row.usccRaw, nameRaw: row.nameRaw, verificationStatus: row.verificationStatus, matchBasis: row.matchBasis,
            facts: { declareKind: f.declareKind, year: f.year, appliedAt: f.appliedAt, status: f.status, province: f.province, batch: f.batch, awardBatchLabel: f.awardBatchLabel, conflicts: f.normalizationConflicts }, metadata: metadata.get(row.id), explicitTitles: [...explicitTitles].sort() }) })
      }
      return []
    }
    // Scope role before shared grouping; explicit year may require its same-business donor.
    if (f.declareKind && ['apply', 'review', 'update'].includes(f.declareKind) && f.declareKind !== kind) return []
    const conflicts: string[] = []
    // Native title does not override another explicit title for the same code/key.
    // Preserve each observation while preventing cross-interface fact borrowing.
    if (explicitTitles.size > 1) conflicts.push('title_scope_conflict')
    if (!normalizeUscc(row.usccRaw) && !(row.enterpriseId === owner && row.verificationStatus === 'confirmed')) conflicts.push('identity_unknown')
    if (!['success', 'partial'].includes(query.status)) conflicts.push('query_observation_unusable')
    return [{ relationId: row.id, queryId: row.queryId, sequenceNo: row.sequenceNo, interface: query.interface, relationKey: row.relationKey,
      queriedAt: query.queriedAt, queryStatus: query.status, queryKey: query.queryKey, rdjb: query.rdjb, queryTitleCode: query.titleCode, titleCode,
      enterpriseId: row.enterpriseId, usccRaw: row.usccRaw, nameRaw: row.nameRaw, verificationStatus: row.verificationStatus, matchBasis: row.matchBasis,
      target: { eventId, enterpriseId: owner, titleCode, type: 'event_process', role: 'context_only' },
      evidence: { title: { official: titleCode, row: explicitTitle, corroboratedByRelationIds: titleWitnesses.map(w => w.row.id), basis: explicitTitle ? 'explicit_query_title' : 'same_uscc_key_stable_facts' }, process: { eventType: event.eventType, declareKind: f.declareKind, appliedAt: f.appliedAt, status: f.status, province: f.province, normalizationConflicts: f.normalizationConflicts },
        temporal: { relationYear: f.year, relationBatch: f.batch, awardBatchLabel: f.awardBatchLabel },
        source: { interface: query.interface, queryId: row.queryId, relationId: row.id, sequenceNo: row.sequenceNo, queriedAt: query.queriedAt, status: query.status, sourceRdjb: row.sourceRdjb ?? (query.rdjb || null), sourcePage: row.sourcePage, identityOnly: row.identityOnlySource === 1 } }, conflicts }]
  })
  return { joined, event, owner, titleCode, businessYear, kind, coverage, scopeGaps, unresolvedSources, observations, titleScopeRows, metadata }
}
function evidenceFields() {
  const e = schema.recordEvidence, file = schema.storedFile
  return { id: e.id, sourceFile: e.sourceFile, attachment: e.attachment, listNo: e.listNo, page: e.page, fileId: file.id, sha256: file.sha256, removedAt: file.removedAt }
}
function evidenceQuery(db: Db, eventId: number) {
  const e = schema.recordEvidence, file = schema.storedFile
  return db.select(evidenceFields())
    .from(e).leftJoin(file, eq(file.relPath, e.sourceFile)).where(eq(e.recordEventId, eventId)).orderBy(asc(e.id))
}
function finishRead(prepared: ReturnType<typeof prepareObservations>, groups: PlatformBusinessGroup[], loadEvidence: () => ReturnType<ReturnType<typeof evidenceQuery>['all']>) {
  const { joined, event, owner, titleCode, businessYear, kind, coverage, scopeGaps, unresolvedSources, titleScopeRows, metadata } = prepared
  const process = buildAnnualProcess({ event, groups, coverage, scopeGaps })
  const evidence = loadEvidence()
  const sourceRefs: AnnualProcessSourceRefs = {
    scope: { enterpriseId: owner, titleCode, businessYear, declareKind: kind, ruleVersion: ANNUAL_PROCESS_RULE_VERSION },
    // Explicit event projection: a new record_event column must never widen the
    // admitted header or silently change the source digest shape.
    event: { id: joined.event.id, recordId: joined.event.recordId, eventType: joined.event.eventType, year: joined.event.year,
      batchSeq: joined.event.batchSeq, sortKey: joined.event.sortKey, reviewOutcome: joined.event.reviewOutcome,
      decidedYear: joined.event.decidedYear, revision: joined.event.revision, usccRaw: event.record.usccRaw }, evidence,
    titleScopeRefs: titleScopeRows.map(row => ({ queryId: row.queryId, relationId: row.relationId, titleCode: row.titleCode, platformKey: row.relationKey?.trim() || metadata.get(row.relationId)?.platformKey || null, usccNorm: normalizeUscc(row.usccRaw), recordId: metadata.get(row.relationId)?.recordId ?? null, versionId: metadata.get(row.relationId)?.versionId ?? null })),
    observations: [...unresolvedSources, ...groups.flatMap(g => g.observationRefs.map(ref => ({ queryId: ref.queryId, relationId: ref.relationId, interface: ref.interface,
      recordId: ref.businessRecord.recordId, versionId: ref.businessRecord.versionId,
      // Deliberately exclude all existingCorrespondence* and decision conflicts.
      sourceFingerprint: hash({ queryId: ref.queryId, relationId: ref.relationId, sequenceNo: ref.sequenceNo, interface: ref.interface, relationKey: ref.relationKey, queriedAt: ref.queriedAt, queryStatus: ref.queryStatus,
        queryKey: ref.queryKey, rdjb: ref.rdjb, queryTitleCode: ref.queryTitleCode, titleCode: ref.titleCode, enterpriseId: ref.enterpriseId, usccRaw: ref.usccRaw, nameRaw: ref.nameRaw, verificationStatus: ref.verificationStatus, matchBasis: ref.matchBasis,
        businessRecord: ref.businessRecord, target: ref.target, evidence: ref.evidence, conflicts: ref.conflicts.filter(c => c !== 'correspondence_decision_conflict') }),
    })))].sort((a, b) => a.relationId - b.relationId), coverage,
  }
  return { input: { event, groups, coverage, scopeGaps }, read: { process, sourceRefs, sourceGeneration: hash(sourceRefs) } }
}
function readSnapshot(db: Db, eventId: number): EventAnnualProcessRead | null {
  return readAnnualProcessBatch(db, [eventId]).get(eventId)?.read ?? null

}

/** One source context for a request, shared by events of the same enterprise/title.
 * No context survives the transaction or supplies facts to another request. */
export function readAnnualProcessBatch(db: Db, eventIds: readonly number[], includeUnknownBusinessTitle = false) {

  const scopes = [...new Set(eventIds)].flatMap(id => {
    const scope = eventScope(db, id)
    return scope ? [scope] : []
  })
  const sources = readTargetAnnualSources(db, scopes, includeUnknownBusinessTitle)
  const metadata = readPlatformBusinessMetadata(db, [...new Set([...sources.values()].flatMap(s => [...s.rows.map(r => r.id), ...s.titles.map(t => t.relationId)]))])
  const prepared = scopes.map(scope => {
    const source = sources.get(scope.event.id)!
    // The comparison seam historically reconciles stored/raw observation fields;
    // the annual read uses version facts. Preserve that existing distinction.
    const facts = includeUnknownBusinessTitle ? new Map([...source.facts].map(([id, f]) => [id, f.interface === 'business_list' ? { ...f, ...f.archiveProcessFacts } : { ...f, ...f.archiveProcessFacts }])) : source.facts
    return prepareObservations(scope, source.rows, source.titles, source.queries, metadata, facts)
  })
  const groups = readPlatformBusinessGroups(db, prepared.flatMap(p => p.observations), metadata)
  const e = schema.recordEvidence, file = schema.storedFile
  const evidence = eventIds.length ? db.select({ ...evidenceFields(), eventId: e.recordEventId }).from(e).leftJoin(file, eq(file.relPath, e.sourceFile)).where(inArray(e.recordEventId, [...eventIds])).orderBy(e.id).all() : []
  const byEvent = Map.groupBy(evidence, e => e.eventId)
  return new Map(prepared.map(p => [p.event.id, finishRead(p, groups.filter(g => g.observationRefs[0]?.target.eventId === p.event.id),
    () => (byEvent.get(p.event.id) ?? []).map(({ eventId: _eventId, ...row }) => row))]))
}

export type AnnualEventScope = NonNullable<ReturnType<typeof eventScope>>
export type AnnualSourceRows = { rows: Rows; titles: Titles; queries: Queries; facts: Map<number, PlatformObservationFact> }

/** Stricter admission for the explicit comparison only. W is a policy charge,
 * not an output, heap or RSS bound. All SQL scans remain data dependent. */
const comparisonCaps = { rows: 64, titles: 64, history: 128, decisions: 128, evidence: 160, raw: ANNUAL_COMPARISON_RAW_LIMIT, proof: 4096, proofElements: 100, scalar: 1048576, source: 65536, charge: 16777216 } as const
const unavailable = (): never => { throw new Error('platform_comparison_scope_unavailable') }
const resource = (): never => { throw new Error('input_resource_limit') }
type ClosureMetadata = ReturnType<typeof readPlatformBusinessMetadata> extends Map<number, infer M> ? M : never
type ClosureNode = ClosureMetadata & { queryId: number; relationKey: string | null; usccRaw: string | null; isAnnualRow: number }
type ClosureHistory = { recordId: number; relationId: number; queryId: number }
type ClosureQuery = { id: number; interface: string; title_code: string | null; rdjb: string; structuredTitle: string | null }
type ClosureDecision = { relationId: number; eventId: number | null; predecessorEventId: number | null; enterpriseId: number | null; titleCode: string }
const closureTitles: Record<string, string> = { '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' }

/** Applicability only. Collection completion remains with the original validators/core. */
function closureQueryTitle(query: ClosureQuery): string | null { return query.structuredTitle }
/** Private, once per admitted closure. No supplied facts or persistent classification cache. */
function classifyComparisonClosure(nodes: ClosureNode[], history: ClosureHistory[], queries: ClosureQuery[], decisions: ClosureDecision[], request: { enterpriseId: number; titleCode: string; eventIds: readonly number[] }) {
  const parent = nodes.map((_, index) => index)
  const root = (index: number): number => {
    let cursor = index
    while (parent[cursor] !== cursor) { parent[cursor] = parent[parent[cursor]!]!; cursor = parent[cursor]! }
    return cursor
  }
  const join = (a: number, b: number) => { parent[root(b)] = root(a) }
  const records = new Map<number, number>(), keys = new Map<string, number>(), relations = new Map<number, number>()
  const titles = new Map(queries.map(query => [query.id, closureQueryTitle(query)]))
  const queryNodes = new Map<number, number[]>()
  const attach = (queryId: number, index: number) => { const list = queryNodes.get(queryId) ?? []; list.push(index); queryNodes.set(queryId, list) }
  for (const [index, node] of nodes.entries()) {
    relations.set(node.relationId, index); attach(node.queryId, index)
    if (node.recordId !== null) {
      const prior = records.get(node.recordId)
      if (prior !== undefined) join(prior, index)
      else records.set(node.recordId, index)
    }
    const uscc = normalizeUscc(node.usccRaw), key = node.relationKey?.trim() || node.platformKey || null
    if (uscc && key) {
      const identity = JSON.stringify([uscc, key]), prior = keys.get(identity)
      if (prior !== undefined) join(prior, index)
      else keys.set(identity, index)
    }
  }
  for (const row of history) {
    const index = records.get(row.recordId)
    if (index === undefined) unavailable()
    relations.set(row.relationId, index!); attach(row.queryId, index!)
  }
  const current = new Set<number>(), unknown = new Set<number>()
  for (const [index, node] of nodes.entries()) {
    if (node.isAnnualRow) current.add(root(index))
    if (node.recordId === null && !(normalizeUscc(node.usccRaw) && (node.relationKey?.trim() || node.platformKey))) unknown.add(root(index))
  }
  for (const [queryId, indices] of queryNodes) for (const index of indices) {
    const title = titles.get(queryId)
    if (!title) unknown.add(root(index))
    else if (title === request.titleCode) current.add(root(index))
  }
  const events = new Set(request.eventIds)
  for (const decision of decisions) {
    // Status is not a current-target predicate; other own rejection/unlink stays other.
    if ((decision.eventId !== null && events.has(decision.eventId)) || (decision.predecessorEventId !== null && events.has(decision.predecessorEventId)) || (decision.enterpriseId === request.enterpriseId && decision.titleCode === request.titleCode)) {
      const index = relations.get(decision.relationId)
      if (index === undefined) unavailable()
      current.add(root(index!))
    }
  }
  const metadataOnly = new Set<number>()
  for (const query of queries) {
    const title = titles.get(query.id)
    if (title && title !== request.titleCode && (queryNodes.get(query.id) ?? []).every(index => !current.has(root(index)) && !unknown.has(root(index)))) metadataOnly.add(query.id)
  }
  return { metadataOnly, hasCurrentRoot: current.size > 0 }
}

/** ID-only internal seam. No external facts, normalizer, eligibility or loader. */
export function readAnnualComparisonBatch(sqlite: Database.Database, db: Db, request: { enterpriseId: number; titleCode: string; eventIds: readonly number[]; selectedQueryIds: readonly number[] }) {
  if (!sqlite.inTransaction) unavailable()
  return readTargetAnnualComparisonBatch(db, request)

}

/** Target annual-input seam only. General comparison discovery remains its own
 * consumer. Keep the existing annual row/source limits and explicit query closure. */
function readTargetAnnualComparisonBatch(db: Db, request: { enterpriseId: number; titleCode: string; eventIds: readonly number[]; selectedQueryIds: readonly number[] }) {
  identityFunctions(db)
  const ids = [...new Set(request.eventIds)], selected = new Set(request.selectedQueryIds)
  if (ids.length > 40 || selected.size > 50) resource()
  if ([...ids, ...selected].some(id => !Number.isSafeInteger(id) || id <= 0)) unavailable()
  const scopes = ids.map(id => eventScope(db, id))
  if (scopes.some(scope => !scope || scope.owner !== request.enterpriseId || scope.titleCode !== request.titleCode)) unavailable()
  const c = correspondenceTable(db), relation = externalRelationColumn(db)
  const decisions = db.select({ relationId: relation, eventId: c.eventId, predecessorEventId: c.predecessorEventId, enterpriseId: c.enterpriseId, titleCode: c.titleCode }).from(c).where(or(inArray(c.eventId, ids), inArray(c.predecessorEventId, ids), and(eq(c.enterpriseId, request.enterpriseId), eq(c.titleCode, request.titleCode)))).all()
  if (decisions.length > comparisonCaps.decisions) resource()
  const reads = readAnnualProcessBatch(db, ids, true)
  const entries = [...reads.values()]
  const refs = entries.flatMap(e => e.read.sourceRefs.observations)
  const titleRefs = entries.flatMap(e => e.read.sourceRefs.titleScopeRefs)
  const recordIds = [...new Set([...refs, ...titleRefs].flatMap(r => r.recordId === null ? [] : [r.recordId]))]
  const history = readTargetAnnualHistory(db, recordIds)
  const protectedIds = new Set([...refs.map(r => r.relationId), ...titleRefs.map(r => r.relationId), ...[...history.values()].flat()])
  if (decisions.some(d => d.relationId === null || !protectedIds.has(d.relationId))) unavailable()
  if (new Set(refs.map(r => r.relationId)).size > comparisonCaps.rows || new Set(titleRefs.map(r => r.relationId)).size > comparisonCaps.titles || [...history.values()].flat().length > comparisonCaps.history) resource()
  const ra = targetSchema.platformLegacyRelationAlias, o = targetSchema.platformBusinessObservation, qa = schema.platformLegacyQueryAlias
  const historicalQueries = protectedIds.size ? db.select({ recordId: o.recordId, relationId: ra.oldId, queryId: qa.oldId }).from(ra).innerJoin(o, eq(o.id, ra.observationId)).innerJoin(qa, eq(qa.collectionId, o.collectionId)).where(inArray(ra.oldId, [...protectedIds])).all() : []
  const requiredQueries = new Set([...entries.flatMap(e => e.read.sourceRefs.coverage.map(c => c.queryId)), ...titleRefs.map(r => r.queryId), ...historicalQueries.map(q => q.queryId)])
  const collection = schema.platformCollection
  const queryRows = requiredQueries.size ? db.select({ id: qa.oldId, collection }).from(qa).innerJoin(collection, eq(collection.id, qa.collectionId)).where(inArray(qa.oldId, [...requiredQueries])).all() : []
  const collectionIds = queryRows.map(q => q.collection.id)
  const pages = collectionIds.length ? db.select().from(schema.platformCollectionPage).where(inArray(schema.platformCollectionPage.collectionId, collectionIds)).all() : []
  const titleScope = targetSchema.platformQueryTitleScope
  const titleScopes = collectionIds.length ? db.select().from(titleScope).where(inArray(titleScope.collectionId, collectionIds)).all() : []
  const queries: ClosureQuery[] = queryRows.map(({ id, collection: q }) => {
    const levels = q.rdjb.split(',').filter(Boolean)
    const title = q.titleCode ?? (levels.length === 1 ? closureTitles[levels[0]!] : null)
    const valid = q.interface === 'business_list' && title && levels.every(level => closureTitles[level] === title) &&
      (q.parseState === 'absent' || q.scopeMode === 'selected' && titleScopes.some(s => s.collectionId === q.id) &&
        titleScopes.filter(s => s.collectionId === q.id).every(s => closureTitles[s.rdjb] === title) &&
        pages.filter(p => p.collectionId === q.id).every(p => p.rdjb !== null && closureTitles[p.rdjb] === title))
    return { id, interface: q.interface, title_code: q.titleCode, rdjb: q.rdjb, structuredTitle: valid ? title : null }
  })
  const metadata = readPlatformBusinessMetadata(db, [...protectedIds])
  const queryByRelation = new Map(historicalQueries.map(row => [row.relationId, row.queryId]))
  const titlesByRelation = new Map(titleRefs.map(row => [row.relationId, row]))
  const annualIds = new Set(refs.map(r => r.relationId))
  const nodes: ClosureNode[] = [...metadata.values()].map(row => ({ ...row, queryId: queryByRelation.get(row.relationId)!, relationKey: titlesByRelation.get(row.relationId)?.platformKey ?? row.platformKey,
    usccRaw: titlesByRelation.get(row.relationId)?.usccNorm ?? null, isAnnualRow: annualIds.has(row.relationId) ? 1 : 0 }))
  const classification = classifyComparisonClosure(nodes, historicalQueries.flatMap(row => row.recordId === null ? [] : [{ ...row, recordId: row.recordId }]), queries, decisions.flatMap(d => d.relationId === null ? [] : [{ ...d, relationId: d.relationId }]), request)
  if ([...requiredQueries].some(id => !selected.has(id) && !classification.metadataOnly.has(id))) unavailable()
  if (pages.length > 50 * Math.max(1, queryRows.length) || queryRows.some(q => pages.filter(p => p.collectionId === q.collection.id).length > 50)) resource()
  if (entries.some(e => e.read.sourceRefs.evidence.length > comparisonCaps.evidence)) resource()
  const actualSourceBytes = entries.map(e => Buffer.byteLength(JSON.stringify(e.read.sourceRefs)))
  if (actualSourceBytes.some(n => n > comparisonCaps.source)) resource()
  const uniqueScalarBytes = Buffer.byteLength(JSON.stringify({ sources: entries.map(e => e.read.sourceRefs), history: [...history], decisions }))
  if (uniqueScalarBytes > comparisonCaps.scalar) resource()
  const expandedCharge = uniqueScalarBytes * (1 + 16 * ids.length)
  if (expandedCharge > comparisonCaps.charge) resource()
  if (!refs.length && !titleRefs.length) {
    if (entries.some(e => e.read.sourceRefs.coverage.some(c => c.completeness !== 'complete' || c.fullRange !== true || !['success', 'no_record'].includes(c.status)))) unavailable()
    if (!ids.length) {
      const owner = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, request.enterpriseId)).get()
      if (!owner) return unavailable()
      const a = targetSchema.platformObservationAssignment, original = alias(a, 'annual_empty_original')
      const related = db.select({ id: o.collectionId }).from(o).innerJoin(a, eq(a.observationId, o.id)).innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
        .where(or(eq(a.enterpriseId, request.enterpriseId), owner.usccNorm ? sql`roster84_uscc(${original.usccRaw}) = ${owner.usccNorm}` : sql`0`))
      const collection = schema.platformCollection
      const aliases = db.select({ name: schema.enterpriseAlias.nameNorm }).from(schema.enterpriseAlias).where(and(eq(schema.enterpriseAlias.enterpriseId, owner.id), eq(schema.enterpriseAlias.verificationStatus, 'confirmed'))).all()
      const keys = [owner.usccNorm ?? '', `name:${owner.nameNorm}`, ...aliases.map(a => `name:${a.name}`)]
      if (db.select({ id: collection.id }).from(collection).where(and(inArray(collection.interface, ['apply_list', 'business_list']), or(inArray(collection.queryKey, keys), inArray(collection.id, related)))).limit(1).get()) unavailable()
    }
    return { kind: 'absent' as const, entries: [], history, admission: { kind: 'scope_closure' as const, uniqueScalarBytes, expandedCharge: null, sourceUpperBytes: [] as number[], actualSourceBytes: [] as number[] } }
  }
  return { kind: 'present' as const, entries, history, admission: { kind: 'annual' as const, uniqueScalarBytes, expandedCharge, sourceUpperBytes: actualSourceBytes, actualSourceBytes } }
}
