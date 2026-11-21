import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { differenceReason } from '../../../../db/schema'
import { postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { TITLE_ORDER } from '../../lib/labels'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import type { RosterImportDifference, RosterImportItemResult } from '../../lib/roster-import-client'
import { managedDecision102 } from './decision-lifecycle-102'
import { findPostgresImportQuery, findPostgresImportRelation, findPostgresImportRelationById, type PostgresImportRelation } from './roster-import-references-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Enterprise = { id: number; uscc: string | null }
type Collection = { id: number; nativeId: number; interface: string; queryKey: string; rdjb: string }
type Evidence = { query: Collection | null; relation: PostgresImportRelation | null }

const titleCodes = new Set<string>(TITLE_ORDER)
const queryRefField = 'differences[].evidenceQueryRef'
const relationRefField = 'differences[].evidenceRelationRef'
const optionalText = (value: unknown) => typeof value === 'string' ? value.trim() || null : null
const optionalInt = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null

async function locateEnterprise(tx: Tx, difference: RosterImportDifference, lock: boolean) {
  const uscc = normalizeUscc(difference.uscc)
  const name = optionalText(difference.enterpriseName)
  if (uscc) {
    const { rows: [match] } = await tx.execute<{ id: number }>(sql`
      SELECT id::float8 AS id FROM enterprise WHERE uscc_norm=${uscc}`)
    if (match) {
      const id = await postgresCanonicalEnterpriseId(tx, match.id)
      const { rows: [owner] } = await tx.execute<Enterprise>(sql`
        SELECT id::float8 AS id,uscc_norm AS uscc FROM enterprise WHERE id=${id} ${lock ? sql`FOR UPDATE` : sql.empty()}`)
      if (owner) return owner
    }
  }
  if (!name) return undefined
  const { rows: [owner] } = await tx.execute<Enterprise>(sql`
    SELECT id::float8 AS id,uscc_norm AS uscc FROM enterprise e WHERE name_norm=${normalizeName(name)}
      AND NOT EXISTS(SELECT 1 FROM enterprise_merge WHERE from_enterprise_id=e.id)
    ORDER BY id LIMIT 1 ${lock ? sql`FOR UPDATE` : sql.empty()}`)
  return owner
}

async function findCollection(tx: Tx, aliasId: number) {
  if (!Number.isSafeInteger(aliasId) || aliasId < 1) return undefined
  const { rows: [collection] } = await tx.execute<Collection>(sql`
    SELECT a.old_id::float8 AS id,c.id::float8 AS "nativeId",c.interface,c.query_key AS "queryKey",c.rdjb
    FROM platform_collection c JOIN platform_legacy_query_alias a ON a.collection_id=c.id
    WHERE a.old_id=${aliasId}`)
  return collection
}

async function evidenceMismatch(tx: Tx, enterprise: Enterprise, difference: RosterImportDifference, evidence: Evidence) {
  const { query, relation } = evidence
  const source = relation ? await findCollection(tx, relation.queryId) : query
  if (!source || source.interface !== 'recognized_list') return null
  const supplied = normalizeUscc(difference.uscc)
  if (supplied && supplied !== enterprise.uscc) return 'Supplied USCC conflicts with the resolved enterprise'
  const uscc = supplied || enterprise.uscc
  if (!uscc) return 'Recognized evidence cannot confirm subject by name alone'
  if (!source.rdjb.split(',').some(rdjb => RDJB_TITLE_CODES[rdjb] === difference.titleCode)) {
    return 'Evidence title scope does not include decision title'
  }
  if (!relation) return source.queryKey === uscc ? null : 'Query-only evidence requires an exact subject USCC query'
  const { rows: [original] } = await tx.execute<{ sequenceNo: number; usccRaw: string | null }>(sql`
    SELECT o.sequence_no::float8 AS "sequenceNo",a.uscc_raw AS "usccRaw" FROM platform_business_observation o
    JOIN platform_observation_assignment a ON a.observation_id=o.id AND a.revision=1
    WHERE o.id=${relation.observationId}`)
  if (!original || normalizeUscc(original.usccRaw) !== uscc || (relation.enterpriseId !== null && relation.enterpriseId !== enterprise.id)) {
    return 'Evidence relation belongs to another or unknown enterprise'
  }
  const { rows: [page] } = await tx.execute<{ rdjb: string | null }>(sql`
    SELECT rdjb FROM (
      SELECT rdjb,ordinal,sum(coalesce(fetched_count,0)) OVER (ORDER BY ordinal) AS last_sequence
      FROM platform_collection_page WHERE collection_id=${source.nativeId} AND status='success'
    ) pages WHERE last_sequence >= ${original.sequenceNo} ORDER BY ordinal LIMIT 1`)
  return RDJB_TITLE_CODES[page?.rdjb ?? ''] === difference.titleCode ? null : 'Evidence row belongs to another title'
}

type DifferencePlan = {
  difference: RosterImportDifference
  index: number
  item: RosterImportItemResult
  action: 'add' | 'skip'
  review: boolean
  values?: Evidence & { enterpriseId: number; recordedAt: string }
}

export async function planPostgresImportDifference(tx: Tx, difference: RosterImportDifference, index: number): Promise<DifferencePlan> {
  return planDifference(tx, difference, index, false)
}

async function planDifference(tx: Tx, difference: RosterImportDifference, index: number, lock: boolean): Promise<DifferencePlan> {
  const ref = 'difference:' + index
  const reject = (code: string, message: string, field: string): DifferencePlan => ({
    difference, index, action: 'skip', review: false,
    item: { ok: false, kind: 'difference', ref, error: { code, message, field } },
  })
  if (!titleCodes.has(String(difference?.titleCode))) return reject('title_unknown', `称号不在字典内：${String(difference?.titleCode)}`, 'titleCode')
  if (!differenceReason.direction.enumValues.includes(difference.direction)) {
    return reject('direction_unknown', 'direction 必须是 missing_in_miit / extra_in_miit', 'direction')
  }
  if (difference.status != null && !differenceReason.status.enumValues.includes(difference.status)) {
    return reject('difference_status_unknown', `status 不在状态机内：${difference.status}`, 'status')
  }
  if (difference.reasonCode != null && !differenceReason.reasonCode.enumValues.some(code => code === difference.reasonCode)) {
    return reject('reason_unknown', `reasonCode 不在字典内：${difference.reasonCode}`, 'reasonCode')
  }
  if (difference.measureCode != null && !differenceReason.measureCode.enumValues.some(code => code === difference.measureCode)) {
    return reject('measure_unknown', `measureCode 不在字典内：${difference.measureCode}`, 'measureCode')
  }
  if (difference.reasonCode === 'pending_review' && (
    difference.status !== 'confirmed_reason' || difference.verificationStatus !== 'confirmed' || difference.measureCode !== 'follow_review'
  )) return reject('pending_review_decision_invalid', '待审核须为 confirmed_reason + confirmed，并配 follow_review 保留历史及跟进审核', 'reasonCode')
  const recordedAt = optionalText(difference.recordedAt)
  if (!recordedAt) return reject('recorded_at_required', '差异解释缺少 recordedAt（登记时点）', 'recordedAt')
  let queryId = optionalInt(difference.evidenceQueryId)
  const relationId = optionalInt(difference.evidenceRelationId)
  if (queryId !== null && difference.evidenceQueryRef != null) {
    return reject('evidence_ref_conflict', '同时给了 evidenceQueryId 与 evidenceQueryRef；请只给其一', queryRefField)
  }
  if (relationId !== null && difference.evidenceRelationRef != null) {
    return reject('evidence_ref_conflict', '同时给了 evidenceRelationId 与 evidenceRelationRef；请只给其一', relationRefField)
  }
  if (difference.evidenceQueryRef != null) {
    const resolved = await findPostgresImportQuery(tx, difference.evidenceQueryRef, queryRefField)
    if (!resolved.ok) return reject(resolved.error.code, resolved.error.message, resolved.error.field)
    queryId = resolved.value.id
  }
  let relation: PostgresImportRelation | null = null
  if (difference.evidenceRelationRef != null) {
    const resolved = await findPostgresImportRelation(tx, difference.evidenceRelationRef, relationRefField)
    if (!resolved.ok) return reject(resolved.error.code, resolved.error.message, resolved.error.field)
    relation = resolved.value
  }
  const enterprise = await locateEnterprise(tx, difference, lock)
  if (!enterprise) return reject('enterprise_not_found', '差异找不到归属企业：' +
    (optionalText(difference.enterpriseName) ?? (normalizeUscc(difference.uscc) || '(空)')), 'enterpriseName')

  const query = queryId === null ? null : (await findCollection(tx, queryId) ?? null)
  if (queryId !== null && !query) return reject('evidence_subject_mismatch', 'Query evidence not found', 'evidenceRelationRef')
  if (relationId !== null && Number.isSafeInteger(relationId) && relationId > 0) {
    relation = await findPostgresImportRelationById(tx, relationId)
  }
  if (relationId !== null && !relation) return reject('evidence_subject_mismatch', 'Relation evidence not found', 'evidenceRelationRef')
  if (query && relation && query.nativeId !== relation.collectionId) {
    return reject('evidence_subject_mismatch', 'Query and relation evidence must identify the same source query', 'evidenceRelationRef')
  }
  const mismatch = await evidenceMismatch(tx, enterprise, difference, { query, relation })
  if (mismatch) return reject('evidence_subject_mismatch', mismatch, 'evidenceRelationRef')

  const scope = sql`d.enterprise_id=${enterprise.id} AND d.title_code=${difference.titleCode} AND d.direction=${difference.direction}`
  const { rows: [state] } = await tx.execute<{ existingId: number | null; managed: boolean }>(sql`
    SELECT (SELECT id::float8 FROM difference_reason d WHERE ${scope} AND d.recorded_at=${recordedAt}) AS "existingId",
      EXISTS(SELECT 1 FROM difference_reason d WHERE ${scope} AND ${managedDecision102(sql`d.id`, sql`d.lifecycle_action`)}) AS managed`)
  if (state!.managed) return reject('decision_lifecycle_required', '该企业称号方向已采用差异决定生命周期；请用 /api/roster/decision-lifecycle/commands 或 save_difference_decision', 'differences')
  const existingId = state!.existingId
  return {
    difference, index,
    action: existingId === null ? 'add' : 'skip',
    review: difference.status === 'needs_review' || difference.verificationStatus !== 'confirmed',
    item: { ok: true, kind: 'difference', ref: existingId === null ? ref : 'difference:' + existingId, detail: { enterpriseId: enterprise.id } },
    values: { enterpriseId: enterprise.id, recordedAt, query, relation },
  }
}

export async function writePostgresImportDifference(tx: Tx, plan: DifferencePlan): Promise<RosterImportItemResult> {
  if (!plan.values) return plan.item
  const current = await planDifference(tx, plan.difference, plan.index, true)
  if (!current.values) return current.item
  const { enterpriseId, recordedAt, query, relation } = current.values
  const { difference } = current
  if (enterpriseId !== plan.values.enterpriseId) {
    return { ok: false, kind: 'difference', ref: 'difference:' + plan.index, error: {
      code: 'enterprise_changed', message: '差异归属企业已变更，请重新核对', field: 'enterpriseName',
    } }
  }
  if (current.action === 'skip') return { ...current.item, detail: { enterpriseId, rowsWritten: 0 } }

  const { rows: [inserted] } = await tx.execute<{ id: number }>(sql`
    INSERT INTO difference_reason(enterprise_id,title_code,direction,status,reason_code,reason_note,measure_code,measure_note,
      evidence_query_id,evidence_relation_id,moved_in_city,moved_in_title_code,moved_in_year,moved_in_batch,verification_status,recorded_at,created_at)
    VALUES(${enterpriseId},${difference.titleCode},${difference.direction},${difference.status ?? 'not_queried'},
      ${difference.reasonCode ?? null},${optionalText(difference.reasonNote)},${difference.measureCode ?? null},${optionalText(difference.measureNote)},
      ${query?.nativeId ?? null},${relation?.observationId ?? null},${optionalText(difference.movedIn?.city)},
      ${optionalText(difference.movedIn?.titleCode)},${optionalInt(difference.movedIn?.year)},${optionalInt(difference.movedIn?.batch)},
      ${difference.verificationStatus ?? 'pending'},${recordedAt},${new Date().toISOString()})
    RETURNING id::float8 AS id`)
  return { ok: true, kind: 'difference', ref: 'difference:' + inserted!.id, detail: {
    enterpriseId, evidenceQueryId: query?.id ?? null, evidenceRelationId: relation?.id ?? null, rowsWritten: 1,
  } }
}
