import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { normalizeDeclareKind } from '../../lib/platform/identity'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { legacyRowTitle, type PlatformObservationFact } from '../../lib/platform/observation-facts'
import { factBatches, legacyRelationColumns, readLegacyRelationRows } from './platform-legacy-relation-read'
import { businessEnterpriseExists, enterpriseAssignments, fail, pageOf } from './platform-business-read'
import {
  DECLARATION_OBSERVATION_LIMIT,
  DECLARATION_VERSION_LIMIT,
  declarationFilterSchema,
  type DeclarationDetail,
  type DeclarationFilter,
  type DeclarationIsolatedRow,
  type DeclarationListResult,
  type DeclarationObservation,
  type DeclarationRecordRow,
  type DeclarationVersion,
  type DeclarationVersionFields,
} from '../../lib/platform/declarations'

type Db = BetterSQLite3Database<typeof schema>

function normalizedFilter(input: unknown): DeclarationFilter {
  const parsed = declarationFilterSchema.safeParse(input)
  if (!parsed.success) throw Object.assign(new Error('Invalid declaration query parameters'), { statusCode: 400, code: 'invalid_declaration_filter' })
  return parsed.data
}

function recordConditions(filter: DeclarationFilter): SQL[] {
  const conditions: SQL[] = [sql`b.interface = 'apply_list'`]
  if (filter.platformKey) conditions.push(sql`b.platform_key = ${filter.platformKey}`)
  const declareKind = filter.declareKind ? normalizeDeclareKind(filter.declareKind) : null
  if (declareKind) conditions.push(sql`p.declare_kind = ${declareKind}`)
  if (filter.year != null) conditions.push(sql`p.declaration_year = ${filter.year}`)
  if (filter.status) conditions.push(sql`p.status = ${filter.status}`)
  const enterprise = businessEnterpriseExists(filter)
  if (enterprise) conditions.push(enterprise)
  return conditions
}

