import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { readPostgresRosterRowsById } from './postgres-rows'
import * as schema from '../../../../db/schema'
import { normalizeName, normalizeUscc } from '../domain'
import { DIFFERENCE_STATUS_ORDER, TITLE_ORDER } from '../labels'
import { compareEnterpriseSelection, type EnterpriseSelection } from './enterprise-list-selection'
import { isPageCapable } from './evidence-page'
import { projectRosterEnterprisePage, rosterPageOf, type RosterCounts, type RosterEnterpriseFilter, type RosterEnterprisesResult } from './enterprise-roster'

type Reader = Pick<NodePgDatabase, 'execute'>
const idsOf = (ids: readonly number[]) => sql`${sql.param(ids)}::bigint[]`
const textList = (list: readonly string[]) => sql`${sql.param(list.filter(value => !value.includes('\0')))}::text[]`
const textSelected = (column: SQL, list?: string[]) => list?.length ? sql`${column} = ANY(${textList(list)})` : sql`TRUE`
const yearSelected = (column: SQL, values?: number[]) => values?.length
  ? sql`${column} = ANY(${idsOf(values.filter(Number.isSafeInteger))})` : sql`TRUE`
const rank = (column: SQL, values: string[]) => sql`CASE ${sql.join(values.map((value, index) => sql`WHEN ${column} = ${value} THEN ${index}::integer`), sql` `)} ELSE ${values.length}::integer END`
const currentIdentity = sql`NOT EXISTS (SELECT 1 FROM enterprise_merge merged WHERE merged.from_enterprise_id = e.id)`

async function searchEnterpriseIds(db: Reader, raw: string | undefined) {
  if (!raw?.trim()) return undefined
  const needle = normalizeName(raw), uscc = raw.trim().toUpperCase()
  const { rows } = await db.execute<{ id: string; name: string; uscc: string | null; aliases: string[] }>(sql`
    SELECT e.id, e.name, e.uscc_norm AS uscc, ARRAY(SELECT name FROM enterprise_alias a
      WHERE a.enterprise_id = e.id AND a.verification_status = 'confirmed') AS aliases
    FROM enterprise e WHERE ${currentIdentity}`)
  return rows.filter(row => normalizeName(row.name).includes(needle) ||
    row.aliases.some(alias => normalizeName(alias).includes(needle)) || (row.uscc ?? '').toUpperCase().includes(uscc))
    .map(row => Number(row.id))
}

export async function formerPlatformMembers(db: Reader) {
  const { rows: owners } = await db.execute<{ id: string; uscc: string | null; name: string }>(sql`
    SELECT e.id, e.uscc_norm AS uscc, e.name_norm AS name FROM enterprise e WHERE ${currentIdentity} ORDER BY e.id`)
  const uscc = new Map<string, number>(), names = new Map<string, number>()
  for (const owner of owners) {
    const code = normalizeUscc(owner.uscc)
    if (code) uscc.set(code, Number(owner.id))
    names.set(owner.name, Number(owner.id))
  }
  const { rows } = await db.execute<{ uscc: string | null; name: string | null; latest: boolean }>(sql`
    WITH latest AS (SELECT DISTINCT ON (title_code) id FROM platform_export_batch ORDER BY title_code, year DESC, id DESC)
    SELECT x.uscc_raw AS uscc, x.name_raw AS name, latest.id IS NOT NULL AS latest
    FROM platform_export_row x LEFT JOIN latest ON latest.id = x.batch_id`)
  const historical = new Set<number>(), latest = new Set<number>()
  for (const row of rows) {
    const id = uscc.get(normalizeUscc(row.uscc)) ?? (row.name ? names.get(normalizeName(row.name)) : undefined)
    if (id === undefined) continue
    if (row.latest) latest.add(id)
    else historical.add(id)
  }
  return historical.difference(latest)
}

type Candidate = {
  id: number; name: string; year: number | null; rank: number; titles: string[]; recognitionPairs: number;
  recordCount: number; official: boolean; difference: EnterpriseSelection['difference']
}

