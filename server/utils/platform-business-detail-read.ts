import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import type * as schema from '../../db/schema'
import type { RosterPlatformQueryRow } from '../../lib/roster/enterprise-roster'
import type { PlatformDetailObservation, PlatformDetailTypedFields } from '../../lib/roster/platform-business-detail'
import { groupPlatformBusinessDetails } from '../../lib/roster/platform-business-detail'
import { sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { readPlatformBusinessGroups } from './platform-business-record-read'
import { normalizeUscc } from '../../lib/domain'

type Db = BetterSQLite3Database<typeof schema>

interface TypedDetailRow {
  relationId: number
  interface: string
  applyVersionId: number | null
  applyRuleVersion: string | null
  applyDeclareKind: string | null
  applyYear: number | null
  applyAppliedAt: string | null
  applyStatus: string | null
  applyNameRaw: string | null
  applyUsccRaw: string | null
  businessVersionId: number | null
  businessRuleVersion: string | null
  businessDeclareKind: string | null
  businessYear: number | null
  businessAppliedAt: string | null
  businessStatus: string | null
  businessBatch: string | null
  businessProvince: string | null
  businessNameRaw: string | null
  businessUsccRaw: string | null
  recognizedVersionId: number | null
  recognizedRuleVersion: string | null
  recognizedValidityDateRaw: string | null
  recognizedMaintenanceYear: number | null
  recognizedMaintenanceBatch: string | null
  recognizedDistrict: string | null
  recognizedAwardNote: string | null
  recognizedNameRaw: string | null
  recognizedUsccRaw: string | null
}

const TYPED_CHUNK_SIZE = 400

/** One observation row joined to exactly its version's typed projection. No raw body,
 * canonical JSON or query condition is read here; unprojected history returns no row value. */
function readPlatformTypedDetailFields(db: Db, relationIds: number[]) {
  const result = new Map<number, PlatformDetailTypedFields | null>()
  const ids = [...new Set(relationIds)].sort((a, b) => a - b)
  for (let index = 0; index < ids.length; index += TYPED_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + TYPED_CHUNK_SIZE)
    const rows = db.all<TypedDetailRow>(sql`
      select o.relation_id as relationId, q.interface as interface,
        ap.version_id as applyVersionId, ap.rule_version as applyRuleVersion,
        ap.declare_kind as applyDeclareKind, ap.declaration_year as applyYear, ap.applied_at as applyAppliedAt,
        ap.status as applyStatus, ap.name_raw as applyNameRaw, ap.uscc_raw as applyUsccRaw,
        bp.version_id as businessVersionId, bp.rule_version as businessRuleVersion,
        bp.declare_kind as businessDeclareKind, bp.business_year as businessYear, bp.applied_at as businessAppliedAt,
        bp.status as businessStatus, bp.batch as businessBatch, bp.province as businessProvince,
        bp.name_raw as businessNameRaw, bp.uscc_raw as businessUsccRaw,
        rp.version_id as recognizedVersionId, rp.rule_version as recognizedRuleVersion,
        rp.validity_date_raw as recognizedValidityDateRaw, rp.maintenance_year as recognizedMaintenanceYear,
        rp.maintenance_batch as recognizedMaintenanceBatch, rp.district as recognizedDistrict,
        rp.award_note as recognizedAwardNote, rp.name_raw as recognizedNameRaw, rp.uscc_raw as recognizedUsccRaw
      from platform_business_observation o
      join platform_relation r on r.id = o.relation_id
      join platform_query q on q.id = r.query_id
      left join platform_apply_projection ap on ap.version_id = o.version_id and ap.record_id = o.record_id
      left join platform_business_projection bp on bp.version_id = o.version_id and bp.record_id = o.record_id
      left join platform_recognized_projection rp on rp.version_id = o.version_id and rp.record_id = o.record_id
      where o.relation_id in (${sql.join(chunk.map(id => sql`${id}`), sql`, `)})
    `)
    for (const row of rows) {
      if (row.interface === 'apply_list') {
        result.set(row.relationId, row.applyVersionId == null ? null : {
          interface: 'apply_list', ruleVersion: row.applyRuleVersion!,
          nameRaw: row.applyNameRaw, usccRaw: row.applyUsccRaw,
          declareKind: row.applyDeclareKind, year: row.applyYear,
          appliedAt: row.applyAppliedAt, status: row.applyStatus,
        })
      } else if (row.interface === 'business_list') {
        result.set(row.relationId, row.businessVersionId == null ? null : {
          interface: 'business_list', ruleVersion: row.businessRuleVersion!,
          nameRaw: row.businessNameRaw, usccRaw: row.businessUsccRaw,
          declareKind: row.businessDeclareKind, year: row.businessYear,
          appliedAt: row.businessAppliedAt, status: row.businessStatus,
          batch: row.businessBatch, province: row.businessProvince,
        })
      } else if (row.interface === 'recognized_list') {
        result.set(row.relationId, row.recognizedVersionId == null ? null : {
          interface: 'recognized_list', ruleVersion: row.recognizedRuleVersion!,
          nameRaw: row.recognizedNameRaw, usccRaw: row.recognizedUsccRaw,
          validityDateRaw: row.recognizedValidityDateRaw, maintenanceYear: row.recognizedMaintenanceYear,
          maintenanceBatch: row.recognizedMaintenanceBatch, district: row.recognizedDistrict,
          awardNote: row.recognizedAwardNote,
        })
      }
    }
  }
  return result
}

