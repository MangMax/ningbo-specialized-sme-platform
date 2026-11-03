import { sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { normalizeDeclareKind } from '../../lib/platform/identity'
import {
  BUSINESS_PROCESS_OBSERVATION_LIMIT,
  BUSINESS_PROCESS_VERSION_LIMIT,
  businessProcessFilterSchema,
  type BusinessProcessDetail,
  type BusinessProcessFilter,
  type BusinessProcessIsolatedRow,
  type BusinessProcessListResult,
  type BusinessProcessObservation,
  type BusinessProcessRecordRow,
  type BusinessProcessVersion,
  type BusinessProcessVersionFields,
} from '../../lib/platform/business-processes'

type Db = BetterSQLite3Database<typeof schema>
const fail = (statusCode: number, code: string, message: string): never => {
  throw Object.assign(new Error(message), { statusCode, code })
}

function normalizedFilter(input: unknown): BusinessProcessFilter {
  const parsed = businessProcessFilterSchema.safeParse(input)
  if (!parsed.success) throw Object.assign(new Error('Invalid business process query parameters'), { statusCode: 400, code: 'invalid_business_process_filter' })
  return parsed.data
}

function enterpriseExists(recordColumn: SQL, filter: BusinessProcessFilter): SQL | null {
  if (filter.enterpriseId == null && !filter.q) return null
  const clauses: SQL[] = []
  if (filter.enterpriseId != null) clauses.push(sql`r.enterprise_id = ${filter.enterpriseId}`)
  if (filter.q) {
    const name = `%${normalizeName(filter.q)}%`
    const uscc = `%${normalizeUscc(filter.q)}%`
    clauses.push(sql`(e.name_norm LIKE ${name} OR e.uscc_norm LIKE ${uscc})`)
  }
  return sql`exists (
    select 1 from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    left join enterprise e on e.id = r.enterprise_id
    where o.record_id = ${recordColumn} and ${sql.join(clauses, sql` and `)}
  )`
}

/** Title scope is a query fact: match the explicit rdjb on the query or its scope index. */
function titleScopeExists(recordColumn: SQL, rdjb: string): SQL {
  return sql`exists (
    select 1 from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    join platform_query q on q.id = r.query_id
    where o.record_id = ${recordColumn} and (
      instr(',' || q.rdjb || ',', ',' || ${rdjb} || ',') > 0
      or exists (select 1 from platform_query_title_scope s where s.query_id = q.id and s.rdjb = ${rdjb})
    )
  )`
}

function isolatedTitleScope(filter: BusinessProcessFilter): SQL | null {
  if (!filter.rdjb) return null
  return sql`(instr(',' || q.rdjb || ',', ',' || ${filter.rdjb} || ',') > 0
    or exists (select 1 from platform_query_title_scope s where s.query_id = q.id and s.rdjb = ${filter.rdjb}))`
}

function recordConditions(filter: BusinessProcessFilter): SQL[] {
  const conditions: SQL[] = [sql`b.interface = 'business_list'`]
  if (filter.platformKey) conditions.push(sql`b.platform_key = ${filter.platformKey}`)
  const declareKind = filter.declareKind ? normalizeDeclareKind(filter.declareKind) : null
  if (declareKind) conditions.push(sql`p.declare_kind = ${declareKind}`)
  if (filter.year != null) conditions.push(sql`p.business_year = ${filter.year}`)
  if (filter.status) conditions.push(sql`p.status = ${filter.status}`)
  if (filter.batch) conditions.push(sql`p.batch = ${filter.batch}`)
  if (filter.rdjb) conditions.push(titleScopeExists(sql`b.id`, filter.rdjb))
  const enterprise = enterpriseExists(sql`b.id`, filter)
  if (enterprise) conditions.push(enterprise)
  return conditions
}

function isolatedConditions(filter: BusinessProcessFilter): SQL[] {
  const conditions: SQL[] = [
    sql`q.interface = 'business_list'`,
    sql`(o.identity_state <> 'resolved' or o.content_state <> 'verified' or o.version_id is null)`,
  ]
  if (filter.enterpriseId != null) conditions.push(sql`r.enterprise_id = ${filter.enterpriseId}`)
  if (filter.q) {
    const name = `%${normalizeName(filter.q)}%`
    const uscc = `%${normalizeUscc(filter.q)}%`
    conditions.push(sql`(e.name_norm LIKE ${name} or e.uscc_norm LIKE ${uscc})`)
  }
  if (filter.platformKey) conditions.push(sql`r.relation_key = ${filter.platformKey}`)
  const declareKind = filter.declareKind ? normalizeDeclareKind(filter.declareKind) : null
  if (declareKind) conditions.push(sql`r.declare_kind = ${declareKind}`)
  if (filter.year != null) conditions.push(sql`r.year = ${filter.year}`)
  if (filter.status) conditions.push(sql`r.status = ${filter.status}`)
  if (filter.batch) conditions.push(sql`r.batch = ${filter.batch}`)
  const title = isolatedTitleScope(filter)
  if (title) conditions.push(title)
  return conditions
}

function pageOf(filter: BusinessProcessFilter) {
  return { page: filter.page, pageSize: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }
}

/** Explicit query title scopes keyed by query id. Never a per-row title fact. */
function titleScopesByQuery(db: Db, queryIds: number[]): Map<number, string[]> {
  const scopes = new Map<number, Set<string>>()
  if (!queryIds.length) return new Map<number, string[]>()
  const ids = sql.join(queryIds.map(id => sql`${id}`), sql`, `)
  const rows = db.all<{ queryId: number; rdjb: string; scoped: string | null }>(sql`
    select q.id as queryId, q.rdjb as rdjb, s.rdjb as scoped
    from platform_query q left join platform_query_title_scope s on s.query_id = q.id
    where q.id in (${ids})
  `)
  const order = ['1', '2', '3']
  for (const row of rows) {
    const set = scopes.get(row.queryId) ?? new Set<string>()
    for (const value of row.rdjb.split(',').map(value => value.trim()).filter(Boolean)) set.add(value)
    if (row.scoped) set.add(row.scoped)
    scopes.set(row.queryId, set)
  }
  return new Map([...scopes.entries()].map(([queryId, set]) => [
    queryId,
    [...set].sort((a, b) => {
      const ai = order.indexOf(a), bi = order.indexOf(b)
      return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi) || a.localeCompare(b)
    }),
  ]))
}

