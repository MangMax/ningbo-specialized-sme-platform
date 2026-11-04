import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { legacyRowTitle, type PlatformObservationFact } from '../../lib/platform/observation-facts'
import { factBatches, legacyRelationColumns, readLegacyRelationRows } from './platform-legacy-relation-read'
import {
  businessEnterpriseExists, enterpriseAssignments, fail, orderedScopes, pageOf, titleScopesByQuery,
} from './platform-business-read'
import {
  RECOGNIZED_DIRECTORY_OBSERVATION_LIMIT,
  RECOGNIZED_DIRECTORY_VERSION_LIMIT,
  recognizedDirectoryFilterSchema,
  type RecognizedDirectoryDetail,
  type RecognizedDirectoryFilter,
  type RecognizedDirectoryIsolatedRow,
  type RecognizedDirectoryListResult,
  type RecognizedDirectoryObservation,
  type RecognizedDirectoryRecordRow,
  type RecognizedDirectoryVersion,
  type RecognizedDirectoryVersionFields,
} from '../../lib/platform/recognized-directory'

/** Stable conflict order for records and details. */
const CONFLICT_ORDER = ['title_conflict', 'unverifiable_observation', 'enterprise_assignment_conflict'] as const
const KNOWN_RDJBS = new Set(['1', '2', '3'])

function normalizedFilter(input: unknown): RecognizedDirectoryFilter {
  const parsed = recognizedDirectoryFilterSchema.safeParse(input)
  if (!parsed.success) throw Object.assign(new Error('Invalid recognized directory query parameters'), { statusCode: 400, code: 'invalid_recognized_directory_filter' })
  return parsed.data
}

/** A known row-level rdjb contradicting the observed explicit query scope is a structured
 * conflict. Unknown/absent row values or an empty scope stay unknown, never a conflict. */
function titleConflictOf(titleRaw: string | null, scopes: string[]): boolean {
  return titleRaw != null && KNOWN_RDJBS.has(titleRaw) && scopes.length > 0 && !scopes.includes(titleRaw)
}

/** Restrict matched content versions to those actually observed under the selected title scope. */
function versionTitleScopeExists(rdjb: string): SQL {
  return sql`exists (
    select 1 from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    join platform_query q on q.id = r.query_id
    where o.version_id = v.id and (
      instr(',' || q.rdjb || ',', ',' || ${rdjb} || ',') > 0
      or exists (select 1 from platform_query_title_scope s where s.query_id = q.id and s.rdjb = ${rdjb})
    )
  )`
}

function isolatedTitleScope(filter: RecognizedDirectoryFilter): SQL | null {
  if (!filter.rdjb) return null
  return sql`(instr(',' || q.rdjb || ',', ',' || ${filter.rdjb} || ',') > 0
    or exists (select 1 from platform_query_title_scope s where s.query_id = q.id and s.rdjb = ${filter.rdjb}))`
}

function recordConditions(filter: RecognizedDirectoryFilter): SQL[] {
  const conditions: SQL[] = [sql`b.interface = 'recognized_list'`]
  if (filter.platformKey) conditions.push(sql`b.platform_key = ${filter.platformKey}`)
  if (filter.rddqrq) conditions.push(sql`p.validity_date_raw = ${filter.rddqrq}`)
  if (filter.whpcyear != null) conditions.push(sql`p.maintenance_year = ${filter.whpcyear}`)
  if (filter.whpc) conditions.push(sql`p.maintenance_batch = ${filter.whpc}`)
  if (filter.szq) conditions.push(sql`p.district = ${filter.szq}`)
  // Every filter constrains the same content version that the row query selects.
  if (filter.rdjb) conditions.push(versionTitleScopeExists(filter.rdjb))
  const enterprise = businessEnterpriseExists(filter)
  if (enterprise) conditions.push(enterprise)
  return conditions
}

function isolatedConditions(filter: RecognizedDirectoryFilter): SQL[] {
  const conditions: SQL[] = [
    sql`q.interface = 'recognized_list'`,
    sql`(o.identity_state <> 'resolved' or o.content_state <> 'verified' or o.version_id is null)`,
  ]
  if (filter.enterpriseId != null) conditions.push(sql`r.enterprise_id = ${filter.enterpriseId}`)
  if (filter.q) {
    const name = `%${normalizeName(filter.q)}%`
    const uscc = `%${normalizeUscc(filter.q)}%`
    conditions.push(sql`(e.name_norm LIKE ${name} or e.uscc_norm LIKE ${uscc})`)
  }
  // Unprojected observations have no directory business id; match the original archived row key.
  if (filter.platformKey) conditions.push(sql`r.relation_key = ${filter.platformKey}`)
  const title = isolatedTitleScope(filter)
  if (title) conditions.push(title)
  return conditions
}

