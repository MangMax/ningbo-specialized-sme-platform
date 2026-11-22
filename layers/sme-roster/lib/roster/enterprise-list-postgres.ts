import { and, count, desc, eq, exists, gt, inArray, isNotNull, isNull, min, ne, notExists, or, sql, sum, type SQLWrapper } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise, enterpriseAlias, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { platformExportBatch, platformExportRow } from '../../../../db/postgresql/platform-tables'
import { differenceReason, enterpriseDifferenceComparison, rosterAnnouncementIntake, rosterAnnouncementMember, rosterLegacyMember } from '../../../../db/postgresql/roster-selection-tables'
import type { FormalValidity } from '../../../../db/record-event-formal-validity'
import { normalizeName, normalizeUscc } from '../domain'
import { DIFFERENCE_STATUS_ORDER, TITLE_ORDER } from '../labels'
import { compareEnterpriseSelection, type EnterpriseSelection } from './enterprise-selection'
import { isPageCapable } from './evidence-page'
import { projectRosterEnterprisePage, rosterPageOf, type RosterCounts, type RosterEnterpriseFilter, type RosterEnterprisesResult } from './enterprise-roster-projection'

type Reader = Pick<NodePgDatabase, 'select' | 'selectDistinctOn' | '$with' | 'with'>

function currentIdentity(db: Reader) {
  return notExists(db.select({ id: enterpriseMerge.fromEnterpriseId }).from(enterpriseMerge)
    .where(eq(enterpriseMerge.fromEnterpriseId, enterprise.id)))
}

// Individual SQL expressions cover PostgreSQL operators, collation and aggregates
// for which Drizzle 0.45 has no typed builder. Large ID sets use a single array
// to stay within the PostgreSQL bind parameter limit.
const anyId = (column: SQLWrapper, values: readonly number[]) => sql`${column} = ANY(${sql.param(values)}::bigint[])`
const yearSelected = (column: SQLWrapper, values?: number[]) => values?.length
  ? anyId(column, values.filter(Number.isSafeInteger)) : undefined
const bytewise = (value: SQLWrapper) => sql`${value} COLLATE "C"`
const rank = (column: SQLWrapper, values: string[]) =>
  sql<number>`coalesce(array_position(${sql.param(values)}::text[], ${column}) - 1, ${values.length}::integer)`
const boolOr = (value: SQLWrapper) => sql<boolean>`bool_or(${value})`
const filterCount = (value: SQLWrapper) => sql<number>`count(*) FILTER (WHERE ${value})`.mapWith(Number)
const coalesce = <T>(value: SQLWrapper, fallback: SQLWrapper | T) => sql<T>`coalesce(${value}, ${fallback})`
const parseQualityFlags = (value: string | null): string[] | null => value === null ? null : JSON.parse(value)

async function searchEnterpriseIds(db: Reader, raw: string | undefined) {
  if (!raw?.trim()) return undefined
  const needle = normalizeName(raw), uscc = raw.trim().toUpperCase()
  const rows = await db.select({
    id: enterprise.id,
    name: enterprise.name,
    uscc: enterprise.usccNorm,
    alias: enterpriseAlias.name,
  }).from(enterprise).leftJoin(enterpriseAlias, and(eq(enterpriseAlias.enterpriseId, enterprise.id),
    eq(enterpriseAlias.verificationStatus, 'confirmed'))).where(currentIdentity(db))
  const ids = new Set<number>()
  for (const row of rows) {
    if (normalizeName(row.name).includes(needle) || (row.alias !== null && normalizeName(row.alias).includes(needle))
      || (row.uscc ?? '').toUpperCase().includes(uscc)) ids.add(row.id)
  }
  return [...ids]
}

export async function formerPlatformMembers(db: Reader) {
  const owners = await db.select({ id: enterprise.id, uscc: enterprise.usccNorm, name: enterprise.nameNorm })
    .from(enterprise).where(currentIdentity(db)).orderBy(enterprise.id)
  const uscc = new Map<string, number>(), names = new Map<string, number>()
  for (const owner of owners) {
    const code = normalizeUscc(owner.uscc)
    if (code) uscc.set(code, owner.id)
    names.set(owner.name, owner.id)
  }
  const latestBatch = db.$with('latest_batch').as(db.selectDistinctOn([platformExportBatch.titleCode], { id: platformExportBatch.id })
    .from(platformExportBatch).orderBy(platformExportBatch.titleCode, desc(platformExportBatch.year), desc(platformExportBatch.id)))
  const rows = await db.with(latestBatch).select({
    uscc: platformExportRow.usccRaw,
    name: platformExportRow.nameRaw,
    latest: isNotNull(latestBatch.id),
  }).from(platformExportRow).leftJoin(latestBatch, eq(latestBatch.id, platformExportRow.batchId))
  const historical = new Set<number>(), latest = new Set<number>()
  for (const row of rows) {
    const id = uscc.get(normalizeUscc(row.uscc)) ?? (row.name ? names.get(normalizeName(row.name)) : undefined)
    if (id === undefined) continue
    if (row.latest) latest.add(id)
    else historical.add(id)
  }
  return historical.difference(latest)
}