function enterpriseAssignments(db: Db, recordIds: number[]) {
  if (!recordIds.length) return new Map<number, { ids: number[]; names: string[] }>()
  const ids = sql.join(recordIds.map(id => sql`${id}`), sql`, `)
  const rows = db.all<{ recordId: number; enterpriseId: number | null; name: string | null }>(sql`
    select distinct o.record_id as recordId, r.enterprise_id as enterpriseId, e.name as name
    from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    left join enterprise e on e.id = r.enterprise_id
    where o.record_id in (${ids})
    order by o.record_id, r.enterprise_id
  `)
  const grouped = new Map<number, { ids: number[]; names: string[] }>()
  for (const row of rows) {
    const entry = grouped.get(row.recordId) ?? { ids: [], names: [] }
    if (row.enterpriseId != null && !entry.ids.includes(row.enterpriseId)) {
      entry.ids.push(row.enterpriseId)
      if (row.name) entry.names.push(row.name)
    }
    grouped.set(row.recordId, entry)
  }
  return grouped
}

function recordsTitleScopes(db: Db, recordIds: number[], scopesByQuery: Map<number, string[]>): Map<number, string[]> {
  const grouped = new Map<number, Set<string>>()
  if (!recordIds.length) return new Map<number, string[]>()
  const ids = sql.join(recordIds.map(id => sql`${id}`), sql`, `)
  const rows = db.all<{ recordId: number; queryId: number }>(sql`
    select distinct o.record_id as recordId, r.query_id as queryId
    from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    where o.record_id in (${ids})
  `)
  for (const row of rows) {
    const set = grouped.get(row.recordId) ?? new Set<string>()
    for (const scope of scopesByQuery.get(row.queryId) ?? []) set.add(scope)
    grouped.set(row.recordId, set)
  }
  const order = ['1', '2', '3']
  return new Map([...grouped.entries()].map(([recordId, set]): [number, string[]] => [
    recordId,
    [...set].sort((a, b) => (order.indexOf(a) < 0 ? order.length : order.indexOf(a)) - (order.indexOf(b) < 0 ? order.length : order.indexOf(b)) || a.localeCompare(b)),
  ]))
}