/** Typed value filters cannot match an observation that has no typed projection. */
function isolatedValueFilterUnmatchable(filter: RecognizedDirectoryFilter): boolean {
  return filter.rddqrq != null || filter.whpcyear != null || filter.whpc != null || filter.szq != null
}

function recordsTitleScopes(rows: { recordId: number; queryId: number }[], scopesByQuery: Map<number, string[]>): Map<number, string[]> {
  const grouped = new Map<number, Set<string>>()
  for (const row of rows) {
    const set = grouped.get(row.recordId) ?? new Set<string>()
    for (const scope of scopesByQuery.get(row.queryId) ?? []) set.add(scope)
    grouped.set(row.recordId, set)
  }
  return new Map([...grouped.entries()].map(([recordId, set]): [number, string[]] => [recordId, orderedScopes(set)]))
}

/** Record-level structured conflicts. Every read aggregates DISTINCT record ids, so a record
 * with many observations stays bounded; reads no raw JSON. */
function recordConflicts(db: Db, recordIds: number[]): Map<number, string[]> {
  const result = new Map<number, string[]>()
  if (!recordIds.length) return result
  const ids = sql.join(recordIds.map(id => sql`${id}`), sql`, `)
  const unverifiable = new Set(db.all<{ recordId: number }>(sql`
    select distinct o.record_id as recordId
    from platform_business_observation o
    where o.record_id in (${ids}) and o.content_state = 'unverifiable'
  `).map(row => row.recordId))
  // A known row-level rdjb contradicting the observed explicit query scope is a conflict.
  // The scope is the same query fact `titleScopesByQuery` returns: q.rdjb split on commas,
  // trimmed, plus explicit platform_query_title_scope rows.
  const scopeList = sql`replace(replace(replace(replace(q.rdjb, ' ', ''), char(9), ''), char(10), ''), char(13), '')`
  const titleConflict = new Set(db.all<{ recordId: number }>(sql`
    select distinct o.record_id as recordId
    from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    join platform_query q on q.id = r.query_id
    join platform_recognized_projection p on p.version_id = o.version_id
    where o.record_id in (${ids})
      and p.title_raw in ('1', '2', '3')
      and (
        replace(${scopeList}, ',', '') <> ''
        or exists (select 1 from platform_query_title_scope s where s.query_id = q.id and trim(s.rdjb) <> '')
      )
      and instr(',' || ${scopeList} || ',', ',' || p.title_raw || ',') = 0
      and not exists (
        select 1 from platform_query_title_scope s where s.query_id = q.id and s.rdjb = p.title_raw
      )
  `).map(row => row.recordId))
  const assignments = enterpriseAssignments(db, recordIds)
  for (const recordId of recordIds) {
    const set = new Set<string>()
    if (titleConflict.has(recordId)) set.add('title_conflict')
    if (unverifiable.has(recordId)) set.add('unverifiable_observation')
    if ((assignments.get(recordId)?.ids.length ?? 0) > 1) set.add('enterprise_assignment_conflict')
    result.set(recordId, CONFLICT_ORDER.filter(conflict => set.has(conflict)))
  }
  return result
}