async function readCandidates(db: Reader, filter: RosterEnterpriseFilter) {
  const searchIds = await searchEnterpriseIds(db, filter.q)
  const districtFallback = db.select({ district: record.district }).from(record)
    .where(and(eq(record.enterpriseId, enterprise.id), isNotNull(record.district), ne(record.district, '')))
    .orderBy(record.id).limit(1)
  const district = filter.district
  const districtMatch = district ? (district.includes('\0') || !district.isWellFormed()
    ? inArray(enterprise.district, []) : eq(coalesce<string>(sql`nullif(${enterprise.district}, '')`, districtFallback), district)) : undefined
  const scope = db.$with('scope').as(db.select({ id: enterprise.id }).from(enterprise).where(and(
    currentIdentity(db),
    or(
      exists(db.select({ id: rosterLegacyMember.enterpriseId }).from(rosterLegacyMember)
        .where(eq(rosterLegacyMember.enterpriseId, enterprise.id))),
      exists(db.select({ id: rosterAnnouncementMember.enterpriseId }).from(rosterAnnouncementMember)
        .innerJoin(rosterAnnouncementIntake, eq(rosterAnnouncementIntake.id, rosterAnnouncementMember.intakeId))
        .where(and(eq(rosterAnnouncementMember.enterpriseId, enterprise.id), isNull(rosterAnnouncementIntake.removedReason)))),
    ),
    searchIds ? anyId(enterprise.id, searchIds) : undefined,
    districtMatch,
  )))
  const eventMatch = filter.eventType?.length || filter.year?.length
    ? exists(db.select({ id: recordEvent.id }).from(recordEvent).where(and(
      eq(recordEvent.recordId, record.id),
      filter.eventType?.length ? inArray(sql<string>`${recordEvent.eventType}`, filter.eventType.filter(value => !value.includes('\0'))) : undefined,
      yearSelected(recordEvent.year, filter.year),
    ))) : undefined
  const recordMatch = and(
    filter.source?.length ? inArray(sql<string>`${record.source}`, filter.source.filter(value => !value.includes('\0'))) : undefined,
    eventMatch,
  ) ?? isNotNull(record.id)
  const award = eq(recordEvent.eventType, 'award')
  const eventYear = coalesce<number | null>(recordEvent.decidedYear, recordEvent.year)
  const facts = db.$with('fact_base').as(db.select({
    enterpriseId: record.enterpriseId,
    titleCode: record.titleCode,
    firstYear: sql<number | null>`min(${eventYear}) FILTER (WHERE ${award})`.mapWith(Number).as('first_year'),
    awards: filterCount(award).as('awards'),
    undated: boolOr(and(award, isNull(eventYear))!).as('undated'),
    official: boolOr(eq(record.source, 'jxj')).as('official'),
    platform: boolOr(ne(record.source, 'jxj')).as('platform'),
    recordMatch: boolOr(recordMatch).as('record_match'),
    recordCount: count().as('record_count'),
  }).from(record).innerJoin(scope, eq(scope.id, record.enterpriseId))
    .leftJoin(recordEvent, eq(recordEvent.recordId, record.id)).groupBy(record.enterpriseId, record.titleCode))
  const earliestAward = db.select({ id: recordEvent.id }).from(record)
    .innerJoin(recordEvent, eq(recordEvent.recordId, record.id)).where(and(eq(record.enterpriseId, facts.enterpriseId),
      eq(record.titleCode, facts.titleCode), award, eq(eventYear, facts.firstYear))).orderBy(recordEvent.id).limit(1)
  const pending = or(isNull(facts.firstYear), facts.undated, notExists(db.select({ id: recordEvidence.id }).from(recordEvidence)
    .where(eq(recordEvidence.recordEventId, earliestAward))))!
  const recognitionStatus = sql<string>`case when ${pending} then 'pending' else 'confirmed' end`
  const selectedTitle = filter.title?.length ? inArray(facts.titleCode, filter.title.filter(value => !value.includes('\0'))) : isNotNull(facts.titleCode)
  const knownTitle = inArray(facts.titleCode, TITLE_ORDER)
  const recognition = and(gt(facts.awards, 0), selectedTitle, yearSelected(facts.firstYear, filter.firstYear),
    filter.firstStatus?.length ? inArray(recognitionStatus, filter.firstStatus.filter(value => !value.includes('\0'))) : undefined)!
  const history = db.$with('history').as(db.select({
    enterpriseId: facts.enterpriseId,
    titles: sql<string[]>`array_agg(${facts.titleCode})`.as('titles'),
    firstYear: min(facts.firstYear).mapWith(Number).as('first_recognition_year'),
    titleRank: min(rank(facts.titleCode, TITLE_ORDER)).mapWith(Number).as('title_rank'),
    official: boolOr(facts.official).as('has_official'),
    recordMatch: boolOr(facts.recordMatch).as('has_record_match'),
    recordCount: sum(facts.recordCount).mapWith(Number).as('total_record_count'),
    differenceCount: filterCount(and(knownTitle, ne(facts.official, facts.platform))!).as('difference_count'),
    unkeyedDifferenceCount: sql<number>`coalesce(sum(${facts.official}::int + ${facts.platform}::int) FILTER (WHERE ${knownTitle}), 0)`.mapWith(Number).as('unkeyed_difference_count'),
    recognitionPairs: filterCount(recognition).as('recognition_pairs'),
    titleMatch: boolOr(selectedTitle).as('title_match'),
  }).from(facts).groupBy(facts.enterpriseId))

  const explanationKey = { enterpriseId: differenceReason.enterpriseId, titleCode: differenceReason.titleCode, direction: differenceReason.direction }
  const explanationColumns = { ...explanationKey, status: differenceReason.status, reasonCode: differenceReason.reasonCode }
  const explanations = db.$with('explanations').as(db.selectDistinctOn(Object.values(explanationKey), {
    ...explanationColumns, id: differenceReason.id, recordedAt: differenceReason.recordedAt,
  }).from(differenceReason).where(inArray(differenceReason.enterpriseId, db.select({ id: scope.id }).from(scope)))
    .orderBy(...Object.values(explanationKey), desc(bytewise(differenceReason.recordedAt)), differenceReason.id))
  const derivable = and(knownTitle, inArray(facts.enterpriseId, db.select({ id: explanations.enterpriseId }).from(explanations)))
  const derived = db.$with('derived').as(db.select({
    enterpriseId: facts.enterpriseId, titleCode: facts.titleCode,
    direction: sql<string>`'missing_in_miit'::text`.as('derived_direction'),
  }).from(facts).innerJoin(enterprise, eq(enterprise.id, facts.enterpriseId))
    .where(and(derivable, facts.official, or(isNull(enterprise.usccNorm), eq(facts.platform, false))))
    .unionAll(db.select({
      enterpriseId: facts.enterpriseId, titleCode: facts.titleCode, direction: sql<string>`'extra_in_miit'::text`.as('derived_direction'),
    }).from(facts).innerJoin(enterprise, eq(enterprise.id, facts.enterpriseId))
      .where(and(derivable, facts.platform, or(isNull(enterprise.usccNorm), eq(facts.official, false))))))
  const sameCoordinate = and(eq(derived.enterpriseId, explanations.enterpriseId), eq(derived.titleCode, explanations.titleCode),
    eq(derived.direction, explanations.direction))
  const legacy = db.$with('legacy_coordinates').as(db.select({
    enterpriseId: derived.enterpriseId, titleCode: derived.titleCode, direction: derived.direction,
    status: coalesce<string>(explanations.status, 'not_queried').as('status'), reasonCode: explanations.reasonCode,
    current: sql<boolean>`true`.as('current'),
  }).from(derived).leftJoin(explanations, sameCoordinate).unionAll(db.select({
    enterpriseId: explanations.enterpriseId, titleCode: explanations.titleCode, direction: explanations.direction,
    status: explanations.status, reasonCode: explanations.reasonCode, current: sql<boolean>`false`.as('current'),
  }).from(explanations).where(notExists(db.select({ id: derived.enterpriseId }).from(derived).where(sameCoordinate)))))
  const samePair = (enterpriseId: SQLWrapper, titleCode: SQLWrapper) =>
    and(eq(enterpriseDifferenceComparison.enterpriseId, enterpriseId), eq(enterpriseDifferenceComparison.titleCode, titleCode))
  const refreshed = db.$with('refreshed_decisions').as(db.selectDistinctOn([explanations.enterpriseId, explanations.titleCode], {
    enterpriseId: explanations.enterpriseId, titleCode: explanations.titleCode, status: explanations.status, reasonCode: explanations.reasonCode,
  }).from(explanations).innerJoin(enterpriseDifferenceComparison, samePair(explanations.enterpriseId, explanations.titleCode))
    .where(gt(explanations.id, enterpriseDifferenceComparison.decisionCutoffId))
    .orderBy(explanations.enterpriseId, explanations.titleCode, desc(bytewise(explanations.recordedAt)), desc(explanations.id)))
  const coordinates = db.$with('coordinates').as(db.select().from(legacy)
    .where(notExists(db.select({ id: enterpriseDifferenceComparison.enterpriseId }).from(enterpriseDifferenceComparison)
      .where(samePair(legacy.enterpriseId, legacy.titleCode))))
    .unionAll(db.select({
      enterpriseId: enterpriseDifferenceComparison.enterpriseId, titleCode: enterpriseDifferenceComparison.titleCode,
      direction: sql<string>`'missing_in_miit'::text`,
      status: coalesce<string>(refreshed.status, 'needs_review').as('status'), reasonCode: refreshed.reasonCode,
      current: sql<boolean>`true`.as('current'),
    }).from(enterpriseDifferenceComparison).leftJoin(refreshed, samePair(refreshed.enterpriseId, refreshed.titleCode))
      .where(inArray(enterpriseDifferenceComparison.enterpriseId, db.select({ id: scope.id }).from(scope)))))
  // Drizzle has no window-function builder. The typed CTE keeps the rank expression local.
  const ranked = db.$with('ranked').as(db.select({
    enterpriseId: coordinates.enterpriseId, status: coordinates.status, reasonCode: coordinates.reasonCode,
    current: coordinates.current,
    rank: sql`row_number() OVER (PARTITION BY ${coordinates.enterpriseId} ORDER BY
      ${rank(coordinates.status, DIFFERENCE_STATUS_ORDER)} DESC, ${rank(coordinates.titleCode, TITLE_ORDER)},
      ${bytewise(coordinates.direction)})`.as('coordinate_rank'),
  }).from(coordinates))
  const explained = db.$with('explained').as(db.select({
    enterpriseId: ranked.enterpriseId,
    count: count().as('explanation_count'),
    current: boolOr(ranked.current).as('explanation_current'),
    status: sql<string | null>`max(${ranked.status}) FILTER (WHERE ${ranked.rank} = 1)`.as('explanation_status'),
    reason: sql<string | null>`max(${ranked.reasonCode}) FILTER (WHERE ${ranked.rank} = 1)`.as('explanation_reason'),
  }).from(ranked).groupBy(ranked.enterpriseId))

  const defaultDifference = sql<number>`case when ${isNull(enterprise.usccNorm)} then
    ${coalesce(history.unkeyedDifferenceCount, 0)} else ${coalesce(history.differenceCount, 0)} end`
  const differenceCount = coalesce<number>(explained.count, defaultDifference)
  const differenceStatus = coalesce<string | null>(explained.status, sql`case when ${gt(defaultDifference, 0)} then 'not_queried' end`)
  const statuses = (filter.diffStatus ?? []).filter(status => status !== 'none' && !status.includes('\0'))
  const rows = await db.with(scope, facts, history, explanations, derived, legacy, refreshed, coordinates, ranked, explained).select({
    id: enterprise.id, name: enterprise.name, year: history.firstYear,
    rank: coalesce<number>(history.titleRank, TITLE_ORDER.length).mapWith(Number),
    titles: coalesce<string[]>(history.titles, sql.param([])),
    recognitionPairs: coalesce<number>(history.recognitionPairs, 0).mapWith(Number),
    recordCount: coalesce<number>(history.recordCount, 0).mapWith(Number),
    official: coalesce<boolean>(history.official, false),
    differenceCount: differenceCount.mapWith(Number),
    differenceStatus,
    differenceReason: explained.reason,
    anyCurrent: coalesce<boolean>(explained.current, gt(defaultDifference, 0)),
  }).from(scope).innerJoin(enterprise, eq(enterprise.id, scope.id))
    .leftJoin(history, eq(history.enterpriseId, enterprise.id)).leftJoin(explained, eq(explained.enterpriseId, enterprise.id))
    .where(and(
      filter.title?.length ? history.titleMatch : undefined,
      filter.firstYear?.length || filter.firstStatus?.length ? gt(history.recognitionPairs, 0) : undefined,
      filter.source?.length || filter.year?.length || filter.eventType?.length ? history.recordMatch : undefined,
      filter.diffStatus?.length ? or(
        filter.diffStatus.includes('none') ? eq(differenceCount, 0) : undefined,
        inArray(differenceStatus, statuses), inArray(explained.reason, statuses),
        exists(db.select({ id: coordinates.enterpriseId }).from(coordinates).where(and(
          eq(coordinates.enterpriseId, enterprise.id), inArray(coordinates.status, statuses),
        ))),
      ) : undefined,
    ))
  return rows.map(({ differenceCount, differenceStatus, differenceReason, anyCurrent, ...candidate }) => ({
    ...candidate,
    difference: { count: differenceCount, status: differenceStatus, reasonCode: differenceReason, anyCurrent },
  }))
}