/** Caller supplies only displayed enterprise-scoped archives, inside its existing read transaction. */
export function readPlatformBusinessDetails(db: Db, enterpriseId: number, queries: RosterPlatformQueryRow[], relations: (typeof schema.platformRelation.$inferSelect)[]) {
  const typedFields = readPlatformTypedDetailFields(db, relations.map(relation => relation.id))
  const byQuery = new Map(queries.map(q => [q.id, q]))
  const groups = readPlatformBusinessGroups(db, relations.map(archived => {
    const query = byQuery.get(archived.queryId)!
    const row = normalizePlatformRelation(query.interface, archived)
    const rdjb = query.interface === 'recognized_list' ? sourcePositionForSequence(query.collectionEvidence, row.sequenceNo).sourceRdjb ?? '' : query.rdjb
    const titleCode = (query.interface === 'recognized_list' ? RDJB_TITLE_CODES[rdjb] ?? query.titleCode : query.titleCode ?? RDJB_TITLE_CODES[rdjb]) ?? ''
    const conflicts: string[] = row.normalizationConflicts.length ? ['platform_field_conflict'] : []
    const rawRdjb = typeof row.rawFields?.rdjb === 'string' ? row.rawFields.rdjb : ''
    if (rawRdjb && RDJB_TITLE_CODES[rawRdjb] && titleCode && RDJB_TITLE_CODES[rawRdjb] !== titleCode) conflicts.push('title_conflict')
    const rawUscc = typeof row.rawFields?.tyshxydm === 'string' ? normalizeUscc(row.rawFields.tyshxydm) : ''
    if (rawUscc && normalizeUscc(row.usccRaw) && rawUscc !== normalizeUscc(row.usccRaw)) conflicts.push('identity_conflict')
    return { relationId: row.id, queryId: row.queryId, sequenceNo: row.sequenceNo, interface: query.interface, relationKey: row.relationKey, queriedAt: query.queriedAt, queryStatus: query.status, queryKey: query.queryKey, rdjb, queryTitleCode: query.titleCode ?? null, titleCode, enterpriseId: row.enterpriseId, usccRaw: row.usccRaw, nameRaw: row.nameRaw, verificationStatus: row.verificationStatus, matchBasis: row.matchBasis,
      // Archive grouping has no event/title-role selection. Actual query title is kept above for conflicts.
      target: { eventId: null, enterpriseId, titleCode: '', type: 'archive', role: 'archive' }, evidence: {}, conflicts }
  }))
  const observations = groups.flatMap(g => g.observationRefs).map((o): PlatformDetailObservation => ({ relationId: o.relationId, queryId: o.queryId, queriedAt: o.queriedAt, businessRecord: o.businessRecord, existingCorrespondenceIds: o.existingCorrespondenceIds, existingCorrespondences: o.existingCorrespondences, conflicts: o.conflicts, titleCode: o.titleCode, enterpriseId: o.enterpriseId, usccRaw: o.usccRaw, nameRaw: o.nameRaw, typedFields: typedFields.get(o.relationId) ?? null })).sort((a, b) => a.relationId - b.relationId)
  return groupPlatformBusinessDetails(observations)
}
