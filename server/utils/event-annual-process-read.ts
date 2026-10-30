import { identityFunctions } from '../../lib/roster/enterprise-read-snapshot'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { normalizePlatformRelation, PLATFORM_PROCESS_RAW_KEYS, platformProcessRawFromJson } from '../../lib/platform/normalization'
import type { ScopedPlatformObservation, PlatformBusinessGroup } from '../../lib/platform/business-record'
import { ANNUAL_PROCESS_RULE_VERSION, buildAnnualProcess, type AnnualProcessCoverage, type AnnualProcessScopeGap, type AnnualProcessSourceRefs, type EventAnnualProcessRead } from '../../lib/roster/annual-process'
import { readPlatformBusinessGroups, readPlatformBusinessMetadata } from './platform-business-record-read'
import { normalizedUscc } from './event-archive-discovery'
import { platformQueryResultShape } from '../../lib/platform/live-query'

type Db = BetterSQLite3Database<typeof schema>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export type { AnnualProcessSourceRefs, EventAnnualProcessRead } from '../../lib/roster/annual-process'

/** Complete current archived event scope. No preflight, ledger writes, projection or network access.
 * Display pagination belongs to the public adapter, after this full-scope qualification.
 */
export function readEventAnnualProcess(db: Db, eventId: number): EventAnnualProcessRead | null {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('Invalid event ID')
  return db.transaction(() => readSnapshot(db, eventId))
}
type ScalarQuery = { toSQL(): { sql: string; params: unknown[] } }
type Scope = NonNullable<ReturnType<typeof sourceScope>>
type Rows = ReturnType<Scope['rowsQuery']['all']>
type Titles = ReturnType<Scope['titlesQuery']['all']>
type Queries = ReturnType<Scope['queriesQuery']['all']>
function sourceScope(db: Db, eventId: number, admitHeader?: (query: ScalarQuery, keys: string[]) => void, includeUnknownBusinessTitle = false) {
  const v = schema.recordEvent, rec = schema.record, ent = schema.enterprise
  const headerQuery = db.select({ event: v, record: { id: rec.id, enterpriseId: rec.enterpriseId, titleCode: rec.titleCode, usccRaw: rec.usccRaw, source: rec.source }, enterprise: { nameNorm: ent.nameNorm, usccNorm: ent.usccNorm } })
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
  const q = schema.platformQuery, r = schema.platformRelation, a = schema.enterpriseAlias
  const subjectKeys = [...(identity ? [identity] : []), `name:${joined.enterprise.nameNorm}`]
  const aliasKeys = db.select({ key: sql<string>`'name:' || ${a.nameNorm}` }).from(a).where(and(eq(a.enterpriseId, owner), eq(a.verificationStatus, 'confirmed')))
  // Keys/owners use indexed searches. Normalized identity additionally scans the
  // USCC/query-ID covering index, matching the row predicate without loading bodies.
  const relatedIds = db.select({ id: q.id }).from(q).where(inArray(q.queryKey, subjectKeys))
    .union(db.select({ id: q.id }).from(q).where(inArray(q.queryKey, aliasKeys)))
    .union(db.select({ id: r.queryId }).from(r).where(eq(r.enterpriseId, owner)))
    // UNION's ordering can otherwise favor query_seq_uq and visit row bodies.
    .union(db.select({ id: sql<number>`${r.queryId}` }).from(sql`${r} indexed by platform_relation_uscc_query_idx`).where(identity ? sql`${normalizedUscc(r.usccRaw)} = ${identity}` : sql`0`))
  const queryTitle = sql<string | null>`coalesce(${q.titleCode}, case ${q.rdjb} when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end)`
  const queryScope = and(inArray(q.id, relatedIds), inArray(q.interface, ['apply_list', 'business_list']), or(eq(queryTitle, titleCode), and(includeUnknownBusinessTitle ? sql`1` : eq(q.interface, 'apply_list'), sql`${queryTitle} is null`)))!
  // Metadata is bounded to this owner's related title and two process interfaces.
  // Scalar extraction never hydrates raw_response or collection_evidence.rows/pages.
  const queriesQuery = db.select({ queryId: q.id, interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, titleCode: q.titleCode, queriedAt: q.queriedAt, status: q.status,
    completeness: sql<string | null>`case when json_valid(${q.collectionEvidence}) then json_extract(${q.collectionEvidence}, '$.completeness') end`,
    fullRangeValue: sql<number | null>`case when json_valid(${q.collectionEvidence}) then json_extract(${q.collectionEvidence}, '$.fullRange') end`,
  }).from(q).where(queryScope).orderBy(asc(q.id))
  const processRaw = sql`case when json_valid(${r.rawFields}) then json_extract(${r.rawFields}, ${sql.join(PLATFORM_PROCESS_RAW_KEYS.map(key => sql`${`$.${key}`}`), sql`, `)}) else null end`.mapWith(platformProcessRawFromJson)
  const matchingIdentity = and(or(eq(r.enterpriseId, owner), sql`${r.enterpriseId} is null`),
    or(identity ? sql`${normalizedUscc(r.usccRaw)} = ${identity}` : and(eq(r.enterpriseId, owner), eq(r.verificationStatus, 'confirmed')), and(sql`${normalizedUscc(r.usccRaw)} = ''`, or(eq(r.enterpriseId, owner), inArray(q.queryKey, subjectKeys), inArray(q.queryKey, aliasKeys)))))!
  const pagePosition = (field: 'page' | 'rdjb') => sql`(select json_extract(value, ${`$.${field}`}) from (
    select value, sum(json_extract(value, '$.fetchedCount')) over (order by cast(key as integer)) last_sequence
    from json_each(case when json_valid(${q.collectionEvidence}) then ${q.collectionEvidence} end, '$.pages')
    where json_extract(value, '$.status') = 'success') where last_sequence >= ${r.sequenceNo} limit 1)`
  const rowsQuery = db.select({ id: r.id, queryId: r.queryId, sequenceNo: r.sequenceNo, relationKey: r.relationKey, enterpriseId: r.enterpriseId, usccRaw: r.usccRaw, nameRaw: r.nameRaw,
    declareKind: r.declareKind, appliedAt: r.appliedAt, year: r.year, province: r.province, batch: r.batch, awardBatchLabel: r.awardBatchLabel, status: r.status,
    verificationStatus: r.verificationStatus, matchBasis: r.matchBasis, rawFields: processRaw,
    sourcePage: pagePosition('page').mapWith(Number), sourceRdjb: pagePosition('rdjb').mapWith(String),
    // Explicit known transcription provenance, no arbitrary source text hydration or blank-row deletion.
    identityOnlySource: sql<number>`case when ${r.sourceText} like '%platform-verify-aclass%' and ${r.sourceText} like '%转写%' and (${r.sourceText} like '%名称%' or ${r.sourceText} like '%qymc%') then 1 else 0 end`,
  }).from(q).innerJoin(r, eq(r.queryId, q.id)).where(and(queryScope, matchingIdentity)).orderBy(asc(q.id), asc(r.sequenceNo), asc(r.id))
  // Small owner metadata detects ambiguous same-key explicit titles across the
  // archive without reading out-of-title raw process bodies.
  const titlesQuery = db.select({ relationId: r.id, queryId: r.queryId, relationKey: r.relationKey, usccRaw: r.usccRaw, titleCode: queryTitle })
    .from(q).innerJoin(r, eq(r.queryId, q.id)).where(and(inArray(q.id, relatedIds), eq(q.interface, 'business_list'), matchingIdentity)).orderBy(asc(r.id))
  // ID-only private projections let admission prove existence without touching
  // raw7/page metadata or allocating annual DTOs. Default reads never execute it.
  const rowIdsQuery = db.select({ relationId: r.id }).from(q).innerJoin(r, eq(r.queryId, q.id)).where(and(queryScope, matchingIdentity))
  return { headerQuery, joined, event, owner, titleCode, businessYear, kind, queriesQuery, rowsQuery, titlesQuery, relatedIds, rowIdsQuery }
}
function prepareObservations(scope: Scope, rows: Rows, titleScopeRows: Titles, queries: Queries, metadata: ReturnType<typeof readPlatformBusinessMetadata>) {
  const { joined, event, owner, titleCode, businessYear, kind } = scope
  const eventId = event.id
  const coverage: AnnualProcessCoverage[] = queries.map(row => ({ queryId: row.queryId, interface: row.interface, queriedAt: row.queriedAt, status: row.status, completeness: row.completeness, fullRange: row.fullRangeValue == null ? null : row.fullRangeValue === 1 }))
  const queryMap = new Map(queries.map(row => [row.queryId, row]))
  const normalizedRows = rows.map(row => ({ row, query: queryMap.get(row.queryId)!, facts: normalizePlatformRelation(queryMap.get(row.queryId)!.interface, row) }))
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
    event: { ...joined.event, usccRaw: event.record.usccRaw }, evidence,
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
  const scope = sourceScope(db, eventId)
  if (!scope) return null
  const queries = scope.queriesQuery.all()
  const rows = scope.rowsQuery.all()
  const titles = scope.titlesQuery.all()
  const metadata = readPlatformBusinessMetadata(db, [...rows.map(row => row.id), ...titles.map(row => row.relationId)])
  const prepared = prepareObservations(scope, rows, titles, queries, metadata)
  const groups = readPlatformBusinessGroups(db, prepared.observations)
  return finishRead(prepared, groups, () => evidenceQuery(db, eventId).all()).read
}

