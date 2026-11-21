/** SQL selection coordinates for the enterprise list, never a query-result cache.
 * Full lifecycle/evidence projections still use enterprise-roster's business rules.
 * The only JS-wide operation is the original localeCompare stable sort. */
import { and, asc, count, eq, exists, gt, inArray, isNotNull, isNull, max, min, ne, notExists, notInArray, or, sql, sum, sumDistinct, type SQL } from 'drizzle-orm'
import { alias, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { Database } from 'better-sqlite3'
import * as schema from '../../../../db/schema'
import { normalizeName } from '../domain'
import { TITLE_ORDER, DIFFERENCE_STATUS_ORDER } from '../labels'
import { identityFunctions, identityNameSql, identityUsccSql } from './enterprise-read-snapshot'
import type { RosterEnterpriseFilter, RosterEnterpriseDifference, RosterState, RosterCounts } from './enterprise-roster'
import { currentEnterpriseIdentity } from './enterprise-identity'

type Db = BetterSQLite3Database<typeof schema>
const rank = (column: SQL, values: string[]) => sql`case ${sql.join(values.map((value, i) => sql`when ${column} = ${value} then ${i}`), sql` `)} else ${values.length} end`
function membershipCtes(db: Db) {
  const enterprise = schema.enterprise
  const batch = schema.platformExportBatch
  const row = schema.platformExportRow
  const currentIdentity = currentEnterpriseIdentity(db)
  const usccKey = identityUsccSql(sql`${enterprise.usccNorm}`).as('uscc_key')
  const usccQuery = db.select({ key: usccKey, id: max(enterprise.id).as('uscc_owner_id') }).from(enterprise)
    .where(currentIdentity).groupBy(fields => fields.key)
  const nameQuery = db.select({ key: enterprise.nameNorm, id: max(enterprise.id).as('name_owner_id') }).from(enterprise)
    .where(currentIdentity).groupBy(enterprise.nameNorm)
  const usccOwners = db.$with('uscc_owners').as(usccQuery)
  const nameOwners = db.$with('name_owners').as(nameQuery)
  // Drizzle has no SQLite window-function builder.
  const ranked = db.select({
    id: batch.id,
    rank: sql<number>`row_number() over(partition by ${batch.titleCode} order by ${batch.year} desc,${batch.id} desc)`.as('n'),
  }).from(batch).as('ranked')
  const latestQuery = db.select({ id: ranked.id }).from(ranked).where(eq(ranked.rank, 1))
  const latest = db.$with('latest').as(latestQuery)
  // Preserve SQLite integer affinity for the membership join.
  const owner = sql<number>`cast(coalesce(${usccOwners.id},${nameOwners.id}) as integer)`
  const membershipQuery = db.select({
    id: owner.as('member_enterprise_id'),
    current: max(inArray(row.batchId, db.select({ id: latest.id }).from(latest))).mapWith(Number).as('current'),
  }).from(row)
    .leftJoin(usccOwners, eq(usccOwners.key, identityUsccSql(sql`${row.usccRaw}`)))
    .leftJoin(nameOwners, and(
      eq(nameOwners.key, identityNameSql(sql`${row.nameRaw}`)), isNotNull(row.nameRaw), ne(row.nameRaw, ''),
    )).groupBy(sql`coalesce(${usccOwners.id},${nameOwners.id})`)
  const membership = db.$with('membership').as(membershipQuery)
  // The query builder does not support AS MATERIALIZED. Keep the original
  // evaluation boundaries and expose the CTE columns to typed consumers.
  const ctes = sql`uscc_owners as materialized (${usccQuery.getSQL()}), name_owners as materialized (${nameQuery.getSQL()}),
    latest as (${latestQuery.getSQL()}), membership as (${membershipQuery.getSQL()})`
  return { ctes, membership }
}

/** Only platform-only selected enterprises need export membership when the
 * request does not filter by rosterState. No per-enterprise queries. */
export function removedEnterpriseIds(db: Db, ids: number[]): Set<number> {
  if (!ids.length) return new Set()
  identityFunctions(db)
  const { ctes, membership } = membershipCtes(db)
  const removed = db.select({ id: membership.id }).from(membership)
    .where(and(eq(membership.current, 0), inArray(membership.id, ids)))
  return new Set(db.all<{ member_enterprise_id: number }>(sql`with ${ctes} ${removed.getSQL()}`).map(row => row.member_enterprise_id))
}

export interface EnterpriseSelection {
  id: number
  name: string
  year: number | null
  rank: number
  state: RosterState
  difference: RosterEnterpriseDifference
}
export function compareEnterpriseSelection(sort: RosterEnterpriseFilter['sort'], a: EnterpriseSelection, b: EnterpriseSelection) {
  if (sort === 'title' && a.rank !== b.rank) return a.rank - b.rank
  if (sort !== 'name' && sort !== 'title' && a.year !== b.year) return a.year == null ? 1 : b.year == null ? -1 : b.year - a.year
  return a.name.localeCompare(b.name) || a.id - b.id
}

export function selectEnterpriseCoordinates(db: Db, filter: RosterEnterpriseFilter, limit?: number) {
  return db.transaction(() => selectCoordinates(db, filter, limit))
}

function selectCoordinates(db: Db, filter: RosterEnterpriseFilter, limit?: number, explainedOnly = false) {
  identityFunctions(db)
  const needle = filter.q?.trim() ? normalizeName(filter.q) : null
  const usccNeedle = filter.q?.trim() ? filter.q.trim().toUpperCase() : null
  // Exact district equality cannot match a lone surrogate in stored UTF-8;
  // substring search can match one UTF-16 half of a supplementary character.
  const validText = (filter.district ?? '').isWellFormed()
  const enterprise = alias(schema.enterprise, 'e')
  const record = alias(schema.record, 'r')
  const event = alias(schema.recordEvent, 'v')
  const aliasRow = alias(schema.enterpriseAlias, 'a')
  const legacyMember = schema.rosterLegacyMember
  const announcementMember = schema.rosterAnnouncementMember
  const announcementIntake = schema.rosterAnnouncementIntake
  // SQLite scalar functions, GLOB and the UTF-16 UDF have no Drizzle builders.
  const includes = (value: SQL, text: string | null) => (text ?? '').isWellFormed()
    ? gt(sql`instr(${value},${text})`, 0)
    : sql`roster84_includes_utf16(${value},${JSON.stringify(text)})`
  const search = needle != null || usccNeedle != null ? or(
    includes(identityNameSql(sql`${enterprise.name}`), needle),
    exists(db.select({ id: aliasRow.id }).from(aliasRow).where(and(
      eq(aliasRow.enterpriseId, enterprise.id), eq(aliasRow.verificationStatus, 'confirmed'),
      includes(identityNameSql(sql`${aliasRow.name}`), needle),
    ))),
    includes(sql`case when instr(${enterprise.usccNorm},char(0))>0 or ${enterprise.usccNorm} glob '*[^ -~]*'
      then roster84_upper(${enterprise.usccNorm}) else upper(coalesce(${enterprise.usccNorm},'')) end`, usccNeedle),
  ) : undefined
  const recordMatch = and(
    filter.source?.length ? inArray(record.source.getSQL(), filter.source) : undefined,
    filter.eventType?.length || filter.year?.length ? exists(db.select({ id: event.id }).from(event).where(and(
      eq(event.recordId, record.id),
      filter.eventType?.length ? inArray(event.eventType.getSQL(), filter.eventType) : undefined,
      filter.year?.length ? inArray(event.year, filter.year) : undefined,
    ))) : undefined,
  ) ?? sql`1`
  const knownTitles = !db.select({ code: schema.title.code }).from(schema.title)
    .where(notInArray(schema.title.code, TITLE_ORDER)).limit(1).get()
  const directHistory = !explainedOnly && knownTitles && !filter.rosterState && !filter.diffStatus?.length && ![filter.firstYear, filter.firstStatus, filter.source, filter.eventType, filter.year].some(values => values?.length)
  const entityId = enterprise.id
  const entityName = enterprise.name
  const entityUscc = enterprise.usccNorm
  const nominalMember = or(
    exists(db.select({ id: legacyMember.enterpriseId }).from(legacyMember).where(eq(legacyMember.enterpriseId, entityId))),
    exists(db.select({ id: announcementMember.enterpriseId }).from(announcementMember)
      .innerJoin(announcementIntake, eq(announcementIntake.id, announcementMember.intakeId))
      .where(and(eq(announcementMember.enterpriseId, entityId), isNull(announcementIntake.removedReason)))),
  )
  const explanationOwners = db.select({ id: schema.differenceReason.enterpriseId }).from(schema.differenceReason)
    .union(db.select({ id: schema.enterpriseDifferenceComparison.enterpriseId }).from(schema.enterpriseDifferenceComparison))
  const firstRecordDistrict = db.select({ district: record.district }).from(record).where(and(
    eq(record.enterpriseId, enterprise.id), isNotNull(record.district), ne(record.district, ''),
  )).orderBy(asc(record.id)).limit(1)
  const scopeFilter = and(
    currentEnterpriseIdentity(db, sql`${entityId}`),
    nominalMember,
    validText ? search : sql`0`,
    explainedOnly ? inArray(entityId, explanationOwners) : undefined,
    // SQLite COALESCE/NULLIF and scalar subqueries are expression fragments.
    filter.district ? eq(sql`coalesce(nullif(${enterprise.district},''),(${firstRecordDistrict.getSQL()}))`, filter.district) : undefined,
  )
  const scope = db.select({ id: entityId }).from(enterprise).where(scopeFilter)
  const titleMask = sql`case r.title_code ${sql.join(TITLE_ORDER.map((title,index) => sql`when ${title} then ${1<<index}`),sql` `)} else 0 end`
  const selectedMask = TITLE_ORDER.reduce((mask,title,index) => mask | (!filter.title?.length || filter.title.includes(title) ? 1<<index : 0),0)
  const scoped = db.$with('scope').as(scope)
  const awardYear = sql<number | null>`coalesce(${event.decidedYear}, ${event.year})`
  const isAward = eq(event.eventType, 'award')
  const recordFacts = db.select({
    enterpriseId: record.enterpriseId,
    title: record.titleCode,
    firstYear: min(sql`case when ${isAward} then ${awardYear} end`).mapWith(Number).as('fact_first_year'),
    awards: sum(isAward).mapWith(Number).as('fact_awards'),
    undated: max(and(isAward, isNull(awardYear))!).mapWith(Number).as('fact_undated'),
    official: max(eq(record.source, 'jxj')).mapWith(Number).as('fact_official'),
    platform: max(ne(record.source, 'jxj')).mapWith(Number).as('fact_platform'),
    recordMatch: max(sql`case when ${recordMatch} then 1 else 0 end`).mapWith(Number).as('fact_record_match'),
  }).from(record).$dynamic()
  const limitRecords = needle != null || !!filter.district || explainedOnly
  const factQuery = (limitRecords ? recordFacts.innerJoin(scoped, eq(scoped.id, record.enterpriseId)) : recordFacts)
    .leftJoin(event, eq(event.recordId, record.id)).groupBy(record.enterpriseId, record.titleCode)
  const factBase = db.$with('fact_base').as(factQuery)

  const evidence = schema.recordEvidence
  const firstAward = db.select({ id: event.id }).from(event).innerJoin(record, eq(record.id, event.recordId))
    .where(and(eq(record.enterpriseId, factBase.enterpriseId), eq(record.titleCode, factBase.title),
      isAward, eq(awardYear, factBase.firstYear)))
    .orderBy(asc(event.id)).limit(1)
  const evidenceExists = exists(db.select({ id: evidence.id }).from(evidence)
    .where(eq(evidence.recordEventId, sql`(${firstAward.getSQL()})`)))
  const factsQuery = db.select({
    enterpriseId: factBase.enterpriseId, title: factBase.title, firstYear: factBase.firstYear,
    awards: factBase.awards, undated: factBase.undated, official: factBase.official,
    platform: factBase.platform, recordMatch: factBase.recordMatch,
    status: sql<string>`case when ${isNull(factBase.firstYear)} or ${factBase.undated} or not ${evidenceExists}
      then 'pending' else 'confirmed' end`.as('fact_status'),
  }).from(factBase)
  const facts = db.$with('facts').as(factsQuery)
  const supportedTitles = ['little_giant', 'specialized_sme', 'innovative_sme']
  const recognitionMatch = and(
    filter.title?.length ? inArray(facts.title, filter.title) : undefined,
    filter.firstYear?.length ? inArray(facts.firstYear, filter.firstYear) : undefined,
    filter.firstStatus?.length ? inArray(facts.status, filter.firstStatus) : undefined,
  ) ?? sql`1`
  const comparisonTitle = inArray(facts.title, supportedTitles)
  const historyQuery = db.select({
    enterpriseId: facts.enterpriseId,
    titles: sql<string>`json_group_array(${facts.title})`.as('history_titles'),
    firstYear: min(facts.firstYear).as('history_first_year'),
    rank: min(rank(sql`${facts.title}`, TITLE_ORDER)).as('history_title_rank'),
    official: max(facts.official).mapWith(Number).as('history_official'),
    recordMatch: max(facts.recordMatch).mapWith(Number).as('history_record_match'),
    differenceCount: sum(sql`case when ${comparisonTitle} then (${ne(facts.official, facts.platform)}) else 0 end`).as('history_difference_count'),
    unkeyedDifferenceCount: sum(sql`case when ${comparisonTitle} then ${facts.official} + ${facts.platform} else 0 end`).as('history_unkeyed_difference_count'),
    recognitionPairs: sum(sql`case when ${gt(facts.awards, 0)} and ${recognitionMatch} then 1 else 0 end`).mapWith(Number).as('history_recognition_pairs'),
    titleMatch: max(sql`case when ${filter.title?.length ? inArray(facts.title, filter.title) : sql`1`} then 1 else 0 end`).mapWith(Number).as('history_title_match'),
  }).from(facts).groupBy(facts.enterpriseId)
  const history = db.$with('history').as(historyQuery)

  const reason = schema.differenceReason
  const comparison = schema.enterpriseDifferenceComparison
  const scopedIds = db.select({ id: scoped.id }).from(scoped)
  // SQLite window ordering has no Drizzle query-builder equivalent.
  const explanationsRanked = db.select({
    enterpriseId: reason.enterpriseId, title: reason.titleCode, direction: reason.direction, status: reason.status,
    reasonCode: reason.reasonCode, id: reason.id, recordedAt: reason.recordedAt,
    row: sql<number>`row_number() over(partition by ${reason.enterpriseId},${reason.titleCode},${reason.direction}
      order by ${reason.recordedAt} desc,${reason.id})`.as('explanation_row'),
  }).from(reason).where(inArray(reason.enterpriseId, scopedIds)).as('explanation_versions')
  const explanationsQuery = db.select().from(explanationsRanked).where(eq(explanationsRanked.row, 1))
  const explanations = db.$with('explanations').as(explanationsQuery)
  const explanationIds = db.select({ id: explanations.enterpriseId }).from(explanations)
  // Null credit codes never match platform evidence. The unique non-null keys
  // can only match the same enterprise.
  const derivedBranch = (direction: 'missing_in_miit' | 'extra_in_miit', present: SQL.Aliased, absent: SQL.Aliased) => db.select({
    enterpriseId: factBase.enterpriseId, title: factBase.title,
    direction: sql<string>`${direction}`.as('derived_direction'),
  }).from(factBase).innerJoin(enterprise, eq(enterprise.id, factBase.enterpriseId))
    .where(and(inArray(factBase.title, supportedTitles), eq(present, 1),
      or(isNull(enterprise.usccNorm), eq(absent, 0)), inArray(factBase.enterpriseId, explanationIds)))
  const derivedQuery = derivedBranch('missing_in_miit', factBase.official, factBase.platform)
    .unionAll(derivedBranch('extra_in_miit', factBase.platform, factBase.official))
  const derived = db.$with('derived').as(derivedQuery)
  const sameExplanation = and(eq(derived.enterpriseId, explanations.enterpriseId),
    eq(derived.title, explanations.title), eq(derived.direction, explanations.direction))
  const legacyQuery = db.select({
    enterpriseId: derived.enterpriseId, title: derived.title, direction: derived.direction,
    status: sql<string>`coalesce(${explanations.status}, 'not_queried')`.as('legacy_status'),
    reasonCode: explanations.reasonCode,
    current: sql<number>`1`.as('legacy_current'),
  }).from(derived).leftJoin(explanations, sameExplanation).unionAll(db.select({
    enterpriseId: explanations.enterpriseId, title: explanations.title, direction: sql<string>`${explanations.direction}`,
    status: sql<string>`${explanations.status}`, reasonCode: explanations.reasonCode,
    current: sql<number>`0`,
  }).from(explanations).where(notExists(db.select({ id: derived.enterpriseId }).from(derived).where(sameExplanation))))
  const legacy = db.$with('legacy_coordinates').as(legacyQuery)
  const refreshedQuery = db.select({
    enterpriseId: explanations.enterpriseId, title: explanations.title, status: explanations.status, reasonCode: explanations.reasonCode,
    latest: sql<number>`row_number() over(partition by ${explanations.enterpriseId},${explanations.title}
      order by ${explanations.recordedAt} desc,${explanations.id} desc)`.as('refresh_row'),
  }).from(explanations).innerJoin(comparison, and(eq(comparison.enterpriseId, explanations.enterpriseId),
    eq(comparison.titleCode, explanations.title))).where(gt(explanations.id, comparison.decisionCutoffId))
  const refreshed = db.$with('refreshed_decisions').as(refreshedQuery)
  const coordinatesQuery = db.select({
    enterpriseId: legacy.enterpriseId, title: legacy.title, direction: legacy.direction,
    status: legacy.status, reasonCode: legacy.reasonCode, current: legacy.current,
  }).from(legacy).where(notExists(db.select({ id: comparison.enterpriseId }).from(comparison)
    .where(and(eq(comparison.enterpriseId, legacy.enterpriseId), eq(comparison.titleCode, legacy.title)))))
    .unionAll(db.select({
      enterpriseId: comparison.enterpriseId, title: comparison.titleCode,
      direction: sql<string>`'missing_in_miit'`,
      status: sql<string>`coalesce(${refreshed.status}, 'needs_review')`,
      reasonCode: refreshed.reasonCode, current: sql<number>`1`,
    }).from(comparison).leftJoin(refreshed, and(eq(refreshed.enterpriseId, comparison.enterpriseId),
      eq(refreshed.title, comparison.titleCode), eq(refreshed.latest, 1)))
      .where(inArray(comparison.enterpriseId, scopedIds)))
  const coordinates = db.$with('coordinates').as(coordinatesQuery)
  const rankedDifferencesQuery = db.select({
    enterpriseId: coordinates.enterpriseId, title: coordinates.title, direction: coordinates.direction,
    status: coordinates.status, reasonCode: coordinates.reasonCode, current: coordinates.current,
    row: sql<number>`row_number() over(partition by ${coordinates.enterpriseId}
      order by ${rank(sql`${coordinates.status}`, DIFFERENCE_STATUS_ORDER)} desc,
        ${rank(sql`${coordinates.title}`, TITLE_ORDER)},${coordinates.direction})`.as('difference_row'),
  }).from(coordinates)
  const rankedDifferences = db.$with('ranked_differences').as(rankedDifferencesQuery)
  const differencesQuery = db.select({
    enterpriseId: rankedDifferences.enterpriseId,
    count: count().as('difference_count'),
    current: max(rankedDifferences.current).as('difference_any_current'),
    status: max(sql`case when ${eq(rankedDifferences.row, 1)} then ${rankedDifferences.status} end`).as('difference_status'),
    reasonCode: max(sql`case when ${eq(rankedDifferences.row, 1)} then ${rankedDifferences.reasonCode} end`).as('difference_reason'),
  }).from(rankedDifferences).groupBy(rankedDifferences.enterpriseId)
  const differences = db.$with('explained_differences').as(differencesQuery)
  const { ctes: membershipQueries, membership } = membershipCtes(db)
  const defaultDifference = sql<number>`case when ${isNull(entityUscc)}
    then coalesce(${history.unkeyedDifferenceCount},0) else coalesce(${history.differenceCount},0) end`
  const differenceCount = sql<number>`coalesce(${differences.count},${defaultDifference})`
  const differenceStatus = sql<string>`coalesce(${differences.status},case when ${gt(defaultDifference, 0)} then 'not_queried' end)`
  const selectedStatuses = filter.diffStatus?.filter(status => status !== 'none') ?? []
  const diffFilter = filter.diffStatus?.length ? or(
    filter.diffStatus.includes('none') ? eq(differenceCount, 0) : undefined,
    selectedStatuses.length ? inArray(differenceStatus, selectedStatuses) : undefined,
    selectedStatuses.length ? exists(db.select({ id: coordinates.enterpriseId }).from(coordinates).where(and(
      eq(coordinates.enterpriseId, entityId), inArray(coordinates.status, selectedStatuses), ne(coordinates.status, 'none'),
    ))) : undefined,
    selectedStatuses.length ? inArray(differences.reasonCode, selectedStatuses) : undefined,
  ) : undefined
  const state = filter.rosterState ? sql<RosterState>`case when ${eq(history.official, 0)}
    and ${isNotNull(membership.id)} and not ${membership.current} then 'removed_platform_only' else 'current' end`
    : sql<RosterState>`'current'`
  const selection = db.select({
    id: entityId, name: entityName, titles: history.titles, firstYear: history.firstYear, rank: history.rank,
    recognitionPairs: history.recognitionPairs, state, differenceCount, status: differenceStatus,
    reasonCode: differences.reasonCode, differenceCurrent: sql`coalesce(${differences.current},${gt(defaultDifference, 0)})`,
  }).from(scoped).innerJoin(enterprise, eq(enterprise.id, scoped.id))
    .leftJoin(history, eq(history.enterpriseId, enterprise.id))
    .leftJoin(differences, eq(differences.enterpriseId, enterprise.id)).$dynamic()
  const candidateQuery = (filter.rosterState
    ? selection.leftJoin(membership, eq(membership.id, sql`+${enterprise.id}`))
    : selection).where(and(
    filter.title?.length ? eq(history.titleMatch, 1) : undefined,
    filter.firstYear?.length || filter.firstStatus?.length ? gt(history.recognitionPairs, 0) : undefined,
    filter.source?.length || filter.eventType?.length || filter.year?.length ? eq(history.recordMatch, 1) : undefined,
    filter.rosterState ? eq(state, filter.rosterState) : undefined,
    diffFilter,
  ))
  // Drizzle does not expose SQLite's MATERIALIZED hint. The surrounding
  // CTE declarations preserve the original evaluation boundaries.
  const generalQuery = sql`with scope as materialized (${scope.getSQL()}),
    fact_base as materialized (${factQuery.getSQL()}), facts as (${factsQuery.getSQL()}), history as (${historyQuery.getSQL()}),
    explanations as materialized (${explanationsQuery.getSQL()}), derived as materialized (${derivedQuery.getSQL()}),
    legacy_coordinates as materialized (${legacyQuery.getSQL()}), refreshed_decisions as (${refreshedQuery.getSQL()}),
    coordinates as materialized (${coordinatesQuery.getSQL()}), ranked_differences as (${rankedDifferencesQuery.getSQL()}),
    explained_differences as (${differencesQuery.getSQL()}), ${membershipQueries} ${candidateQuery.getSQL()}`
  // Compute the sparse explained subset once, rather than forcing every
  // enterprise through window/coordinate joins. This map is request-local and
  // has no archive fields; the common masks still include every enterprise.
  const explained = directHistory ? new Map(selectCoordinates(db, filter, undefined, true).candidates.map(row => [row.id,row.difference])) : null
  // Drizzle has no CASE, COALESCE, or bit-shift expression builders.
  const directAward = eq(event.eventType, 'award')
  const directAwardYear = sql`coalesce(${event.decidedYear},${event.year})`
  const directQuery = db.select({
    id: entityId,
    name: entityName,
    unkeyed: isNull(entityUscc),
    firstYear: min(sql`case when ${directAward} then ${directAwardYear} end`).mapWith(Number),
    sourceMask: sumDistinct(sql`case when ${eq(record.source, 'jxj')} then ${titleMask} else (${titleMask} << ${TITLE_ORDER.length}) end`).mapWith(Number),
    recognitionMask: sumDistinct(sql`case when ${directAward} then ${titleMask} else 0 end`).mapWith(Number),
  }).from(enterprise).leftJoin(record, eq(record.enterpriseId, enterprise.id))
    .leftJoin(event, eq(event.recordId, record.id)).where(scopeFilter).groupBy(enterprise.id)
  // The SQLite builder exposes only eager reads. Keep the native iterator so
  // bounded pagination never duplicates all coordinate rows in memory.
  const bound = directHistory ? directQuery.toSQL() : new SQLiteSyncDialect().sqlToQuery(generalQuery)
  const rows = (db as Db & { $client: Database }).$client.prepare(bound.sql).raw().iterate(...bound.params) as Iterable<unknown[]>
  const counts: RosterCounts = { total: 0, titlePairs: 0, recognitionPairs: 0, differences: 0, titles: Object.fromEntries(TITLE_ORDER.map(code => [code, 0])) }
  const candidates: EnterpriseSelection[] = []
  const sort = filter.sort ?? 'recognition'
  const compare = (a: EnterpriseSelection, b: EnterpriseSelection) => compareEnterpriseSelection(sort, a, b)
  const popcount = (mask: number) => { let count=0; while (mask) { mask &= mask-1; count++ } return count }
  for (const values of rows) {
    const id=values[0] as number, name=values[1] as string, year=values[3] as number|null
    const sourceMask=directHistory ? values[4] as number : 0
    const officialMask=sourceMask & ((1<<TITLE_ORDER.length)-1), platformMask=sourceMask >>> TITLE_ORDER.length
    const recognitionMask=directHistory ? values[5] as number : 0
    const titles=directHistory ? officialMask | platformMask : values[2] as string|null
    const storedRank=directHistory ? null : values[4] as number|null
    const storedRecognitions=directHistory ? null : values[5] as number|null
    const state=directHistory ? 'current' : values[6] as RosterState
    const storedCount=directHistory ? (values[2] ? -1 : null) : values[7] as number|null
    const storedStatus=directHistory ? null : values[8] as string|null
    const reasonCode=directHistory ? null : values[9] as string|null
    const storedCurrent=directHistory ? null : values[10] as number|null
    if (directHistory && filter.title?.length && !((titles as number) & selectedMask)) continue
    const mask = typeof titles === 'number' ? titles : 0
    const titleRank = directHistory ? TITLE_ORDER.findIndex((_,index) => mask & (1<<index)) : storedRank
    const recognitions = directHistory ? popcount(recognitionMask! & selectedMask) : storedRecognitions
    const count = storedCount ?? (directHistory ? (officialMask! | platformMask!)-(officialMask! & platformMask!) : 0)
    const defaultCount = storedCount === -1 ? popcount(officialMask!)+popcount(platformMask!) : directHistory && storedCount == null ? popcount(count) : count
    const override = explained?.get(id)
    const differenceCount = override?.count ?? defaultCount
    const status = override?.status ?? storedStatus ?? (differenceCount>0 ? 'not_queried' : null)
    const current = override?.anyCurrent ?? storedCurrent ?? (differenceCount>0 ? 1 : 0)
    counts.total++; counts.recognitionPairs += recognitions ?? 0; counts.differences += differenceCount
    if (typeof titles === 'number') {
      for (let index=0; index<TITLE_ORDER.length; index++) if (titles & (1<<index)) { const title=TITLE_ORDER[index]!; counts.titlePairs++; counts.titles[title] = (counts.titles[title] ?? 0)+1 }
    } else for (const title of titles == null ? [] : JSON.parse(titles) as string[]) { counts.titlePairs++; counts.titles[title] = (counts.titles[title] ?? 0) + 1 }
    const last = candidates[candidates.length-1]
    if (limit != null && candidates.length === limit && last && sort === 'recognition' && year !== last.year && (year == null || (last.year != null && year<last.year))) continue
    const candidate = { id,name,year,rank: titleRank == null || titleRank<0 ? TITLE_ORDER.length : titleRank,state,difference: { count: differenceCount,status,reasonCode: override ? override.reasonCode : reasonCode,anyCurrent: !!current } }
    if (limit == null) candidates.push(candidate)
    else if (candidates.length < limit || compare(candidate,candidates[candidates.length-1]!) < 0) {
      // Exact bounded top-(page*size), using the original JS locale ordering.
      // Counts include every row; off-page lifecycle/sort rows are not retained.
      let lo=0, hi=candidates.length
      while (lo<hi) { const mid=(lo+hi)>>>1; if (compare(candidate,candidates[mid]!)<0) hi=mid; else lo=mid+1 }
      candidates.splice(lo,0,candidate)
      if (candidates.length>limit) candidates.pop()
    }
  }
  if (limit == null && !explainedOnly) candidates.sort(compare)
  return { candidates, counts }
}