function listRecordRows(db: Db, filter: BusinessProcessFilter, total: number): BusinessProcessListResult {
  const { page, pageSize, offset } = pageOf(filter)
  const where = sql.join(recordConditions(filter), sql` and `)
  const rows = db.all<{
    recordId: number; platformKey: string; versionId: number; declareKind: string | null; businessYear: number | null;
    appliedAt: string | null; status: string | null; batch: string | null; awardBatchLabel: string | null; province: string | null;
    nameRaw: string | null; usccRaw: string | null; ruleVersion: string | null;
    matchedVersionCount: number; versionCount: number; observationCount: number; latestObservationAt: string | null
  }>(sql`
    with matched as (
      select v.id as version_id, v.record_id, p.declare_kind, p.business_year, p.applied_at, p.status, p.batch,
        p.award_batch_label, p.province, p.name_raw, p.uscc_raw, p.rule_version, b.platform_key,
        count(*) over (partition by v.record_id) as matched_version_count,
        row_number() over (partition by v.record_id order by (p.applied_at is null), p.applied_at desc, v.id desc) as rn
      from platform_business_record_version v
      left join platform_business_projection p on p.version_id = v.id
      join platform_business_record b on b.id = v.record_id
      where ${where}
    )
    select m.record_id as recordId, m.platform_key as platformKey, m.version_id as versionId,
      m.declare_kind as declareKind, m.business_year as businessYear, m.applied_at as appliedAt, m.status,
      m.batch, m.award_batch_label as awardBatchLabel, m.province, m.name_raw as nameRaw, m.uscc_raw as usccRaw,
      m.rule_version as ruleVersion, m.matched_version_count as matchedVersionCount,
      (select count(*) from platform_business_record_version v where v.record_id = m.record_id) as versionCount,
      (select count(*) from platform_business_observation o where o.record_id = m.record_id) as observationCount,
      (select max(q.queried_at) from platform_business_observation o
        join platform_relation r on r.id = o.relation_id
        join platform_query q on q.id = r.query_id
        where o.record_id = m.record_id) as latestObservationAt
    from matched m where m.rn = 1
    order by latestObservationAt is null, latestObservationAt desc, m.record_id desc
    limit ${pageSize} offset ${offset}
  `)
  const assignments = enterpriseAssignments(db, rows.map(row => row.recordId))
  const recordIds = rows.map(row => row.recordId)
  const queryRows = recordIds.length ? db.all<{ recordId: number; queryId: number }>(sql`
    select distinct o.record_id as recordId, r.query_id as queryId
    from platform_business_observation o join platform_relation r on r.id = o.relation_id
    where o.record_id in (${sql.join(recordIds.map(id => sql`${id}`), sql`, `)})
  `) : []
  const scopesByQuery = titleScopesByQuery(db, [...new Set(queryRows.map(row => row.queryId))])
  const titleScopes = recordsTitleScopes(db, recordIds, scopesByQuery)
  const conflictRows = recordIds.length ? db.all<{ recordId: number; contentState: string }>(sql`
    select distinct o.record_id as recordId, o.content_state as contentState
    from platform_business_observation o
    where o.record_id in (${sql.join(recordIds.map(id => sql`${id}`), sql`, `)})
  `) : []
  const conflictByRecord = new Map<number, string[]>()
  for (const row of conflictRows) {
    const list = conflictByRecord.get(row.recordId) ?? []
    if (row.contentState === 'unverifiable' && !list.includes('unverifiable_observation')) list.push('unverifiable_observation')
    conflictByRecord.set(row.recordId, list)
  }
  const out: BusinessProcessRecordRow[] = rows.map(row => {
    const assignmentsForRecord = assignments.get(row.recordId) ?? { ids: [], names: [] }
    const conflicts = [...(conflictByRecord.get(row.recordId) ?? [])]
    if (assignmentsForRecord.ids.length > 1) conflicts.push('enterprise_assignment_conflict')
    return {
      kind: 'record',
      record: { id: row.recordId, platformKey: row.platformKey, interface: 'business_list' },
      matchedVersion: {
        versionId: row.versionId, declareKind: row.declareKind, businessYear: row.businessYear,
        appliedAt: row.appliedAt, status: row.status, batch: row.batch, awardBatchLabel: row.awardBatchLabel,
        province: row.province, nameRaw: row.nameRaw, usccRaw: row.usccRaw, ruleVersion: row.ruleVersion,
      },
      matchedVersionCount: row.matchedVersionCount,
      versionCount: row.versionCount,
      observationCount: row.observationCount,
      latestObservationAt: row.latestObservationAt,
      enterpriseIds: assignmentsForRecord.ids,
      enterpriseNames: assignmentsForRecord.names,
      titleScopes: titleScopes.get(row.recordId) ?? [],
      conflicts,
    }
  })
  return { view: 'records', rows: out, total, page, pageSize }
}