function listRecordRows(db: Db, filter: RecognizedDirectoryFilter, total: number): RecognizedDirectoryListResult {
  const { page, pageSize, offset } = pageOf(filter)
  const where = sql.join(recordConditions(filter), sql` and `)
  const rows = db.all<{
    recordId: number; platformKey: string; versionId: number; validityDateRaw: string | null; maintenanceYear: number | null;
    maintenanceBatch: string | null; district: string | null; awardNote: string | null; titleRaw: string | null; nameRaw: string | null;
    usccRaw: string | null; ruleVersion: string | null; matchedVersionCount: number; versionCount: number; observationCount: number;
    latestObservationAt: string | null
  }>(sql`
    with matched as (
      select v.id as version_id, v.record_id, p.validity_date_raw, p.maintenance_year, p.maintenance_batch, p.district,
        p.award_note, p.title_raw, p.name_raw, p.uscc_raw, p.rule_version, b.platform_key,
        count(*) over (partition by v.record_id) as matched_version_count,
        row_number() over (partition by v.record_id order by v.id desc) as rn
      from platform_business_record_version v
      left join platform_recognized_projection p on p.version_id = v.id
      join platform_business_record b on b.id = v.record_id
      where ${where}
    )
    select m.record_id as recordId, m.platform_key as platformKey, m.version_id as versionId,
      m.validity_date_raw as validityDateRaw, m.maintenance_year as maintenanceYear, m.maintenance_batch as maintenanceBatch,
      m.district, m.award_note as awardNote, m.title_raw as titleRaw, m.name_raw as nameRaw, m.uscc_raw as usccRaw,
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
  const titleScopes = recordsTitleScopes(queryRows, scopesByQuery)
  const conflicts = recordConflicts(db, recordIds)
  const out: RecognizedDirectoryRecordRow[] = rows.map(row => {
    const assignment = assignments.get(row.recordId) ?? { ids: [], names: [] }
    return {
      kind: 'record',
      record: { id: row.recordId, platformKey: row.platformKey, interface: 'recognized_list' },
      matchedVersion: {
        versionId: row.versionId, validityDateRaw: row.validityDateRaw, maintenanceYear: row.maintenanceYear,
        maintenanceBatch: row.maintenanceBatch, district: row.district, awardNote: row.awardNote, titleRaw: row.titleRaw,
        nameRaw: row.nameRaw, usccRaw: row.usccRaw, ruleVersion: row.ruleVersion,
      },
      matchedVersionCount: row.matchedVersionCount,
      versionCount: row.versionCount,
      observationCount: row.observationCount,
      latestObservationAt: row.latestObservationAt,
      enterpriseIds: assignment.ids,
      enterpriseNames: assignment.names,
      titleScopes: titleScopes.get(row.recordId) ?? [],
      conflicts: conflicts.get(row.recordId) ?? [],
    }
  })
  return { view: 'records', rows: out, total, page, pageSize }
}

function listIsolatedRows(db: Db, filter: RecognizedDirectoryFilter, total: number): RecognizedDirectoryListResult {
  const { page, pageSize, offset } = pageOf(filter)
  const where = sql.join(isolatedConditions(filter), sql` and `)
  const rows = db.all<Omit<RecognizedDirectoryIsolatedRow, 'kind' | 'titleScopes'> & { enterpriseName: string | null }>(sql`
    select o.relation_id as relationId, r.query_id as queryId, q.queried_at as queriedAt,
      q.query_key as queryKey, q.status as queryStatus, r.sequence_no as sequenceNo,
      o.identity_state as identityState, o.content_state as contentState,
      r.name_raw as nameRaw, r.uscc_raw as usccRaw, r.enterprise_id as enterpriseId, e.name as enterpriseName
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

export function listPlatformRecognizedDirectory(input: unknown, db: Db): RecognizedDirectoryListResult {
  const filter = normalizedFilter(input)
  if (filter.view === 'isolated') {
    if (isolatedValueFilterUnmatchable(filter)) return { view: 'isolated', rows: [], total: 0, page: filter.page, pageSize: filter.pageSize }
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
    left join platform_recognized_projection p on p.version_id = v.id
    join platform_business_record b on b.id = v.record_id
    where ${where}
  `)!.total
  return listRecordRows(db, filter, total)
}

function versionFields(row: {
  versionId: number; validityDateRaw: string | null; maintenanceYear: number | null; maintenanceBatch: string | null;
  district: string | null; awardNote: string | null; titleRaw: string | null; nameRaw: string | null; usccRaw: string | null;
  ruleVersion: string | null
}): RecognizedDirectoryVersionFields {
  return {
    versionId: row.versionId, validityDateRaw: row.validityDateRaw, maintenanceYear: row.maintenanceYear,
    maintenanceBatch: row.maintenanceBatch, district: row.district, awardNote: row.awardNote, titleRaw: row.titleRaw,
    nameRaw: row.nameRaw, usccRaw: row.usccRaw, ruleVersion: row.ruleVersion,
  }
}

export function getPlatformRecognizedRecord(db: Db, recordId: number): RecognizedDirectoryDetail {
  if (!Number.isSafeInteger(recordId) || recordId < 1) fail(400, 'invalid_recognized_record_id', 'recordId must be a positive safe integer')
  const record = db.get<{ id: number; platformKey: string; interface: 'recognized_list'; identityRuleVersion: string; createdAt: string }>(sql`
    select id, platform_key as platformKey, interface, identity_rule_version as identityRuleVersion, created_at as createdAt
    from platform_business_record where id = ${recordId} and interface = 'recognized_list'
  `)
  if (!record) fail(404, 'recognized_record_not_found', 'Recognized directory record not found')

  const versionTotal = db.get<{ total: number }>(sql`select count(*) as total from platform_business_record_version where record_id = ${recordId}`)!.total
  const versions = db.all<Omit<RecognizedDirectoryVersion, 'titleScopes'>>(sql`
    select v.id as versionId, v.hash_algorithm as hashAlgorithm, v.content_hash as contentHash, v.created_at as createdAt,
      p.validity_date_raw as validityDateRaw, p.maintenance_year as maintenanceYear, p.maintenance_batch as maintenanceBatch,
      p.district, p.award_note as awardNote, p.title_raw as titleRaw, p.name_raw as nameRaw, p.uscc_raw as usccRaw,
      p.rule_version as ruleVersion,
      (select count(*) from platform_business_observation o where o.version_id = v.id) as observationCount,
      (select min(q.queried_at) from platform_business_observation o
        join platform_relation r on r.id = o.relation_id join platform_query q on q.id = r.query_id
        where o.version_id = v.id) as firstObservedAt,
      (select max(q.queried_at) from platform_business_observation o
        join platform_relation r on r.id = o.relation_id join platform_query q on q.id = r.query_id
        where o.version_id = v.id) as lastObservedAt
    from platform_business_record_version v
    left join platform_recognized_projection p on p.version_id = v.id
    where v.record_id = ${recordId}
    order by v.id desc
    limit ${RECOGNIZED_DIRECTORY_VERSION_LIMIT}
  `)

  const observationTotal = db.get<{ total: number }>(sql`select count(*) as total from platform_business_observation where record_id = ${recordId}`)!.total
  const observations = db.all<Omit<RecognizedDirectoryObservation, 'titleScopes' | 'titleConflict' | 'correspondenceRefs' | 'version'> & RecognizedDirectoryVersionFields>(sql`
    select o.relation_id as relationId, r.query_id as queryId, q.queried_at as queriedAt, q.query_key as queryKey,
      q.status as queryStatus, r.sequence_no as sequenceNo, r.enterprise_id as enterpriseId, e.name as enterpriseName,
      o.identity_state as identityState, o.content_state as contentState, o.key_source as keySource,
      o.projection_rule_version as projectionRuleVersion, o.version_id as versionId,
      p.validity_date_raw as validityDateRaw, p.maintenance_year as maintenanceYear, p.maintenance_batch as maintenanceBatch,
      p.district, p.award_note as awardNote, p.title_raw as titleRaw, p.name_raw as nameRaw, p.uscc_raw as usccRaw,
      p.rule_version as ruleVersion
    from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    join platform_query q on q.id = r.query_id
    left join enterprise e on e.id = r.enterprise_id
    left join platform_recognized_projection p on p.version_id = o.version_id
    where o.record_id = ${recordId}
    order by q.queried_at desc, o.relation_id desc
    limit ${RECOGNIZED_DIRECTORY_OBSERVATION_LIMIT}
  `)
  const versionIds = versions.map(version => version.versionId)
  const versionQueryRows = versionIds.length ? db.all<{ versionId: number; queryId: number }>(sql`
    select distinct o.version_id as versionId, r.query_id as queryId
    from platform_business_observation o join platform_relation r on r.id = o.relation_id
    where o.version_id in (${sql.join(versionIds.map(id => sql`${id}`), sql`, `)})
  `) : []
  const queryIds = [...new Set([...observations.map(observation => observation.queryId), ...versionQueryRows.map(row => row.queryId)])]
  const scopesByQuery = titleScopesByQuery(db, queryIds)
  const versionScopes = new Map<number, Set<string>>()
  for (const row of versionQueryRows) {
    const set = versionScopes.get(row.versionId) ?? new Set<string>()
    for (const scope of scopesByQuery.get(row.queryId) ?? []) set.add(scope)
    versionScopes.set(row.versionId, set)
  }
  const relationIds = observations.map(observation => observation.relationId)
  const correspondenceRows = relationIds.length ? db.all<{ relationId: number; id: number; status: string; revision: number }>(sql`
    select relation_id as relationId, id, status, revision from record_correspondence
    where relation_id in (${sql.join(relationIds.map(id => sql`${id}`), sql`, `)})
    order by relation_id, id
  `) : []
  const correspondenceByRelation = new Map<number, { id: number; status: string; revision: number }[]>()
  for (const row of correspondenceRows) {
    const list = correspondenceByRelation.get(row.relationId) ?? []
    list.push({ id: row.id, status: row.status, revision: row.revision })
    correspondenceByRelation.set(row.relationId, list)
  }
  return {
    record,
    versions: versions.map(version => ({ ...version, titleScopes: orderedScopes(versionScopes.get(version.versionId) ?? []) })),
    observations: observations.map(({ validityDateRaw, maintenanceYear, maintenanceBatch, district, awardNote, titleRaw, nameRaw, usccRaw, ruleVersion, ...observation }) => ({
      ...observation,
      titleScopes: scopesByQuery.get(observation.queryId) ?? [],
      titleConflict: titleConflictOf(titleRaw, scopesByQuery.get(observation.queryId) ?? []),
      correspondenceRefs: correspondenceByRelation.get(observation.relationId) ?? [],
      version: observation.versionId == null ? null : versionFields({
        versionId: observation.versionId, validityDateRaw, maintenanceYear, maintenanceBatch, district, awardNote,
        titleRaw, nameRaw, usccRaw, ruleVersion,
      }),
    })),
    counts: {
      versions: versionTotal,
      observations: observationTotal,
      versionsTruncated: versionTotal > versions.length,
      observationsTruncated: observationTotal > observations.length,
    },
    conflicts: recordConflicts(db, [recordId]).get(recordId) ?? [],
  }
}

export function readPlatformRecognizedFacts(db: Db, relationIds: number[]): Map<number, PlatformObservationFact> {
  const result = new Map<number, PlatformObservationFact>()
  const o = schema.platformBusinessObservation, p = schema.platformRecognizedProjection, r = schema.platformRelation
  for (const ids of factBatches(relationIds)) {
    const rows = db.select({
      relationId: o.relationId, projectionVersionId: p.versionId,
      titleRaw: p.titleRaw, maintenanceBatch: p.maintenanceBatch, usccRaw: p.usccRaw,
      legacy: legacyRelationColumns,
    }).from(o)
      .leftJoin(p, and(eq(p.versionId, o.versionId), eq(p.recordId, o.recordId)))
      .innerJoin(r, eq(r.id, o.relationId))
      .where(inArray(o.relationId, ids)).all()
    for (const row of rows) {
      const normalized = normalizePlatformRelation('recognized_list', row.legacy)
      result.set(row.relationId, row.projectionVersionId != null ? {
        relationId: row.relationId, interface: 'recognized_list',
        declareKind: null, year: normalized.year ?? null, appliedAt: null, status: normalized.status ?? null,
        batch: row.maintenanceBatch ?? normalized.batch ?? null, awardBatchLabel: normalized.awardBatchLabel ?? null,
        province: normalized.province ?? null, usccRaw: row.usccRaw ?? normalized.usccRaw ?? null,
        titleRaw: row.titleRaw ?? null, normalizationConflicts: normalized.normalizationConflicts,
      } : {
        relationId: row.relationId, interface: 'recognized_list',
        declareKind: normalized.declareKind ?? null, year: normalized.year ?? null, appliedAt: normalized.appliedAt ?? null,
        status: normalized.status ?? null, batch: normalized.batch ?? null, awardBatchLabel: normalized.awardBatchLabel ?? null,
        province: normalized.province ?? null, usccRaw: normalized.usccRaw ?? null,
        titleRaw: legacyRowTitle(normalized.rawFields), normalizationConflicts: normalized.normalizationConflicts,
      })
    }
    const missing = ids.filter(id => !result.has(id))
    if (missing.length) for (const row of readLegacyRelationRows(db, missing)) {
      const normalized = normalizePlatformRelation('recognized_list', row)
      result.set(row.id, {
        relationId: row.id, interface: 'recognized_list',
        declareKind: normalized.declareKind ?? null, year: normalized.year ?? null, appliedAt: normalized.appliedAt ?? null,
        status: normalized.status ?? null, batch: normalized.batch ?? null, awardBatchLabel: normalized.awardBatchLabel ?? null,
        province: normalized.province ?? null, usccRaw: normalized.usccRaw ?? null,
        titleRaw: legacyRowTitle(normalized.rawFields), normalizationConflicts: normalized.normalizationConflicts,
      })
    }
  }
  return result
}