/** Stricter admission for the explicit comparison only. W is a policy charge,
 * not an output, heap or RSS bound. All SQL scans remain data dependent. */
const comparisonCaps = { rows: 64, titles: 64, history: 128, decisions: 128, evidence: 160, raw: 4096, proof: 4096, proofElements: 100, scalar: 1048576, source: 65536, charge: 16777216 } as const
const unavailable = (): never => { throw new Error('platform_comparison_scope_unavailable') }
const resource = (): never => { throw new Error('input_resource_limit') }
const quoted = (name: string) => `"${name}"`
const leaf = (name: string) => `case typeof(${name}) when 'null' then 4 when 'text' then 2+6.0*length(cast(${name} as blob)) when 'integer' then 32 when 'real' then 32 else 1e100 end`
const objectBound = (fields: Record<string, string>) => `(${2 + Math.max(0, Object.keys(fields).length - 1)} + ${Object.entries(fields).map(([key, expression]) => `${3 + key.length}+(${expression})`).join('+') || '0'})`
const queryKeys = ['queryId','interface','queryKey','rdjb','titleCode','queriedAt','status','completeness','fullRangeValue']
const rowKeys = ['id','queryId','sequenceNo','relationKey','enterpriseId','usccRaw','nameRaw','declareKind','appliedAt','year','province','batch','awardBatchLabel','status','verificationStatus','matchBasis','rawFields','sourcePage','sourceRdjb','identityOnlySource']
const titleKeys = ['relationId','queryId','relationKey','usccRaw','titleCode']
const evidenceKeys = ['id','sourceFile','attachment','listNo','page','fileId','sha256','removedAt']
function named(query: ScalarQuery, keys: string[]): ScalarQuery {
  const statement = query.toSQL()
  return { toSQL: () => ({ sql: `with projection(${keys.map(quoted).join(',')}) as (${statement.sql}) select * from projection`, params: statement.params }) }
}
function combine(queries: ScalarQuery[]): ScalarQuery {
  const values = queries.map(query => query.toSQL())
  return { toSQL: () => ({ sql: values.map(q => `select * from (${q.sql})`).join(' union '), params: values.flatMap(q => q.params) }) }
}
function derived(query: ScalarQuery, select: string, params: unknown[] = []): ScalarQuery {
  const q = query.toSQL()
  return { toSQL: () => ({ sql: `with admitted as (${q.sql}) ${select}`, params: [...q.params, ...params] }) }
}
function literalQuery(statement: string, params: unknown[] = []): ScalarQuery { return { toSQL: () => ({ sql: statement, params }) } }
function comparisonZeroMask() {
  return `case
      when exists(select 1 from platform_relation r where r.query_id in (select id from potential)) then 8
      when exists(select 1 from potential q where case
        when q.status not in ('no_record','success') or q.collection_evidence is null or not json_valid(q.collection_evidence) then 1
        when json_type(q.collection_evidence) is not 'object' then 1
        else json_extract(q.collection_evidence,'$.source') is not case q.interface when 'apply_list' then 'queryList' else 'businessList' end
          or json_extract(q.collection_evidence,'$.status') is not q.status
          or json_extract(q.collection_evidence,'$.completeness') is not 'complete'
          or json_type(q.collection_evidence,'$.fullRange') is not 'true'
          or json_type(q.collection_evidence,'$.unfinished') is not 'array' or json_array_length(q.collection_evidence,'$.unfinished') is not 0
          or json_type(q.collection_evidence,'$.error') is not 'null'
          or (q.interface='apply_list' and (q.title_code is not null or q.rdjb is not ''
            or json_extract(q.collection_evidence,'$.titleScope.mode') is not 'source_default'))
          or (q.interface='business_list' and (q.rdjb not in ('1','2','3')
            or json_extract(q.collection_evidence,'$.titleScope.mode') is not 'selected'))
          or json_type(q.collection_evidence,'$.pages') is not 'array' or json_array_length(q.collection_evidence,'$.pages')=0
          or exists(select 1 from json_each(q.collection_evidence,'$.pages') p where case when p.type is not 'object' then 1 else
            json_extract(p.value,'$.status') is not 'success'
            or json_type(p.value,'$.page') is not 'integer' or json_extract(p.value,'$.page') is not cast(p.key as integer)+1
            or json_extract(p.value,'$.source') is not case q.interface when 'apply_list' then 'queryList' else 'businessList' end
            or (q.interface='apply_list' and json_type(p.value,'$.rdjb') is not 'null')
            or (q.interface='business_list' and json_extract(p.value,'$.rdjb') is not q.rdjb)
            or json_type(p.value,'$.fetchedCount') is not 'integer' or json_extract(p.value,'$.fetchedCount') is not 0
            or json_type(p.value,'$.declaredTotal') is null or json_type(p.value,'$.declaredTotal') not in ('null','integer') or json_extract(p.value,'$.declaredTotal')!=0 end)
        end) then 2 else 0 end`
}