function listIsolatedRows(db: Db, filter: BusinessProcessFilter, total: number): BusinessProcessListResult {
  const { page, pageSize, offset } = pageOf(filter)
  const where = sql.join(isolatedConditions(filter), sql` and `)
  const rows = db.all<Omit<BusinessProcessIsolatedRow, 'kind' | 'titleScopes'> & { enterpriseName: string | null }>(sql`
    select o.relation_id as relationId, r.query_id as queryId, q.queried_at as queriedAt,
      q.query_key as queryKey, q.status as queryStatus, r.sequence_no as sequenceNo,
      o.identity_state as identityState, o.content_state as contentState,
      r.name_raw as nameRaw, r.uscc_raw as usccRaw, r.declare_kind as declareKind, r.year as businessYear,
      r.applied_at as appliedAt, r.status, r.batch, r.award_batch_label as awardBatchLabel, r.province,
      r.enterprise_id as enterpriseId, e.name as enterpriseName
    from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    join platform_query q on q.id = r.query_id
    left join enterprise e on e.id = r.enterprise_id
    where ${where}
    order by q.queried_at desc, o.relation_id desc
    limit ${pageSize} offset ${offset}
  `)
  const scopesByQuery = titleScopesByQuery(db, [...new Set(rows.map(row => row.queryId))])
  return {
    view: 'isolated',
    rows: rows.map(row => ({ ...row, kind: 'observation' as const, titleScopes: scopesByQuery.get(row.queryId) ?? [] })),
    total,
    page,
    pageSize,
  }
}

export function listPlatformBusinessProcesses(input: unknown, db: Db): BusinessProcessListResult {
  const filter = normalizedFilter(input)
  if (filter.view === 'isolated') {
    const where = sql.join(isolatedConditions(filter), sql` and `)
    const total = db.get<{ total: number }>(sql`
      select count(*) as total from platform_business_observation o
      join platform_relation r on r.id = o.relation_id
      join platform_query q on q.id = r.query_id
      left join enterprise e on e.id = r.enterprise_id
      where ${where}
    `)!.total
    return listIsolatedRows(db, filter, total)
  }
  const where = sql.join(recordConditions(filter), sql` and `)
  const total = db.get<{ total: number }>(sql`
    select count(distinct b.id) as total
    from platform_business_record_version v
    left join platform_business_projection p on p.version_id = v.id
    join platform_business_record b on b.id = v.record_id
    where ${where}
  `)!.total
  return listRecordRows(db, filter, total)
}

function versionFields(row: {
  versionId: number; declareKind: string | null; businessYear: number | null; appliedAt: string | null; status: string | null;
  batch: string | null; awardBatchLabel: string | null; province: string | null; nameRaw: string | null; usccRaw: string | null;
  ruleVersion: string | null
}): BusinessProcessVersionFields {
  return {
    versionId: row.versionId, declareKind: row.declareKind, businessYear: row.businessYear, appliedAt: row.appliedAt,
    status: row.status, batch: row.batch, awardBatchLabel: row.awardBatchLabel, province: row.province,
    nameRaw: row.nameRaw, usccRaw: row.usccRaw, ruleVersion: row.ruleVersion,
  }
}

