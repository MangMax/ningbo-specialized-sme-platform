/** SQL selection coordinates for the enterprise list, never a query-result cache.
 * Full lifecycle/evidence projections still use enterprise-roster's business rules.
 * The only JS-wide operation is the original localeCompare stable sort. */
import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, max, ne, notInArray, or, sql, type SQL } from 'drizzle-orm'
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
const selected = (column: SQL, values?: (string | number)[]) => values?.length ? inArray(column, values) : sql`1`
function membershipCtes(db: Db) {
  const enterprise = schema.enterprise
  const batch = schema.platformExportBatch
  const row = schema.platformExportRow
  const currentIdentity = currentEnterpriseIdentity(db)
  const usccKey = identityUsccSql(sql`${enterprise.usccNorm}`).as('uscc_key')
  const usccQuery = db.select({ key: usccKey, id: max(enterprise.id).as('uscc_owner_id') }).from(enterprise)
    .where(currentIdentity).groupBy(usccKey)
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
    id: owner.as('id'),
    current: max(inArray(row.batchId, db.select({ id: latest.id }).from(latest))).as('current'),
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
  return new Set(db.all<{ id: number }>(sql`with ${ctes} ${removed.getSQL()}`).map(row => row.id))
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
  const recognitionMatch = and(selected(sql`f.title_code`, filter.title), selected(sql`f.first_year`, filter.firstYear), selected(sql`f.status`, filter.firstStatus))!
  const recordMatch = and(
    filter.source?.length ? inArray(record.source, filter.source) : undefined,
    filter.eventType?.length || filter.year?.length ? exists(db.select({ id: event.id }).from(event).where(and(
      eq(event.recordId, record.id),
      filter.eventType?.length ? inArray(event.eventType, filter.eventType) : undefined,
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
  const defaultDifference = sql`case when ${entityUscc} is null then coalesce(h.unkeyed_difference_count,0) else coalesce(h.difference_count,0) end`
  const differenceCount = sql`coalesce(d.count,${defaultDifference})`
  const differenceStatus = sql`coalesce(d.status,case when ${defaultDifference}>0 then 'not_queried' end)`
  const diffFilter = filter.diffStatus?.length ? sql`(
    ${filter.diffStatus.includes('none') ? sql`${differenceCount}=0` : sql`0`} or
    ${inArray(differenceStatus, filter.diffStatus.filter(x => x !== 'none'))} or
    exists(select 1 from coordinates c where c.enterprise_id=${entityId} and ${selected(sql`c.status`, filter.diffStatus.filter(x => x !== 'none'))} and c.status != 'none'
      ${filter.diffStatus.every(x => x === 'none') ? sql`and 0` : sql``}) or ${inArray(sql`d.reason`, filter.diffStatus.filter(x => x !== 'none'))})` : sql`1`
  // SQLite materialized CTEs and window projections have no builder equivalents.
  const generalQuery = sql`
    with scope as materialized (
      ${scope.getSQL()}
    ), fact_base as materialized (
      select r.enterprise_id,r.title_code,
        min(case when v.event_type='award' then coalesce(v.decided_year,v.year) end) as first_year,
        sum(v.event_type='award') as awards,
        max(v.event_type='award' and coalesce(v.decided_year,v.year) is null) as undated,
        max(r.source='jxj') as official,max(r.source!='jxj') as platform,
        max(case when ${recordMatch} then 1 else 0 end) as record_match
      from record r ${needle != null || filter.district || explainedOnly ? sql`join scope o on o.id=r.enterprise_id` : sql``}
        left join record_event v on v.record_id=r.id
      group by r.enterprise_id,r.title_code
    ), facts as (
      select f.*,case when f.first_year is null or f.undated or not exists (
        select 1 from record_evidence ev where ev.record_event_id=(
          select v.id from record r join record_event v on v.record_id=r.id
          where r.enterprise_id=f.enterprise_id and r.title_code=f.title_code and v.event_type='award'
            and coalesce(v.decided_year,v.year)=f.first_year order by v.id limit 1)) then 'pending' else 'confirmed' end as status
      from fact_base f
    ), history as (
      select f.enterprise_id,json_group_array(f.title_code) as titles,min(f.first_year) as first_year,
        min(${rank(sql`f.title_code`, TITLE_ORDER)}) as title_rank,max(f.official) as official,max(f.record_match) as record_match,
        sum(case when f.title_code in ('little_giant','specialized_sme','innovative_sme') then (f.official != f.platform) else 0 end) as difference_count,
        sum(case when f.title_code in ('little_giant','specialized_sme','innovative_sme') then f.official + f.platform else 0 end) as unkeyed_difference_count,
        sum(case when f.awards>0 and ${recognitionMatch} then 1 else 0 end) as recognition_pairs,
        max(case when ${selected(sql`f.title_code`, filter.title)} then 1 else 0 end) as title_match
      from facts f group by f.enterprise_id
    ), derived as materialized (
      -- uscc_norm is UNIQUE in the existing schema; non-null exact keys can
      -- only refer to this enterprise. Null keys deliberately never match.
      select f.enterprise_id,f.title_code,'missing_in_miit' as direction from fact_base f join enterprise e on e.id=f.enterprise_id
        where title_code in ('little_giant','specialized_sme','innovative_sme') and official and (uscc_norm is null or not platform)
          and enterprise_id in (select enterprise_id from explanations)
      union all select f.enterprise_id,f.title_code,'extra_in_miit' from fact_base f join enterprise e on e.id=f.enterprise_id
        where title_code in ('little_giant','specialized_sme','innovative_sme') and platform and (uscc_norm is null or not official)
          and enterprise_id in (select enterprise_id from explanations)
    ), explanation_versions as (
      select enterprise_id,title_code,direction,status,reason_code,recorded_at,id,row_number() over(partition by enterprise_id,title_code,direction order by recorded_at desc,id) as n
      from difference_reason where enterprise_id in (select id from scope)
    ), explanations as materialized (select * from explanation_versions where n=1), legacy_coordinates as materialized (
      select d.*,coalesce(x.status,'not_queried') as status,x.reason_code,1 as current from derived d left join explanations x
        on x.enterprise_id=d.enterprise_id and x.title_code=d.title_code and x.direction=d.direction
      union all select x.enterprise_id,x.title_code,x.direction,x.status,x.reason_code,0 from explanations x where not exists(
        select 1 from derived d where d.enterprise_id=x.enterprise_id and d.title_code=x.title_code and d.direction=x.direction)
    ), refreshed_decisions as (
      select x.*,row_number() over(partition by x.enterprise_id,x.title_code order by x.recorded_at desc,x.id desc) as latest
      from explanations x join enterprise_difference_comparison c on c.enterprise_id=x.enterprise_id and c.title_code=x.title_code where x.id>c.decision_cutoff_id
    ), coordinates as materialized (
      select x.* from legacy_coordinates x where not exists(select 1 from enterprise_difference_comparison c where c.enterprise_id=x.enterprise_id and c.title_code=x.title_code)
      union all select c.enterprise_id,c.title_code,'missing_in_miit',coalesce(d.status,'needs_review'),d.reason_code,1
      from enterprise_difference_comparison c left join refreshed_decisions d on d.enterprise_id=c.enterprise_id and d.title_code=c.title_code and d.latest=1
      where c.enterprise_id in (select id from scope)
    ), ranked_differences as (
      select *,row_number() over(partition by enterprise_id order by ${rank(sql`status`, DIFFERENCE_STATUS_ORDER)} desc,${rank(sql`title_code`, TITLE_ORDER)},direction) as n from coordinates
    ), explained_differences as (
      select enterprise_id,count(*) as count,max(current) as current,max(case when n=1 then status end) as status,
        max(case when n=1 then reason_code end) as reason from ranked_differences group by enterprise_id
    ), ${membershipCtes(db).ctes}, candidates as (
      select ${entityId} as id,${entityName} as name,h.titles,h.first_year,h.title_rank,h.recognition_pairs,
        ${filter.rosterState ? sql`case when h.official=0 and m.id is not null and not m.current then 'removed_platform_only' else 'current' end` : sql`'current'`} as state,
        ${differenceCount} as difference_count,${differenceStatus} as status,d.reason,coalesce(d.current,${defaultDifference}>0) as difference_current
      from scope o join enterprise e on e.id=o.id left join history h on h.enterprise_id=e.id left join explained_differences d on d.enterprise_id=${entityId}
        ${filter.rosterState ? sql`left join membership m on m.id=+e.id` : sql``}
      where ${filter.title?.length ? sql`h.title_match=1` : sql`1`}
        and ${filter.firstYear?.length || filter.firstStatus?.length ? sql`h.recognition_pairs>0` : sql`1`}
        and ${filter.source?.length || filter.eventType?.length || filter.year?.length ? sql`h.record_match=1` : sql`1`}
        and ${diffFilter}
    ) select * from candidates where ${filter.rosterState ? sql`state=${filter.rosterState}` : sql`1`}`
  // Compute the sparse explained subset once, rather than forcing every
  // enterprise through window/coordinate joins. This map is request-local and
  // has no archive fields; the common masks still include every enterprise.
  const explained = directHistory ? new Map(selectCoordinates(db, filter, undefined, true).candidates.map(row => [row.id,row.difference])) : null
  // The CASE expressions and bit masks are the SQLite aggregate projections.
  const directQuery = db.select({
    id: entityId,
    name: entityName,
    unkeyed: isNull(entityUscc),
    firstYear: sql`min(case when ${event.eventType}='award' then coalesce(${event.decidedYear},${event.year}) end)`,
    sourceMask: sql`sum(distinct case when ${record.source}='jxj' then ${titleMask} else (${titleMask} << ${TITLE_ORDER.length}) end)`,
    recognitionMask: sql`sum(distinct case when ${event.eventType}='award' then ${titleMask} else 0 end)`,
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