type ClosureMetadata = ReturnType<typeof readPlatformBusinessMetadata> extends Map<number, infer M> ? M : never
type ClosureNode = ClosureMetadata & { queryId: number; relationKey: string | null; usccRaw: string | null; isAnnualRow: number }
type ClosureHistory = { recordId: number; relationId: number; queryId: number }
type ClosureQuery = { id: number; interface: string; title_code: string | null; rdjb: string; metadata: string | null }
type ClosureDecision = { relationId: number; eventId: number | null; predecessorEventId: number | null; enterpriseId: number | null; titleCode: string }
const closureTitles: Record<string, string> = { '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' }
const closurePageTitle = platformQueryResultShape.pages.element.pick({ rdjb: true })
/** Applicability only. Collection completion remains with the original validators/core. */
function closureQueryTitle(query: ClosureQuery): string | null {
  if (query.interface !== 'business_list') return null
  const levels = query.rdjb.split(',').filter(Boolean)
  const fallback = levels.length === 1 ? closureTitles[levels[0]!] : undefined
  const title = query.title_code ?? fallback
  if (!title || !Object.values(closureTitles).includes(title) || levels.some(level => closureTitles[level] !== title)) return null
  if (query.metadata !== null) {
    const metadata: unknown = JSON.parse(query.metadata)
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
    const fields = metadata as Record<string, unknown>
    const scope = platformQueryResultShape.titleScope.safeParse(fields.titleScope)
    if (!scope.success || scope.data.mode !== 'selected' || !scope.data.rdjb.length || scope.data.rdjb.some(level => closureTitles[level] !== title)) return null
    if (!Array.isArray(fields.pages)) return null
    for (const page of fields.pages) {
      const parsed = closurePageTitle.safeParse(page)
      if (!parsed.success || parsed.data.rdjb == null || closureTitles[parsed.data.rdjb] !== title) return null
    }
  }
  return title
}
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
  identityFunctions(db)
  const ids = [...new Set(request.eventIds)], selected = [...new Set(request.selectedQueryIds)]
  if (ids.length > 40 || selected.length > 50) resource()
  if ([...ids, ...selected].some(id => !Number.isSafeInteger(id) || id <= 0)) unavailable()
  const selectedJson = JSON.stringify(selected)
  const get = (query: ScalarQuery) => { const q = query.toSQL(); return sqlite.prepare(q.sql).get(...q.params) as Record<string, number> }
  const all = <T>(query: ScalarQuery): T[] => { const q = query.toSQL(); return sqlite.prepare(q.sql).all(...q.params) as T[] }
  const measure = (query: ScalarQuery, keys: string[], cap: number) => {
    const bound = objectBound(Object.fromEntries(keys.map(key => [key, leaf(quoted(key))])))
    const result = get(derived(query, `select count(*) n, coalesce(sum(1.0*${bound}),0) bytes from admitted`))
    if (![result.n, result.bytes].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) unavailable()
    if (result.n! > cap || result.bytes! > comparisonCaps.scalar) resource()
    return { n: result.n!, bytes: result.bytes! }
  }
  let headerBytes = 0
  const scopes = ids.map(id => {
    const scope = sourceScope(db, id, (q, keys) => { const m = measure(named(q, keys), keys, 1); if (m.n !== 1) unavailable(); headerBytes += m.bytes }, true)
    if (!scope || scope.owner !== request.enterpriseId || scope.titleCode !== request.titleCode) unavailable()
    return scope!
  })
  const absent = () => ({ kind: 'absent' as const, entries: [], history: new Map<number, number[]>(),
    admission: { kind: 'header_only' as const, uniqueScalarBytes: headerBytes + 32, expandedCharge: null,
      sourceUpperBytes: [] as number[], actualSourceBytes: [] as number[] } })
  if (!scopes.length) {
    // No formal event can carry a process. Still prove the owner's protective
    // graph empty; otherwise this ID-only request cannot assemble its source.
    const emptyScope = get(literalQuery(`with owner as (select id,uscc_norm,name_norm from enterprise where id=?),
      related as (select q.id from platform_query q where q.query_key in
        (select uscc_norm from owner union select 'name:'||name_norm from owner
          union select 'name:'||name_norm from enterprise_alias where enterprise_id=? and verification_status='confirmed')
        union select r.query_id from platform_relation r where r.enterprise_id=? or exists
          (select 1 from owner e where e.uscc_norm is not null and e.uscc_norm!='' and roster84_uscc(r.uscc_raw)=e.uscc_norm))
      select case when not exists(select 1 from owner)
        or exists(select 1 from platform_query q where q.id in (select id from related) and q.interface in ('apply_list','business_list'))
        or exists(select 1 from record_correspondence c where c.enterprise_id=? and c.title_code=?)
        then 8 else 0 end mask`, [request.enterpriseId,request.enterpriseId,request.enterpriseId,request.enterpriseId,request.titleCode]))
    if (emptyScope.mask !== 0) unavailable()
    return absent()
  }
  const uniqueScopes = [...new Map(scopes.map(scope => [JSON.stringify([scope.owner, scope.titleCode, scope.event.record.usccRaw, scope.joined.enterprise.nameNorm]), scope])).values()]
  const related = combine(uniqueScopes.map(s => s.relatedIds)).toSQL()
  const actualRows = combine(uniqueScopes.map(s => named(s.rowIdsQuery, ['relationId']))).toSQL()
  const actualTitles = combine(uniqueScopes.map(s => named(s.titlesQuery, titleKeys))).toSQL()
  // One scalar replaces the old late absence SELECT. No recognized query state
  // is annual existence evidence. All IDs/text are bound, never interpolated.
  const probe = get(literalQuery(`with related as (${related.sql}), annual_rows as (${actualRows.sql}),
    titles as (${actualTitles.sql}), selected as (select value id from json_each(?)),
    events as (select value id from json_each(?)),
    potential as (select q.id,q.interface,q.status,q.collection_evidence,q.title_code,q.rdjb from platform_query q where q.id in (select id from related) and q.interface in ('apply_list','business_list')),
    relations as (select relationId from annual_rows union select relationId from titles),
    history as (select o.relation_id relationId from platform_business_observation o where o.record_id in
      (select x.record_id from platform_business_observation x join relations r on r.relationId=x.relation_id where x.record_id is not null)),
    protected as (select relationId from relations union select relationId from history)
    select case
      when exists(select 1 from platform_business_observation o join platform_relation r on r.id=o.relation_id
          join platform_query q on q.id=r.query_id left join platform_business_record b on b.id=o.record_id
          where q.id in (select id from related) and q.interface='recognized_list' and o.record_id is not null and b.interface is not q.interface)
        or exists(select 1 from record_correspondence c where
          (c.event_id in (select id from events) or c.predecessor_event_id in (select id from events) or (c.enterprise_id=? and c.title_code=?))
          and (c.relation_id is null or c.relation_id not in (select relationId from protected))) then 8
      when exists(select 1 from potential q where q.id not in (select id from selected))
        or exists(select 1 from titles t where t.queryId not in (select id from selected))
        or exists(select 1 from history h join platform_relation r on r.id=h.relationId where r.query_id not in (select id from selected)) then 4
      when exists(select 1 from relations) then 1
      else ${comparisonZeroMask()} end mask`, [...related.params, ...actualRows.params, ...actualTitles.params, selectedJson, JSON.stringify(ids), request.enterpriseId, request.titleCode]))
  if (probe.mask === 8 || probe.mask === 2) unavailable()
  if (headerBytes + 32 > comparisonCaps.scalar) resource()
  if (probe.mask === 0) return absent()
  const deferred = probe.mask === 4
  if (probe.mask !== 1 && !deferred) unavailable()
  // Only actual annual dependencies pay yearly metadata admission. Query-only
  // witnesses remain complete and are checked exactly once by the pure core.
  const qUnion = combine(uniqueScopes.map(s => named(s.queriesQuery, queryKeys)))
  const qSql = qUnion.toSQL()
  let dependencies = literalQuery(`with annual_queries as (${qSql.sql}), annual_rows as (${actualRows.sql}), titles as (${actualTitles.sql}),
    relations as (select relationId from annual_rows union select relationId from titles)
    select queryId id from annual_queries union select queryId id from titles
    union select r.query_id id from platform_business_observation o join platform_relation r on r.id=o.relation_id
      where o.record_id in (select x.record_id from platform_business_observation x join relations a on a.relationId=x.relation_id where x.record_id is not null)`,
    [...qSql.params,...actualRows.params,...actualTitles.params]).toSQL()
  const completeProtected = literalQuery(`with annual_rows as (${actualRows.sql}), titles as (${actualTitles.sql}),
    relations as (select relationId from annual_rows union select relationId from titles)
    select relationId from relations union select o.relation_id from platform_business_observation o
      where o.record_id in (select x.record_id from platform_business_observation x join relations a on a.relationId=x.relation_id where x.record_id is not null)`,
    [...actualRows.params, ...actualTitles.params]).toSQL()
  let dependencyIds: { id: number; isPotential: number }[] = [], idCharge = 0
  if (deferred) {
    dependencyIds = all(literalQuery(`with dependencies as (${dependencies.sql}), related as (${related.sql}), candidate(id,isPotential) as (
      select id,0 from dependencies union all select q.id,1 from platform_query q where q.id in (select id from related) and q.interface in ('apply_list','business_list'))
      select id,max(isPotential) isPotential from candidate group by id order by id limit 51`, [...dependencies.params, ...related.params]))
    if (dependencyIds.some(row => !Number.isSafeInteger(row.id) || row.id <= 0)) unavailable()
    if (dependencyIds.length > 50) resource()
    // Same A/W budget: ID+flag objects and bound safe-integer JSON, never a free cache.
    idCharge = 87*dependencyIds.length+1 + Math.max(2,17*dependencyIds.length+1)
    dependencies = literalQuery('select value id from json_each(?)', [JSON.stringify(dependencyIds.map(row => row.id))]).toSQL()
  }
  const queryMetadata = literalQuery(`select id, interface, query_key, rdjb, title_code, queried_at, status,
    case when collection_evidence is null then null when json_valid(collection_evidence) then json_object(
      'source',json_extract(collection_evidence,'$.source'),'status',json_extract(collection_evidence,'$.status'),
      'effectiveConditions',json_extract(collection_evidence,'$.effectiveConditions'),'titleScope',json_extract(collection_evidence,'$.titleScope'),
      'pages',json_extract(collection_evidence,'$.pages'),'completeness',json_extract(collection_evidence,'$.completeness'),
      'fullRange',json_extract(collection_evidence,'$.fullRange'),'unfinished',json_extract(collection_evidence,'$.unfinished'),
      'error',json_extract(collection_evidence,'$.error'),'limits',json_extract(collection_evidence,'$.limits')) else null end metadata,
    case when collection_evidence is null then 0 when json_valid(collection_evidence) then coalesce(json_array_length(collection_evidence,'$.pages'),0) else -1 end pages
    from platform_query where id in (${dependencies.sql})`, dependencies.params)
  const qm = measure(queryMetadata, ['id','interface','query_key','rdjb','title_code','queried_at','status','metadata','pages'], 50)
  const queryUpper = get(derived(queryMetadata, `select coalesce(sum(u),0) total, coalesce(max(u),0) largest, coalesce(max(pages),0) pages, coalesce(min(pages),0) minimum from
    (select 4096+4*${objectBound(Object.fromEntries(['id','interface','query_key','rdjb','title_code','queried_at','status'].map(k => [k,leaf(k)])))}+4*(32+6.0*coalesce(length(cast(metadata as blob)),4))+32*pages u,pages from admitted)`))
  if (queryUpper.minimum! < 0) unavailable()
  if (queryUpper.largest! > 65536 || queryUpper.pages! > 50) resource()
  // C3: all archived rows, not the annual owner-filtered subset. A partial archive
  // is business insufficiency; a declared successful-page/row mismatch is not.
  const malformed = get(literalQuery(`select count(*) n from platform_query q where q.id in (${dependencies.sql})
    and q.interface in ('apply_list','business_list') and q.collection_evidence is not null and
    (not json_valid(q.collection_evidence) or case when json_valid(q.collection_evidence) then
      json_type(q.collection_evidence,'$.pages') is not 'array' or exists (
        select 1 from json_each(q.collection_evidence,'$.pages') p where case when p.type is not 'object' then 1 else json_extract(p.value,'$.status')='success'
        and (json_type(p.value,'$.fetchedCount') is not 'integer' or json_extract(p.value,'$.fetchedCount')<0) end)
      else 1 end)`, dependencies.params))
  if (malformed.n) unavailable()
  const closure = get(literalQuery(`select count(*) n from platform_query q where q.id in (${dependencies.sql}) and q.interface in ('apply_list','business_list')
    and q.collection_evidence is not null and (
      (select count(*) from platform_relation r where r.query_id=q.id) !=
      (select coalesce(sum(json_extract(p.value,'$.fetchedCount')),0) from json_each(q.collection_evidence,'$.pages') p where json_extract(p.value,'$.status')='success')
      or exists(select 1 from platform_relation r where r.query_id=q.id and (typeof(r.sequence_no)!='integer' or r.sequence_no<1))
      or (select coalesce(max(r.sequence_no),0) from platform_relation r where r.query_id=q.id)!=(select count(*) from platform_relation r where r.query_id=q.id))
      ${deferred ? `or (q.id in (${dependencies.sql}) and q.id not in (select value from json_each(?)) and exists(select 1 from platform_relation r where r.query_id=q.id and r.id not in (${completeProtected.sql})))` : ''}`,
      deferred ? [...dependencies.params, ...dependencies.params, selectedJson, ...completeProtected.params] : dependencies.params))
  if (closure.n) unavailable()
  const pageShape = get(literalQuery(`select count(*) n from platform_query q where q.id in (${dependencies.sql}) and q.interface in ('apply_list','business_list') and q.collection_evidence is not null and exists (
    select 1 from (
      select p.value, json_extract(p.value,'$.page') page, json_extract(p.value,'$.rdjb') rdjb,
        lag(json_extract(p.value,'$.page')) over (partition by json_extract(p.value,'$.rdjb') order by cast(p.key as integer)) previous
      from json_each(q.collection_evidence,'$.pages') p
    ) p where
      (json_extract(q.collection_evidence,'$.fullRange')=1 or json_type(p.value,'$.page') is not null or json_type(p.value,'$.source') is not null) and (
        json_type(p.value,'$.page') is not 'integer' or p.page<1
        or json_type(p.value,'$.status') is not 'text' or json_extract(p.value,'$.status') not in ('success','auth_failed','failed')
        or json_type(p.value,'$.fetchedCount') is not 'integer' or json_extract(p.value,'$.fetchedCount')<0
        or (json_extract(p.value,'$.status')!='success' and json_extract(p.value,'$.fetchedCount')!=0)
        or json_extract(p.value,'$.source') is not case q.interface when 'business_list' then 'businessList' else 'queryList' end
        or (q.interface='apply_list' and json_type(p.value,'$.rdjb') is not 'null')
        or (q.interface='business_list' and (json_type(p.value,'$.rdjb') is not 'text' or not exists(select 1 from json_each(q.collection_evidence,'$.titleScope.rdjb') scope where scope.value=p.rdjb)))
        or (p.previous is not null and p.page!=p.previous+1)
        or (p.previous is null and json_extract(q.collection_evidence,'$.fullRange')=1 and p.page!=1)
        or (json_type(p.value,'$.declaredTotal') not in ('integer','null') or json_extract(p.value,'$.declaredTotal')<0)
      ))`, dependencies.params))
  if (pageShape.n) unavailable()
  const rUnion = combine(uniqueScopes.map(s => named(s.rowsQuery, rowKeys)))
  const tUnion = combine(uniqueScopes.map(s => named(s.titlesQuery, titleKeys)))
  const fUnion = combine(scopes.map(s => named(evidenceQuery(db, s.event.id), evidenceKeys)))
  for (const query of deferred ? [qUnion] : [qUnion, tUnion]) {
    const missing = get(derived(query, `select count(*) n from admitted where queryId not in (select value from json_each(?))`, [selectedJson]))
    if (missing.n) unavailable()
  }
  const qCost = measure(qUnion, queryKeys, 50), rCost = measure(rUnion, rowKeys, comparisonCaps.rows), tCost = measure(tUnion, titleKeys, comparisonCaps.titles)
  let fCost = deferred ? null : measure(fUnion, evidenceKeys, comparisonCaps.evidence)
  const rawCost = get(derived(rUnion, `select coalesce(max(length(cast(rawFields as blob))),0) n from admitted`))
  if (rawCost.n! > comparisonCaps.raw) resource()
  const rt = combine([derived(rUnion, 'select id relationId from admitted'), derived(tUnion, 'select relationId from admitted')])
  const mQuery = derived(rt, `select r.id relationId,o.record_id recordId,o.version_id versionId,b.interface,b.platform_key platformKey,o.identity_state identityState,o.content_state contentState,o.key_source keySource,o.projection_rule_version projectionRuleVersion,v.hash_algorithm hashAlgorithm,v.content_hash contentHash${deferred ? `,r.query_id queryId,r.relation_key relationKey,r.uscc_raw usccRaw,case when r.id in (${actualRows.sql}) then 1 else 0 end isAnnualRow` : ''}
    from admitted x join platform_relation r on r.id=x.relationId left join platform_business_observation o on o.relation_id=r.id left join platform_business_record b on b.id=o.record_id left join platform_business_record_version v on v.id=o.version_id`, deferred ? actualRows.params : [])
  const mKeys = ['relationId','recordId','versionId','interface','platformKey','identityState','contentState','keySource','projectionRuleVersion','hashAlgorithm','contentHash', ...(deferred ? ['queryId','relationKey','usccRaw','isAnnualRow'] : [])]
  const mCost = measure(mQuery, mKeys, 128)
  const hQuery = derived(rt, `select o.record_id recordId,o.relation_id relationId,r.query_id queryId,o.version_id versionId,b.interface,v.record_id versionRecordId
    from platform_business_observation o left join platform_relation r on r.id=o.relation_id left join platform_business_record b on b.id=o.record_id left join platform_business_record_version v on v.id=o.version_id
    where o.record_id in (select x.record_id from platform_business_observation x join admitted a on a.relationId=x.relation_id where x.record_id is not null)`)
  const hKeys = ['recordId','relationId','queryId','versionId','interface','versionRecordId'], hCost = measure(hQuery, hKeys, comparisonCaps.history)
  const badHistory = get(derived(hQuery, `select count(*) n from admitted h left join platform_query q on q.id=h.queryId where q.id is null ${deferred ? '' : 'or q.id not in (select value from json_each(?))'} or q.interface is not h.interface or (h.versionId is not null and h.versionRecordId is not h.recordId)`, deferred ? [] : [selectedJson]))
  if (badHistory.n) unavailable()
  const badMapping = get(derived(rt, `select count(*) n from admitted a join platform_relation r on r.id=a.relationId join platform_query q on q.id=r.query_id join platform_business_observation o on o.relation_id=r.id
    left join platform_business_record b on b.id=o.record_id left join platform_business_record_version v on v.id=o.version_id
    where (o.record_id is not null and (b.id is null or b.interface is not q.interface)) or (o.version_id is not null and (v.id is null or v.record_id is not o.record_id))`))
  if (badMapping.n) unavailable()
  // Deferred coverage and decisions share the same complete ID-only protection set.
  // History metadata is still validated/hydrated once through hQuery above.
  const protectedIds = deferred ? literalQuery(completeProtected.sql, completeProtected.params) : combine([rt, derived(hQuery, 'select relationId from admitted')])
  const dQuery = derived(protectedIds, `select c.id,c.relation_id relationId,c.export_row_id exportRowId,c.event_id eventId,c.predecessor_event_id predecessorEventId,c.enterprise_id enterpriseId,c.title_code titleCode,c.type,c.role,c.status,c.revision,c.rule_id ruleId,c.rule_version ruleVersion,c.created_at createdAt,c.decided_at decidedAt,c.ended_at endedAt,
    q.title_code queryTitle,q.rdjb queryRdjb,q.interface queryInterface,q.status queryStatus,r.uscc_raw relationUscc,r.enterprise_id relationEnterpriseId,r.verification_status relationStatus,owner.id ownerId,owner.uscc_norm ownerUscc,target.id targetId,target.uscc_norm targetUscc,t.code targetTitle,
    case when json_valid(c.provenance) then json_extract(c.provenance,'$.comparisonProofIds') end proofIds,
    case when json_valid(c.provenance) then coalesce(json_array_length(c.provenance,'$.comparisonProofIds'),0) else -1 end proofCount
    from record_correspondence c join admitted a on a.relationId=c.relation_id left join platform_relation r on r.id=c.relation_id left join platform_query q on q.id=r.query_id
    left join enterprise owner on owner.id=r.enterprise_id left join enterprise target on target.id=c.enterprise_id left join title t on t.code=c.title_code`)
  const dKeys = ['id','relationId','exportRowId','eventId','predecessorEventId','enterpriseId','titleCode','type','role','status','revision','ruleId','ruleVersion','createdAt','decidedAt','endedAt','queryTitle','queryRdjb','queryInterface','queryStatus','relationUscc','relationEnterpriseId','relationStatus','ownerId','ownerUscc','targetId','targetUscc','targetTitle','proofIds','proofCount']
  const proofShape = get(derived(protectedIds, `select count(*) n from record_correspondence c join admitted a on a.relationId=c.relation_id where
    case when not json_valid(c.provenance) then 1
      when json_type(c.provenance,'$.comparisonProofIds') is null or json_type(c.provenance,'$.comparisonProofIds')='null' then 0
      when json_type(c.provenance,'$.comparisonProofIds')!='array' then 1
      else exists(select 1 from json_each(c.provenance,'$.comparisonProofIds') p where p.type!='integer' or p.value<1 or p.value>9007199254740991) end`))
  if (proofShape.n) unavailable()
  const dCost = measure(dQuery, dKeys, comparisonCaps.decisions)
  const proof = get(derived(dQuery, `select coalesce(max(length(cast(proofIds as blob))),0) bytes,coalesce(max(proofCount),0) count,coalesce(min(proofCount),0) minimum from admitted`))
  if (proof.minimum! < 0) unavailable()
  if (proof.bytes! > comparisonCaps.proof || proof.count! > comparisonCaps.proofElements) resource()
  let admittedTitles: Map<Scope, Titles> | undefined
  let admittedMetadata: ReturnType<typeof readPlatformBusinessMetadata> | undefined
  let admittedHistory: ClosureHistory[] | undefined
  const prefixBytes = 32 + headerBytes + qm.bytes + qCost.bytes + rCost.bytes + tCost.bytes + mCost.bytes + hCost.bytes + dCost.bytes + idCharge
  if (deferred) {
    if (prefixBytes > comparisonCaps.scalar) resource()
    const sharedTitles = new Map<number, Titles[number]>()
    admittedTitles = new Map(uniqueScopes.map(scope => [scope, scope.titlesQuery.all().map(row => {
      const existing = sharedTitles.get(row.relationId)
      if (existing) return existing
      sharedTitles.set(row.relationId, row); return row
    })]))
    const nodes = mCost.n ? all<ClosureNode>(mQuery) : []
    admittedHistory = all<ClosureHistory>(hQuery)
    const classification = classifyComparisonClosure(nodes, admittedHistory, all<ClosureQuery>(queryMetadata), all<ClosureDecision>(dQuery), request)
    const closed = (id: number) => selected.includes(id) || classification.metadataOnly.has(id)
    if (dependencyIds.some(row => row.isPotential && !closed(row.id)) || admittedHistory.some(row => !closed(row.queryId))) unavailable()
    const metadataOnlyJson = JSON.stringify([...classification.metadataOnly])
    const missingTitles = get(derived(tUnion, `select count(*) n from admitted where queryId not in (select value from json_each(?)) and queryId not in (select value from json_each(?))`, [selectedJson, metadataOnlyJson]))
    if (missingTitles.n) unavailable()
    if (!classification.hasCurrentRoot) {
      // Original full zero proof, applied after removing only proved-independent queries.
      const zero = get(literalQuery(`with potential as (select q.* from platform_query q where q.id in (select value from json_each(?)))
        select ${comparisonZeroMask()} mask`, [JSON.stringify(dependencyIds.filter(row => row.isPotential && !classification.metadataOnly.has(row.id)).map(row => row.id))]))
      if (zero.mask !== 0) unavailable()
      if (prefixBytes + 32 > comparisonCaps.scalar) resource()
      return { kind: 'absent' as const, entries: [], history: new Map<number, number[]>(),
        admission: { kind: 'scope_closure' as const, uniqueScalarBytes: prefixBytes+32, expandedCharge: null, sourceUpperBytes: [] as number[], actualSourceBytes: [] as number[] } }
    }
    // Explicit projection preserves legacy field order and excludes classification columns.
    admittedMetadata = new Map(nodes.map(row => [row.relationId, {
      relationId: row.relationId, recordId: row.recordId, versionId: row.versionId, interface: row.interface, platformKey: row.platformKey,
      identityState: row.identityState, contentState: row.contentState, keySource: row.keySource, projectionRuleVersion: row.projectionRuleVersion,
      hashAlgorithm: row.hashAlgorithm, contentHash: row.contentHash,
    }]))
    fCost = measure(fUnion, evidenceKeys, comparisonCaps.evidence)
  }
  // fCost is deferred only until the current-present/absent decision, never omitted on present.
  if (!fCost) unavailable()
  const uniqueBytes = prefixBytes + 32*fCost!.n + fCost!.bytes
  if (uniqueBytes > comparisonCaps.scalar) resource()
  const arrayBound = (query: ScalarQuery, item: string) => get(derived(query, `select 2+coalesce(sum(1.0*(${item})),0)+max(0,count(*)-1) bytes from admitted`)).bytes!
  const sourceUpperBytes = scopes.map(scope => {
    const q = named(scope.queriesQuery, queryKeys), r = named(scope.rowsQuery, rowKeys), t = named(scope.titlesQuery, titleKeys)
    const headerKeys = ['id','recordId','eventType','year','batchSeq','sortKey','reviewOutcome','decidedYear','revision','record_id','enterpriseId','titleCode','usccRaw','source','nameNorm','usccNorm']
    const header = named(scope.headerQuery, headerKeys)
    const eventKeys = headerKeys.slice(0,9)
    const eventBound = get(derived(header, `select ${objectBound({ ...Object.fromEntries(eventKeys.map(k => [k,leaf(quoted(k))])), usccRaw: leaf('coalesce(usccRaw,usccNorm)') })} bytes from admitted`)).bytes!
    const scopeBound = get(derived(header, `select ${objectBound({ enterpriseId:leaf('enterpriseId'),titleCode:leaf('titleCode'),businessYear:leaf("case when eventType='review' then decidedYear else year end"),declareKind:'8',ruleVersion:String(JSON.stringify(ANNUAL_PROCESS_RULE_VERSION).length) })} bytes from admitted`)).bytes!
    const evidenceBound = arrayBound(named(evidenceQuery(db,scope.event.id),evidenceKeys),objectBound(Object.fromEntries(evidenceKeys.map(k=>[k,leaf(quoted(k))]))))
    const titleBound = arrayBound(derived(t, `select a.*,o.record_id recordId,o.version_id versionId,b.platform_key platformKey,coalesce(roster84_uscc(a.usccRaw),'') usccNorm from admitted a left join platform_business_observation o on o.relation_id=a.relationId left join platform_business_record b on b.id=o.record_id`),objectBound({queryId:leaf('queryId'),relationId:leaf('relationId'),titleCode:leaf('titleCode'),platformKey:`${leaf('relationKey')}+${leaf('platformKey')}`,usccNorm:leaf('usccNorm'),recordId:leaf('recordId'),versionId:leaf('versionId')}))
    const observationBound = arrayBound(derived(r, `select a.id relationId,a.queryId,q.interface,o.record_id recordId,o.version_id versionId from admitted a join platform_query q on q.id=a.queryId left join platform_business_observation o on o.relation_id=a.id`),objectBound({queryId:leaf('queryId'),relationId:leaf('relationId'),interface:leaf('interface'),recordId:leaf('recordId'),versionId:leaf('versionId'),sourceFingerprint:'66'}))
    const coverageBound = arrayBound(q,objectBound({queryId:leaf('queryId'),interface:leaf('interface'),queriedAt:leaf('queriedAt'),status:leaf('status'),completeness:leaf('completeness'),fullRange:'5'}))
    const total = Number(get(literalQuery(`select ${objectBound({scope:String(scopeBound),event:String(eventBound),evidence:String(evidenceBound),titleScopeRefs:String(titleBound),observations:String(observationBound),coverage:String(coverageBound)})} bytes`)).bytes)
    if (!Number.isFinite(total)) unavailable()
    if (total > comparisonCaps.source) resource()
    return total
  })
  const p = 8192+32+32*fCost!.n+headerBytes+qm.bytes+qCost.bytes+rCost.bytes+tCost.bytes+2*mCost.bytes+hCost.bytes+fCost!.bytes+dCost.bytes+idCharge
  const expandedCharge = queryUpper.total!+sourceUpperBytes.reduce((a,b)=>a+b,0)+(1+16*ids.length)*(p+rCost.n*(qm.bytes+qCost.bytes+headerBytes))+ids.length*rCost.n*(4096+64*(rCost.n+tCost.n+dCost.n+hCost.n))
  if (!Number.isFinite(expandedCharge)) unavailable()
  if (expandedCharge > comparisonCaps.charge) resource()
  // Hydration starts only after closure and all admission charges. One raw scope
  // cache per request; Groups (and its authoritative second metadata pass) once.
  const cache = new Map<string, {queries: Queries; rows: Rows; titles: Titles}>()
  const key = (s: Scope) => JSON.stringify([s.owner,s.titleCode,s.event.record.usccRaw,s.joined.enterprise.nameNorm])
  for (const s of uniqueScopes) cache.set(key(s),{queries:s.queriesQuery.all(),rows:s.rowsQuery.all(),titles:admittedTitles?.get(s) ?? s.titlesQuery.all()})
  const relationIds = [...new Set([...cache.values()].flatMap(v=>[...v.rows.map(r=>r.id),...v.titles.map(t=>t.relationId)]))]
  const metadata = admittedMetadata ?? readPlatformBusinessMetadata(db,relationIds)
  const history = new Map<number,number[]>()
  for (const row of admittedHistory ?? all<{recordId:number;relationId:number}>(hQuery)) {
    const list = history.get(row.recordId) ?? []; list.push(row.relationId); history.set(row.recordId,list)
  }
  const prepared = scopes.map(scope=>{const v=cache.get(key(scope))!;return prepareObservations(scope,v.rows,v.titles,v.queries,metadata)})
  const groups = readPlatformBusinessGroups(db,prepared.flatMap(p=>p.observations))
  const e = schema.recordEvidence, file = schema.storedFile
  const evidenceRows = db.select({ ...evidenceFields(), eventId: e.recordEventId }).from(e).leftJoin(file,eq(file.relPath,e.sourceFile)).where(inArray(e.recordEventId,ids)).orderBy(asc(e.id)).all()
  const evidenceByEvent = Map.groupBy(evidenceRows,row=>row.eventId)
  const entries = prepared.map(p=>finishRead(p,groups.filter(g=>g.observationRefs[0]?.target.eventId===p.event.id),()=> (evidenceByEvent.get(p.event.id) ?? []).map(({eventId: _eventId,...row})=>row)))
  const actualSourceBytes = entries.map(e=>Buffer.byteLength(JSON.stringify(e.read.sourceRefs),'utf8'))
  if (actualSourceBytes.some((n,i)=>n>sourceUpperBytes[i]!)) unavailable()
  return {kind:'present' as const,entries,history,admission:{kind:'annual' as const,uniqueScalarBytes:uniqueBytes,expandedCharge,sourceUpperBytes,actualSourceBytes}}
}