async function readCandidates(db: Reader, filter: RosterEnterpriseFilter) {
  const searchIds = await searchEnterpriseIds(db, filter.q)
  const selectedTitles = textSelected(sql`f.title_code`, filter.title)
  const recordMatch = sql`${textSelected(sql`r.source`, filter.source)}
    AND ${filter.eventType?.length || filter.year?.length ? sql`EXISTS (
      SELECT 1 FROM record_event v WHERE v.record_id = r.id AND
      ${textSelected(sql`v.event_type`, filter.eventType)} AND ${yearSelected(sql`v.year`, filter.year)})` : sql`TRUE`}`
  const defaultDifference = sql`CASE WHEN e.uscc_norm IS NULL THEN coalesce(h.unkeyed_difference_count,0) ELSE coalesce(h.difference_count,0) END`
  const differenceCount = sql`coalesce(d.count, ${defaultDifference})`
  const differenceStatus = sql`coalesce(d.status, CASE WHEN ${defaultDifference} > 0 THEN 'not_queried' END)`
  const selectedStatuses = textList((filter.diffStatus ?? []).filter(status => status !== 'none'))
  const district = filter.district
  const { rows } = await db.execute<{ coordinate: Candidate }>(sql`
    WITH scope AS MATERIALIZED (
      SELECT e.id FROM enterprise e WHERE ${currentIdentity}
        AND (EXISTS (SELECT 1 FROM roster_legacy_member l WHERE l.enterprise_id = e.id)
          OR EXISTS (SELECT 1 FROM roster_announcement_member m JOIN roster_announcement_intake i ON i.id = m.intake_id
            WHERE m.enterprise_id = e.id AND i.removed_reason IS NULL))
        ${searchIds ? sql`AND e.id = ANY(${idsOf(searchIds)})` : sql.empty()}
        ${district ? (district.includes('\0') || !district.isWellFormed() ? sql`AND FALSE` : sql`AND
          coalesce(nullif(e.district,''),(SELECT district FROM record r WHERE r.enterprise_id = e.id
            AND r.district IS NOT NULL AND r.district <> '' ORDER BY r.id LIMIT 1)) = ${district}`) : sql.empty()}
    ), fact_base AS MATERIALIZED (
      SELECT r.enterprise_id, r.title_code,
        min(coalesce(v.decided_year,v.year)) FILTER (WHERE v.event_type = 'award') AS first_year,
        count(*) FILTER (WHERE v.event_type = 'award') AS awards,
        bool_or(v.event_type = 'award' AND coalesce(v.decided_year,v.year) IS NULL) AS undated,
        bool_or(r.source = 'jxj') AS official, bool_or(r.source <> 'jxj') AS platform,
        bool_or(${recordMatch}) AS record_match, count(*) AS record_count
      FROM record r JOIN scope s ON s.id = r.enterprise_id LEFT JOIN record_event v ON v.record_id = r.id
      GROUP BY r.enterprise_id,r.title_code
    ), facts AS (
      SELECT f.*, CASE WHEN f.first_year IS NULL OR f.undated OR NOT EXISTS (
        SELECT 1 FROM record_evidence ev WHERE ev.record_event_id = (
          SELECT v.id FROM record r JOIN record_event v ON v.record_id = r.id
          WHERE r.enterprise_id = f.enterprise_id AND r.title_code = f.title_code AND v.event_type = 'award'
            AND coalesce(v.decided_year,v.year) = f.first_year ORDER BY v.id LIMIT 1)) THEN 'pending' ELSE 'confirmed' END AS status
      FROM fact_base f
    ), history AS (
      SELECT f.enterprise_id, array_agg(f.title_code) AS titles, min(f.first_year) AS first_year,
        min(${rank(sql`f.title_code`, TITLE_ORDER)}) AS title_rank, bool_or(f.official) AS official,
        bool_or(f.record_match) AS record_match, sum(f.record_count) AS record_count,
        count(*) FILTER (WHERE f.title_code = ANY(${textList(TITLE_ORDER)}) AND f.official <> f.platform) AS difference_count,
        coalesce(sum(f.official::int + f.platform::int) FILTER (WHERE f.title_code = ANY(${textList(TITLE_ORDER)})),0) AS unkeyed_difference_count,
        count(*) FILTER (WHERE f.awards > 0 AND ${selectedTitles} AND ${yearSelected(sql`f.first_year`, filter.firstYear)}
          AND ${textSelected(sql`f.status`, filter.firstStatus)}) AS recognition_pairs,
        bool_or(${selectedTitles}) AS title_match
      FROM facts f GROUP BY f.enterprise_id
    ), explanation_versions AS (
      SELECT enterprise_id,title_code,direction,status,reason_code,recorded_at,id,
        row_number() OVER (PARTITION BY enterprise_id,title_code,direction ORDER BY recorded_at COLLATE "C" DESC,id) AS n
      FROM difference_reason WHERE enterprise_id IN (SELECT id FROM scope)
    ), explanations AS MATERIALIZED (SELECT * FROM explanation_versions WHERE n=1),
    derived AS MATERIALIZED (
      SELECT f.enterprise_id, f.title_code, direction
      FROM fact_base f JOIN enterprise e ON e.id = f.enterprise_id
      CROSS JOIN LATERAL (VALUES
        ('missing_in_miit',f.official AND (e.uscc_norm IS NULL OR NOT f.platform)),
        ('extra_in_miit',f.platform AND (e.uscc_norm IS NULL OR NOT f.official))) d(direction,active)
      WHERE f.title_code = ANY(${textList(TITLE_ORDER)}) AND d.active
        AND f.enterprise_id IN (SELECT enterprise_id FROM explanations)
    ), legacy_coordinates AS (
      SELECT d.*,coalesce(x.status,'not_queried') AS status,x.reason_code,TRUE AS current
      FROM derived d LEFT JOIN explanations x USING (enterprise_id,title_code,direction)
      UNION ALL SELECT x.enterprise_id,x.title_code,x.direction,x.status,x.reason_code,FALSE FROM explanations x
        WHERE NOT EXISTS (SELECT 1 FROM derived d WHERE d.enterprise_id=x.enterprise_id AND d.title_code=x.title_code AND d.direction=x.direction)
    ), refreshed_decisions AS (
      SELECT x.*,row_number() OVER (PARTITION BY x.enterprise_id,x.title_code ORDER BY x.recorded_at COLLATE "C" DESC,x.id DESC) AS latest
      FROM explanations x JOIN enterprise_difference_comparison c USING (enterprise_id,title_code) WHERE x.id > c.decision_cutoff_id
    ), coordinates AS MATERIALIZED (
      SELECT x.* FROM legacy_coordinates x
      WHERE NOT EXISTS (SELECT 1 FROM enterprise_difference_comparison c WHERE c.enterprise_id=x.enterprise_id AND c.title_code=x.title_code)
      UNION ALL
      SELECT c.enterprise_id,c.title_code,'missing_in_miit',coalesce(d.status,'needs_review'),d.reason_code,TRUE
      FROM enterprise_difference_comparison c
      LEFT JOIN refreshed_decisions d ON d.enterprise_id=c.enterprise_id AND d.title_code=c.title_code AND d.latest=1
      WHERE c.enterprise_id IN (SELECT id FROM scope)
    ), ranked AS (
      SELECT *,row_number() OVER (PARTITION BY enterprise_id ORDER BY ${rank(sql`status`, DIFFERENCE_STATUS_ORDER)} DESC,
        ${rank(sql`title_code`, TITLE_ORDER)},direction COLLATE "C") AS n FROM coordinates
    ), explained AS (
      SELECT enterprise_id,count(*) AS count,bool_or(current) AS current,
        max(status) FILTER (WHERE n=1) AS status,max(reason_code) FILTER (WHERE n=1) AS reason
      FROM ranked GROUP BY enterprise_id
    )
    SELECT json_build_object('id',e.id,'name',e.name,'year',h.first_year,
      'rank',coalesce(h.title_rank,${TITLE_ORDER.length}),'titles',coalesce(h.titles,ARRAY[]::text[]),
      'recognitionPairs',coalesce(h.recognition_pairs,0),'recordCount',coalesce(h.record_count,0),'official',coalesce(h.official,FALSE),
      'difference',json_build_object('count',${differenceCount},'status',${differenceStatus},
        'reasonCode',d.reason,'anyCurrent',coalesce(d.current,${defaultDifference} > 0))) AS coordinate
    FROM scope s JOIN enterprise e ON e.id=s.id
    LEFT JOIN history h ON h.enterprise_id=e.id LEFT JOIN explained d ON d.enterprise_id=e.id
    WHERE ${filter.title?.length ? sql`h.title_match` : sql`TRUE`}
      AND ${filter.firstYear?.length || filter.firstStatus?.length ? sql`h.recognition_pairs > 0` : sql`TRUE`}
      AND ${filter.source?.length || filter.year?.length || filter.eventType?.length ? sql`h.record_match` : sql`TRUE`}
      AND ${filter.diffStatus?.length ? sql`(
        (${filter.diffStatus.includes('none')} AND ${differenceCount}=0)
        OR ${differenceStatus} = ANY(${selectedStatuses}) OR d.reason = ANY(${selectedStatuses})
        OR EXISTS (SELECT 1 FROM coordinates c WHERE c.enterprise_id=e.id AND c.status = ANY(${selectedStatuses})))` : sql`TRUE`}`)
  return rows.map(row => row.coordinate)
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
    const ids = idsOf(current.map(row => row.id))
    const enterprises = await readPostgresRosterRowsById(tx, schema.enterprise, sql`FROM enterprise p WHERE p.id=ANY(${ids})`)
    const records = await readPostgresRosterRowsById(tx, schema.record, sql`FROM record p WHERE p.enterprise_id=ANY(${ids})`)
    const recordIds = idsOf(records.map(row => row.id))
    const events = await readPostgresRosterRowsById(tx, schema.recordEvent, sql`FROM record_event p WHERE p.record_id=ANY(${recordIds})`)
    const eventIds = idsOf(events.map(row => row.id))
    const rawEvidence = await readPostgresRosterRowsById(tx, schema.recordEvidence, sql`FROM record_evidence p WHERE p.record_event_id=ANY(${eventIds})`)
    const evidence = rawEvidence.map(row => isPageCapable(row.sourceFile) ? row : { ...row, page: null })
    const aliases = await readPostgresRosterRowsById(tx, schema.enterpriseAlias, sql`FROM enterprise_alias p WHERE p.enterprise_id=ANY(${ids}) AND p.verification_status='confirmed'`)
    const rows = projectRosterEnterprisePage({ enterprises, evidence, aliases, recordsByEnterprise: Map.groupBy(records, row => row.enterpriseId),
      eventsByRecord: Map.groupBy(events, row => row.recordId) }, current, new Set())
    return { rows, counts }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
