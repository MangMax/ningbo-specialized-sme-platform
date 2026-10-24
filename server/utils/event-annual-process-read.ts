import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { normalizePlatformRelation, PLATFORM_PROCESS_RAW_KEYS, platformProcessRawFromJson } from '../../lib/platform/normalization'
import type { ScopedPlatformObservation } from '../../lib/platform/business-record'
import { ANNUAL_PROCESS_RULE_VERSION, buildAnnualProcess, type AnnualProcessCoverage, type AnnualProcessScopeGap, type AnnualProcessSourceRefs, type EventAnnualProcessRead } from '../../lib/roster/annual-process'
import { readPlatformBusinessGroups, readPlatformBusinessMetadata } from './platform-business-record-read'
import { normalizedUscc } from './event-archive-discovery'

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
function readSnapshot(db: Db, eventId: number): EventAnnualProcessRead | null {
  const v = schema.recordEvent, rec = schema.record, ent = schema.enterprise
  const joined = db.select({ event: v, record: { id: rec.id, enterpriseId: rec.enterpriseId, titleCode: rec.titleCode, usccRaw: rec.usccRaw, source: rec.source }, enterprise: { nameNorm: ent.nameNorm, usccNorm: ent.usccNorm } })
    .from(v).innerJoin(rec, eq(v.recordId, rec.id)).innerJoin(ent, eq(rec.enterpriseId, ent.id)).where(eq(v.id, eventId)).get()
  if (!joined || joined.record.source !== 'jxj' || !['award', 'review'].includes(joined.event.eventType)) return null
  const event = { id: joined.event.id, eventType: joined.event.eventType, year: joined.event.year, decidedYear: joined.event.decidedYear, reviewOutcome: joined.event.reviewOutcome,
    record: { enterpriseId: joined.record.enterpriseId, titleCode: joined.record.titleCode, usccRaw: joined.record.usccRaw ?? joined.enterprise.usccNorm } }
  const owner = event.record.enterpriseId, titleCode = event.record.titleCode
  const identity = normalizeUscc(event.record.usccRaw)
  const businessYear = event.eventType === 'review' ? event.decidedYear : event.year
  const kind = event.eventType === 'review' ? 'review' : 'apply'
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
  const queryScope = and(inArray(q.id, relatedIds), inArray(q.interface, ['apply_list', 'business_list']), or(eq(queryTitle, titleCode), and(eq(q.interface, 'apply_list'), sql`${queryTitle} is null`)))!
  // Metadata is bounded to this owner's related title and two process interfaces.
  // Scalar extraction never hydrates raw_response or collection_evidence.rows/pages.
  const queries = db.select({ queryId: q.id, interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, titleCode: q.titleCode, queriedAt: q.queriedAt, status: q.status,
    completeness: sql<string | null>`case when json_valid(${q.collectionEvidence}) then json_extract(${q.collectionEvidence}, '$.completeness') end`,
    fullRangeValue: sql<number | null>`case when json_valid(${q.collectionEvidence}) then json_extract(${q.collectionEvidence}, '$.fullRange') end`,
  }).from(q).where(queryScope).orderBy(asc(q.id)).all()
  const coverage: AnnualProcessCoverage[] = queries.map(row => ({ queryId: row.queryId, interface: row.interface, queriedAt: row.queriedAt, status: row.status, completeness: row.completeness, fullRange: row.fullRangeValue == null ? null : row.fullRangeValue === 1 }))
  const queryMap = new Map(queries.map(row => [row.queryId, row]))
  const processRaw = sql`case when json_valid(${r.rawFields}) then json_extract(${r.rawFields}, ${sql.join(PLATFORM_PROCESS_RAW_KEYS.map(key => sql`${`$.${key}`}`), sql`, `)}) else null end`.mapWith(platformProcessRawFromJson)
  const matchingIdentity = and(or(eq(r.enterpriseId, owner), sql`${r.enterpriseId} is null`),
    or(identity ? sql`${normalizedUscc(r.usccRaw)} = ${identity}` : and(eq(r.enterpriseId, owner), eq(r.verificationStatus, 'confirmed')), and(sql`${normalizedUscc(r.usccRaw)} = ''`, or(eq(r.enterpriseId, owner), inArray(q.queryKey, subjectKeys), inArray(q.queryKey, aliasKeys)))))!
  const pagePosition = (field: 'page' | 'rdjb') => sql`(select json_extract(value, ${`$.${field}`}) from (
    select value, sum(json_extract(value, '$.fetchedCount')) over (order by cast(key as integer)) last_sequence
    from json_each(case when json_valid(${q.collectionEvidence}) then ${q.collectionEvidence} end, '$.pages')
    where json_extract(value, '$.status') = 'success') where last_sequence >= ${r.sequenceNo} limit 1)`
  const rows = db.select({ id: r.id, queryId: r.queryId, sequenceNo: r.sequenceNo, relationKey: r.relationKey, enterpriseId: r.enterpriseId, usccRaw: r.usccRaw, nameRaw: r.nameRaw,
    declareKind: r.declareKind, appliedAt: r.appliedAt, year: r.year, province: r.province, batch: r.batch, awardBatchLabel: r.awardBatchLabel, status: r.status,
    verificationStatus: r.verificationStatus, matchBasis: r.matchBasis, rawFields: processRaw,
    sourcePage: pagePosition('page').mapWith(Number), sourceRdjb: pagePosition('rdjb').mapWith(String),
    // Explicit known transcription provenance, no arbitrary source text hydration or blank-row deletion.
    identityOnlySource: sql<number>`case when ${r.sourceText} like '%platform-verify-aclass%' and ${r.sourceText} like '%转写%' and (${r.sourceText} like '%名称%' or ${r.sourceText} like '%qymc%') then 1 else 0 end`,
  }).from(q).innerJoin(r, eq(r.queryId, q.id)).where(and(queryScope, matchingIdentity)).orderBy(asc(q.id), asc(r.sequenceNo), asc(r.id)).all()
  // Small owner metadata detects ambiguous same-key explicit titles across the
  // archive without reading out-of-title raw process bodies.
  const titleScopeRows = db.select({ relationId: r.id, queryId: r.queryId, relationKey: r.relationKey, usccRaw: r.usccRaw, titleCode: queryTitle })
    .from(q).innerJoin(r, eq(r.queryId, q.id)).where(and(inArray(q.id, relatedIds), eq(q.interface, 'business_list'), matchingIdentity)).orderBy(asc(r.id)).all()
  const normalizedRows = rows.map(row => ({ row, query: queryMap.get(row.queryId)!, facts: normalizePlatformRelation(queryMap.get(row.queryId)!.interface, row) }))
  const metadata = readPlatformBusinessMetadata(db, [...rows.map(row => row.id), ...titleScopeRows.map(row => row.relationId)])
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
  const groups = readPlatformBusinessGroups(db, observations)
  const process = buildAnnualProcess({ event, groups, coverage, scopeGaps })
  const e = schema.recordEvidence, file = schema.storedFile
  const evidence = db.select({ id: e.id, sourceFile: e.sourceFile, attachment: e.attachment, listNo: e.listNo, page: e.page, fileId: file.id, sha256: file.sha256, removedAt: file.removedAt })
    .from(e).leftJoin(file, eq(file.relPath, e.sourceFile)).where(eq(e.recordEventId, eventId)).orderBy(asc(e.id)).all()
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
  return { process, sourceRefs, sourceGeneration: hash(sourceRefs) }
}