function isolatedConditions(filter: DeclarationFilter): SQL[] {
  const conditions: SQL[] = [
    sql`q.interface = 'apply_list'`,
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
  return conditions
}

function listRecordRows(db: Db, filter: DeclarationFilter, total: number): DeclarationListResult {
  const { page, pageSize, offset } = pageOf(filter)
  const where = sql.join(recordConditions(filter), sql` and `)
  const rows = db.all<{
    recordId: number; platformKey: string; versionId: number; declareKind: string | null; declarationYear: number | null;
    appliedAt: string | null; status: string | null; nameRaw: string | null; usccRaw: string | null;
    ruleVersion: string | null; matchedVersionCount: number; versionCount: number; observationCount: number; latestObservationAt: string | null
  }>(sql`
    with matched as (
      select v.id as version_id, v.record_id, p.declare_kind, p.declaration_year, p.applied_at, p.status,
        p.name_raw, p.uscc_raw, p.rule_version, b.platform_key,
        count(*) over (partition by v.record_id) as matched_version_count,
        row_number() over (partition by v.record_id order by (p.applied_at is null), p.applied_at desc, v.id desc) as rn
      from platform_business_record_version v
      left join platform_apply_projection p on p.version_id = v.id
      join platform_business_record b on b.id = v.record_id
      where ${where}
    )
    select m.record_id as recordId, m.platform_key as platformKey, m.version_id as versionId,
      m.declare_kind as declareKind, m.declaration_year as declarationYear, m.applied_at as appliedAt,
      m.status, m.name_raw as nameRaw, m.uscc_raw as usccRaw, m.rule_version as ruleVersion,
      m.matched_version_count as matchedVersionCount,
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
  const conflictRows = rows.length ? db.all<{ recordId: number; contentState: string }>(sql`
    select distinct o.record_id as recordId, o.content_state as contentState
    from platform_business_observation o
    where o.record_id in (${sql.join(rows.map(row => sql`${row.recordId}`), sql`, `)})
  `) : []
  const conflictByRecord = new Map<number, string[]>()
  for (const row of conflictRows) {
    const list = conflictByRecord.get(row.recordId) ?? []
    if (row.contentState === 'unverifiable' && !list.includes('unverifiable_observation')) list.push('unverifiable_observation')
    conflictByRecord.set(row.recordId, list)
  }
  const out: DeclarationRecordRow[] = rows.map(row => {
    const assignmentsForRecord = assignments.get(row.recordId) ?? { ids: [], names: [] }
    const conflicts = [...(conflictByRecord.get(row.recordId) ?? [])]
    if (assignmentsForRecord.ids.length > 1) conflicts.push('enterprise_assignment_conflict')
    return {
      kind: 'record',
      record: { id: row.recordId, platformKey: row.platformKey, interface: 'apply_list' },
      matchedVersion: {
        versionId: row.versionId, declareKind: row.declareKind, declarationYear: row.declarationYear,
        appliedAt: row.appliedAt, status: row.status, nameRaw: row.nameRaw, usccRaw: row.usccRaw,
        ruleVersion: row.ruleVersion,
      },
      matchedVersionCount: row.matchedVersionCount,
      versionCount: row.versionCount,
      observationCount: row.observationCount,
      latestObservationAt: row.latestObservationAt,
      enterpriseIds: assignmentsForRecord.ids,
      enterpriseNames: assignmentsForRecord.names,
      conflicts,
    }
  })
  return { view: 'records', rows: out, total, page, pageSize }
}

function listIsolatedRows(db: Db, filter: DeclarationFilter, total: number): DeclarationListResult {
  const { page, pageSize, offset } = pageOf(filter)
  const where = sql.join(isolatedConditions(filter), sql` and `)
  const rows = db.all<DeclarationIsolatedRow & { enterpriseName: string | null }>(sql`
    select 'observation' as kind, o.relation_id as relationId, r.query_id as queryId, q.queried_at as queriedAt,
      q.query_key as queryKey, q.status as queryStatus, r.sequence_no as sequenceNo,
      o.identity_state as identityState, o.content_state as contentState,
      r.name_raw as nameRaw, r.uscc_raw as usccRaw, r.declare_kind as declareKind, r.year as declarationYear,
      r.applied_at as appliedAt, r.status, r.enterprise_id as enterpriseId, e.name as enterpriseName
    from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    join platform_query q on q.id = r.query_id
    left join enterprise e on e.id = r.enterprise_id
    where ${where}
    order by q.queried_at desc, o.relation_id desc
    limit ${pageSize} offset ${offset}
  `)
  return { view: 'isolated', rows: rows.map(row => ({ ...row, kind: 'observation' as const })), total, page, pageSize }
}

export function listPlatformDeclarations(input: unknown, db: Db): DeclarationListResult {
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
    left join platform_apply_projection p on p.version_id = v.id
    join platform_business_record b on b.id = v.record_id
    where ${where}
  `)!.total
  return listRecordRows(db, filter, total)
}

function versionFields(row: {
  versionId: number; declareKind: string | null; declarationYear: number | null; appliedAt: string | null;
  status: string | null; nameRaw: string | null; usccRaw: string | null; ruleVersion: string | null
}): DeclarationVersionFields {
  return {
    versionId: row.versionId, declareKind: row.declareKind, declarationYear: row.declarationYear,
    appliedAt: row.appliedAt, status: row.status, nameRaw: row.nameRaw, usccRaw: row.usccRaw,
    ruleVersion: row.ruleVersion,
  }
}

export function getPlatformDeclaration(db: Db, recordId: number): DeclarationDetail {
  if (!Number.isSafeInteger(recordId) || recordId < 1) fail(400, 'invalid_declaration_id', 'recordId must be a positive safe integer')
  const record = db.get<{ id: number; platformKey: string; interface: 'apply_list'; identityRuleVersion: string; createdAt: string }>(sql`
    select id, platform_key as platformKey, interface, identity_rule_version as identityRuleVersion, created_at as createdAt
    from platform_business_record where id = ${recordId} and interface = 'apply_list'
  `)
  if (!record) fail(404, 'declaration_not_found', 'Declaration record not found')

  const versionTotal = db.get<{ total: number }>(sql`select count(*) as total from platform_business_record_version where record_id = ${recordId}`)!.total
  const versions = db.all<DeclarationVersion>(sql`
    select v.id as versionId, v.hash_algorithm as hashAlgorithm, v.content_hash as contentHash, v.created_at as createdAt,
      p.declare_kind as declareKind, p.declaration_year as declarationYear, p.applied_at as appliedAt, p.status,
      p.name_raw as nameRaw, p.uscc_raw as usccRaw, p.rule_version as ruleVersion,
      (select count(*) from platform_business_observation o where o.version_id = v.id) as observationCount,
      (select min(q.queried_at) from platform_business_observation o
        join platform_relation r on r.id = o.relation_id join platform_query q on q.id = r.query_id
        where o.version_id = v.id) as firstObservedAt,
      (select max(q.queried_at) from platform_business_observation o
        join platform_relation r on r.id = o.relation_id join platform_query q on q.id = r.query_id
        where o.version_id = v.id) as lastObservedAt
    from platform_business_record_version v
    left join platform_apply_projection p on p.version_id = v.id
    where v.record_id = ${recordId}
    order by v.id desc
    limit ${DECLARATION_VERSION_LIMIT}
  `)

  const observationTotal = db.get<{ total: number }>(sql`select count(*) as total from platform_business_observation where record_id = ${recordId}`)!.total
  const observations = db.all<DeclarationObservation & {
    declareKind: string | null; declarationYear: number | null; appliedAt: string | null; status: string | null;
    nameRaw: string | null; usccRaw: string | null; ruleVersion: string | null
  }>(sql`
    select o.relation_id as relationId, r.query_id as queryId, q.queried_at as queriedAt, q.query_key as queryKey,
      q.status as queryStatus, r.sequence_no as sequenceNo, r.enterprise_id as enterpriseId, e.name as enterpriseName,
      o.identity_state as identityState, o.content_state as contentState, o.key_source as keySource,
      o.projection_rule_version as projectionRuleVersion, o.version_id as versionId,
      p.declare_kind as declareKind, p.declaration_year as declarationYear, p.applied_at as appliedAt, p.status,
      p.name_raw as nameRaw, p.uscc_raw as usccRaw, p.rule_version as ruleVersion
    from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    join platform_query q on q.id = r.query_id
    left join enterprise e on e.id = r.enterprise_id
    left join platform_apply_projection p on p.version_id = o.version_id
    where o.record_id = ${recordId}
    order by q.queried_at desc, o.relation_id desc
    limit ${DECLARATION_OBSERVATION_LIMIT}
  `)
  return {
    record,
    versions: versions.map(version => ({ ...version, ...versionFields(version) })),
    observations: observations.map(({ declareKind, declarationYear, appliedAt, status, nameRaw, usccRaw, ruleVersion, ...observation }) => ({
      ...observation,
      version: observation.versionId == null ? null : versionFields({ versionId: observation.versionId, declareKind, declarationYear, appliedAt, status, nameRaw, usccRaw, ruleVersion }),
    })),
    counts: {
      versions: versionTotal,
      observations: observationTotal,
      versionsTruncated: versionTotal > versions.length,
      observationsTruncated: observationTotal > observations.length,
    },
  }
}

const APPLY_MODELED_FIELDS = ['declareKind', 'year', 'appliedAt', 'status', 'nameRaw', 'usccRaw'] as const

/** The apply projection models no batch/province field; those keep the legacy column value
 * but stay outside `modeledFields` so detail consumers can fall back explicitly. */
function applyFactBase(relationId: number, normalized: ReturnType<typeof normalizePlatformRelation>, row: { nameRaw: string | null; usccRaw: string | null; titleRaw: string | null }) {
  return {
    relationId, interface: 'apply_list' as const,
    batch: normalized.batch ?? null, awardBatchLabel: normalized.awardBatchLabel ?? null,
    province: normalized.province ?? null, nameRaw: row.nameRaw, usccRaw: row.usccRaw,
    validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null, district: null, awardNote: null,
    titleRaw: row.titleRaw, normalizationConflicts: normalized.normalizationConflicts,
  }
}

export function readPlatformDeclarationFacts(db: Db, relationIds: number[]): Map<number, PlatformObservationFact> {
  const result = new Map<number, PlatformObservationFact>()
  const o = schema.platformBusinessObservation, p = schema.platformApplyProjection, r = schema.platformRelation
  for (const ids of factBatches(relationIds)) {
    const rows = db.select({
      relationId: o.relationId, projectionVersionId: p.versionId, projectionRuleVersion: p.ruleVersion, nameRaw: p.nameRaw,
      declareKind: p.declareKind, year: p.declarationYear, appliedAt: p.appliedAt, status: p.status, usccRaw: p.usccRaw,
      legacy: legacyRelationColumns,
    }).from(o)
      .leftJoin(p, and(eq(p.versionId, o.versionId), eq(p.recordId, o.recordId)))
      .innerJoin(r, eq(r.id, o.relationId))
      .where(inArray(o.relationId, ids)).all()
    for (const row of rows) {
      const normalized = normalizePlatformRelation('apply_list', row.legacy)
      const titleRaw = legacyRowTitle({ rdjb: row.legacy.rawRdjb })
      const typed = row.projectionVersionId != null
      result.set(row.relationId, {
        ...applyFactBase(row.relationId, normalized, {
          nameRaw: typed ? row.nameRaw ?? null : normalized.nameRaw ?? null,
          usccRaw: typed ? row.usccRaw ?? null : normalized.usccRaw ?? null,
          titleRaw,
        }),
        projectionVersionId: typed ? row.projectionVersionId : null,
        projectionRuleVersion: typed ? row.projectionRuleVersion ?? null : null,
        modeledFields: typed ? APPLY_MODELED_FIELDS : [],
        declareKind: typed ? row.declareKind ?? null : normalized.declareKind ?? null,
        year: typed ? row.year ?? null : normalized.year ?? null,
        appliedAt: typed ? row.appliedAt ?? null : normalized.appliedAt ?? null,
        status: typed ? row.status ?? null : normalized.status ?? null,
      })
    }
    const missing = ids.filter(id => !result.has(id))
    if (missing.length) for (const row of readLegacyRelationRows(db, missing)) {
      const normalized = normalizePlatformRelation('apply_list', row)
      result.set(row.id, {
        ...applyFactBase(row.id, normalized, {
          nameRaw: normalized.nameRaw ?? null, usccRaw: normalized.usccRaw ?? null,
          titleRaw: legacyRowTitle({ rdjb: row.rawRdjb }),
        }),
        projectionVersionId: null, projectionRuleVersion: null, modeledFields: [],
        declareKind: normalized.declareKind ?? null, year: normalized.year ?? null,
        appliedAt: normalized.appliedAt ?? null, status: normalized.status ?? null,
      })
    }
  }
  return result
}