export async function listPostgresRosterEnterprises(db: NodePgDatabase, filter: RosterEnterpriseFilter): Promise<RosterEnterprisesResult> {
  const paging = rosterPageOf(filter)
  return { ...await readPostgresRosterRows(db, filter, paging), ...paging }
}

export function allPostgresRosterEnterprises(db: NodePgDatabase, filter: Omit<RosterEnterpriseFilter, 'page' | 'pageSize'>) {
  return readPostgresRosterRows(db, filter)
}

function readPostgresRosterRows(db: NodePgDatabase, filter: RosterEnterpriseFilter, paging?: { page: number; pageSize: number }) {
  return db.transaction(async tx => {
    const counts: RosterCounts = { total: 0, titlePairs: 0, recognitionPairs: 0, differences: 0,
      titles: Object.fromEntries(TITLE_ORDER.map(title => [title, 0])) }
    const candidates = await readCandidates(tx, filter)
    const former = candidates.some(candidate => candidate.recordCount && !candidate.official) ? await formerPlatformMembers(tx) : new Set<number>()
    const selected: EnterpriseSelection[] = []
    for (const candidate of candidates) {
      const state = candidate.recordCount && !candidate.official && former.has(candidate.id) ? 'removed_platform_only' : 'current'
      if (filter.rosterState && state !== filter.rosterState) continue
      counts.total++
      counts.recognitionPairs += candidate.recognitionPairs
      counts.differences += candidate.difference.count
      for (const title of candidate.titles) {
        counts.titlePairs++
        counts.titles[title] = (counts.titles[title] ?? 0) + 1
      }
      selected.push({ ...candidate, state })
    }
    selected.sort((a,b) => compareEnterpriseSelection(filter.sort, a, b))
    const current = paging ? selected.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize) : selected
    if (!current.length) return { rows: [], counts }
    const ids = current.map(row => row.id)
    const enterpriseRows = await tx.select().from(enterprise).where(anyId(enterprise.id, ids)).orderBy(enterprise.id)
    const enterprises = enterpriseRows.map(row => ({ ...row, qualityFlags: parseQualityFlags(row.qualityFlags) }))
    const recordRows = await tx.select().from(record).where(anyId(record.enterpriseId, ids)).orderBy(record.id)
    const records = recordRows.map(row => ({ ...row, qualityFlags: parseQualityFlags(row.qualityFlags) }))
    const eventRows = await tx.select().from(recordEvent)
      .where(anyId(recordEvent.recordId, records.map(row => row.id))).orderBy(recordEvent.id)
    const events = eventRows.map(row => ({ ...row, formalValidity: row.formalValidity === null ? null : JSON.parse(row.formalValidity) as FormalValidity }))
    const rawEvidence = await tx.select().from(recordEvidence)
      .where(anyId(recordEvidence.recordEventId, events.map(row => row.id))).orderBy(recordEvidence.id)
    const evidence = rawEvidence.map(row => isPageCapable(row.sourceFile) ? row : { ...row, page: null })
    const aliases = await tx.select().from(enterpriseAlias)
      .where(and(anyId(enterpriseAlias.enterpriseId, ids), eq(enterpriseAlias.verificationStatus, 'confirmed'))).orderBy(enterpriseAlias.id)
    const rows = projectRosterEnterprisePage({ enterprises, evidence, aliases, recordsByEnterprise: Map.groupBy(records, row => row.enterpriseId),
      eventsByRecord: Map.groupBy(events, row => row.recordId) }, current, new Set())
    return { rows, counts }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