export function getPlatformBusinessProcess(db: Db, recordId: number): BusinessProcessDetail {
  if (!Number.isSafeInteger(recordId) || recordId < 1) fail(400, 'invalid_business_process_id', 'recordId must be a positive safe integer')
  const record = db.get<{ id: number; platformKey: string; interface: 'business_list'; identityRuleVersion: string; createdAt: string }>(sql`
    select id, platform_key as platformKey, interface, identity_rule_version as identityRuleVersion, created_at as createdAt
    from platform_business_record where id = ${recordId} and interface = 'business_list'
  `)
  if (!record) fail(404, 'business_process_not_found', 'Business process record not found')

  const versionTotal = db.get<{ total: number }>(sql`select count(*) as total from platform_business_record_version where record_id = ${recordId}`)!.total
  const versions = db.all<Omit<BusinessProcessVersion, 'titleScopes'>>(sql`
    select v.id as versionId, v.hash_algorithm as hashAlgorithm, v.content_hash as contentHash, v.created_at as createdAt,
      p.declare_kind as declareKind, p.business_year as businessYear, p.applied_at as appliedAt, p.status,
      p.batch, p.award_batch_label as awardBatchLabel, p.province, p.name_raw as nameRaw, p.uscc_raw as usccRaw,
      p.rule_version as ruleVersion,
      (select count(*) from platform_business_observation o where o.version_id = v.id) as observationCount,
      (select min(q.queried_at) from platform_business_observation o
        join platform_relation r on r.id = o.relation_id join platform_query q on q.id = r.query_id
        where o.version_id = v.id) as firstObservedAt,
      (select max(q.queried_at) from platform_business_observation o
        join platform_relation r on r.id = o.relation_id join platform_query q on q.id = r.query_id
        where o.version_id = v.id) as lastObservedAt
    from platform_business_record_version v
    left join platform_business_projection p on p.version_id = v.id
    where v.record_id = ${recordId}
    order by v.id desc
    limit ${BUSINESS_PROCESS_VERSION_LIMIT}
  `)

  const observationTotal = db.get<{ total: number }>(sql`select count(*) as total from platform_business_observation where record_id = ${recordId}`)!.total
  const observations = db.all<Omit<BusinessProcessObservation, 'titleScopes' | 'version'> & BusinessProcessVersionFields>(sql`
    select o.relation_id as relationId, r.query_id as queryId, q.queried_at as queriedAt, q.query_key as queryKey,
      q.status as queryStatus, r.sequence_no as sequenceNo, r.enterprise_id as enterpriseId, e.name as enterpriseName,
      o.identity_state as identityState, o.content_state as contentState, o.key_source as keySource,
      o.projection_rule_version as projectionRuleVersion, o.version_id as versionId,
      p.declare_kind as declareKind, p.business_year as businessYear, p.applied_at as appliedAt, p.status,
      p.batch, p.award_batch_label as awardBatchLabel, p.province, p.name_raw as nameRaw, p.uscc_raw as usccRaw,
      p.rule_version as ruleVersion
    from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    join platform_query q on q.id = r.query_id
    left join enterprise e on e.id = r.enterprise_id
    left join platform_business_projection p on p.version_id = o.version_id
    where o.record_id = ${recordId}
    order by q.queried_at desc, o.relation_id desc
    limit ${BUSINESS_PROCESS_OBSERVATION_LIMIT}
  `)
  const versionQueryRows = db.all<{ versionId: number; queryId: number }>(sql`
    select distinct o.version_id as versionId, r.query_id as queryId
    from platform_business_observation o join platform_relation r on r.id = o.relation_id
    where o.record_id = ${recordId} and o.version_id is not null
  `)
  const queryIds = [...new Set([...observations.map(observation => observation.queryId), ...versionQueryRows.map(row => row.queryId)])]
  const scopesByQuery = titleScopesByQuery(db, queryIds)
  const versionScopes = new Map<number, Set<string>>()
  for (const row of versionQueryRows) {
    const set = versionScopes.get(row.versionId) ?? new Set<string>()
    for (const scope of scopesByQuery.get(row.queryId) ?? []) set.add(scope)
    versionScopes.set(row.versionId, set)
  }
  return {
    record,
    versions: versions.map(version => ({ ...version, titleScopes: [...(versionScopes.get(version.versionId) ?? [])] })),
    observations: observations.map(({ declareKind, businessYear, appliedAt, status, batch, awardBatchLabel, province, nameRaw, usccRaw, ruleVersion, ...observation }) => ({
      ...observation,
      titleScopes: scopesByQuery.get(observation.queryId) ?? [],
      version: observation.versionId == null ? null : versionFields({ versionId: observation.versionId, declareKind, businessYear, appliedAt, status, batch, awardBatchLabel, province, nameRaw, usccRaw, ruleVersion }),
    })),
    counts: {
      versions: versionTotal,
      observations: observationTotal,
      versionsTruncated: versionTotal > versions.length,
      observationsTruncated: observationTotal > observations.length,
    },
  }
}
