import { and, eq, exists, gte, isNotNull, notExists, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { differenceMeasures, differenceReasons, differenceStatuses } from '../../../../db/difference-codes'
import { COMPARISON_DIRECTIONS } from '../../lib/comparison-model'
import { enterprise, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import { differenceReason as d } from '../../../../db/postgresql/roster-selection-tables'
import { evidenceReviewReceipt114 as receipt } from '../../../../db/postgresql/evidence-review-tables'
import { platformBusinessObservation as observation, platformCollection, platformCollectionPage as page,
  platformObservationAssignment as assignment } from '../../../../db/postgresql/platform-tables'
import { postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { TITLE_ORDER } from '../../lib/labels'
import { isCurrentPlatformCollection, platformDecisionQueryMode } from '../../lib/platform/current-observation-postgres'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import type { RosterImportDifference, RosterImportItemResult } from '../../lib/roster-import-client'
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
  const owners = tx.select({ id: enterprise.id, uscc: enterprise.usccNorm }).from(enterprise)
  if (uscc) {
    const [match] = await tx.select({ id: enterprise.id }).from(enterprise).where(eq(enterprise.usccNorm, uscc))
    if (match) {
      const id = await postgresCanonicalEnterpriseId(tx, match.id)
      if (id !== null) {
        const query = owners.where(eq(enterprise.id, id))
        const [owner] = await (lock ? query.for('update') : query)
        if (owner) return owner
      }
    }
  }
  if (!name) return undefined
  const query = owners.where(and(eq(enterprise.nameNorm, normalizeName(name)), notExists(
    tx.select({ id: enterpriseMerge.fromEnterpriseId }).from(enterpriseMerge).where(eq(enterpriseMerge.fromEnterpriseId, enterprise.id)),
  ))).orderBy(enterprise.id).limit(1)
  const [owner] = await (lock ? query.for('update') : query)
  return owner
}

async function findCollection(tx: Tx, aliasId: number, mode?: ReturnType<typeof platformDecisionQueryMode>) {
  if (!Number.isSafeInteger(aliasId) || aliasId < 1) return undefined
  const [collection] = await tx.select({
    id: platformCollection.publicId, nativeId: platformCollection.id, interface: platformCollection.interface,
    queryKey: platformCollection.queryKey, rdjb: platformCollection.rdjb,
  }).from(platformCollection)
    .where(and(eq(platformCollection.publicId, aliasId), mode ? isCurrentPlatformCollection(tx, platformCollection, mode) : undefined))
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
  const [original] = await tx.select({ sequenceNo: observation.sequenceNo, usccRaw: assignment.usccRaw })
    .from(observation).innerJoin(assignment, and(eq(assignment.observationId, observation.id), eq(assignment.revision, 1)))
    .where(eq(observation.id, relation.observationId))
  if (!original || normalizeUscc(original.usccRaw) !== uscc || (relation.enterpriseId !== null && relation.enterpriseId !== enterprise.id)) {
    return 'Evidence relation belongs to another or unknown enterprise'
  }
  // Drizzle 0.45.4 has no window function builder for the running page count.
  const pages = tx.select({
    rdjb: page.rdjb, ordinal: page.ordinal,
    lastSequence: sql<number>`sum(coalesce(${page.fetchedCount}, 0)) over (order by ${page.ordinal})`.as('last_sequence'),
  }).from(page).where(and(eq(page.collectionId, source.nativeId), eq(page.status, 'success'))).as('pages')
  const [matchingPage] = await tx.select({ rdjb: pages.rdjb }).from(pages)
    .where(gte(pages.lastSequence, original.sequenceNo)).orderBy(pages.ordinal).limit(1)
  return RDJB_TITLE_CODES[matchingPage?.rdjb ?? ''] === difference.titleCode ? null : 'Evidence row belongs to another title'
}

type DifferencePlan = {
  difference: RosterImportDifference
  index: number
  item: RosterImportItemResult
  action: 'add' | 'skip'
  review: boolean
  values?: Evidence & Pick<typeof d.$inferSelect, 'enterpriseId' | 'recordedAt' | 'reasonCode' | 'measureCode'>
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
  if (!COMPARISON_DIRECTIONS.includes(difference.direction)) {
    return reject('direction_unknown', 'direction 必须是 missing_in_miit / extra_in_miit', 'direction')
  }
  if (difference.status != null && !differenceStatuses.includes(difference.status)) {
    return reject('difference_status_unknown', `status 不在状态机内：${difference.status}`, 'status')
  }
  const reasonCode = differenceReasons.find(code => code === difference.reasonCode) ?? null
  if (difference.reasonCode != null && reasonCode === null) {
    return reject('reason_unknown', `reasonCode 不在字典内：${difference.reasonCode}`, 'reasonCode')
  }
  const measureCode = differenceMeasures.find(code => code === difference.measureCode) ?? null
  if (difference.measureCode != null && measureCode === null) {
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

  if (relationId !== null && Number.isSafeInteger(relationId) && relationId > 0) {
    relation = await findPostgresImportRelationById(tx, relationId)
  }
  if (relationId !== null && !relation) return reject('evidence_subject_mismatch', 'Relation evidence not found', 'evidenceRelationRef')
  const queryMode = relation ? undefined : platformDecisionQueryMode(difference.status)
  const query = queryId === null ? null : (await findCollection(tx, queryId, queryMode) ?? null)
  if (queryId !== null && !query) return reject('evidence_subject_mismatch', 'Current query evidence not found', 'evidenceQueryRef')
  if (query && relation && query.nativeId !== relation.collectionId) {
    return reject('evidence_subject_mismatch', 'Query and relation evidence must identify the same source query', 'evidenceRelationRef')
  }
  const mismatch = await evidenceMismatch(tx, enterprise, difference, { query, relation })
  if (mismatch) return reject('evidence_subject_mismatch', mismatch, 'evidenceRelationRef')

  const scope = and(eq(d.enterpriseId, enterprise.id), eq(d.titleCode, difference.titleCode), eq(d.direction, difference.direction))
  const adopted = exists(tx.select({ id: receipt.id }).from(receipt).where(and(
    or(eq(receipt.decisionId, d.id), eq(receipt.sourceDecisionId, d.id)),
    isNotNull(receipt.reviewedRevisionId),
  )))
  const [managed] = await tx.select({ id: d.id }).from(d).where(and(scope, or(isNotNull(d.lifecycleAction), adopted))).limit(1)
  if (managed) return reject('decision_lifecycle_required', '该企业称号方向已采用差异决定生命周期；请用 /api/roster/decision-lifecycle/commands 或 save_difference_decision', 'differences')
  const [existing] = await tx.select({ id: d.id }).from(d).where(and(scope, eq(d.recordedAt, recordedAt)))
  const existingId = existing?.id ?? null
  return {
    difference, index,
    action: existingId === null ? 'add' : 'skip',
    review: difference.status === 'needs_review' || difference.verificationStatus !== 'confirmed',
    item: { ok: true, kind: 'difference', ref: existingId === null ? ref : 'difference:' + existingId, detail: { enterpriseId: enterprise.id } },
    values: { enterpriseId: enterprise.id, recordedAt, reasonCode, measureCode, query, relation },
  }
}

export async function writePostgresImportDifference(tx: Tx, plan: DifferencePlan): Promise<RosterImportItemResult> {
  if (!plan.values) return plan.item
  const current = await planDifference(tx, plan.difference, plan.index, true)
  if (!current.values) return current.item
  const { enterpriseId, recordedAt, reasonCode, measureCode, query, relation } = current.values
  const { difference } = current
  if (enterpriseId !== plan.values.enterpriseId) {
    return { ok: false, kind: 'difference', ref: 'difference:' + plan.index, error: {
      code: 'enterprise_changed', message: '差异归属企业已变更，请重新核对', field: 'enterpriseName',
    } }
  }
  if (current.action === 'skip') return { ...current.item, detail: { enterpriseId, rowsWritten: 0 } }

  const [inserted] = await tx.insert(d).values({
    enterpriseId, titleCode: difference.titleCode, direction: difference.direction,
    status: difference.status ?? 'not_queried', reasonCode, reasonNote: optionalText(difference.reasonNote),
    measureCode, measureNote: optionalText(difference.measureNote),
    evidenceQueryId: query?.nativeId ?? null, evidenceRelationId: relation?.observationId ?? null,
    movedInCity: optionalText(difference.movedIn?.city), movedInTitleCode: optionalText(difference.movedIn?.titleCode),
    movedInYear: optionalInt(difference.movedIn?.year), movedInBatch: optionalInt(difference.movedIn?.batch),
    verificationStatus: difference.verificationStatus ?? 'pending', recordedAt, createdAt: new Date().toISOString(),
  }).returning({ id: d.id })
  return { ok: true, kind: 'difference', ref: 'difference:' + inserted!.id, detail: {
    enterpriseId, evidenceQueryId: query?.id ?? null, evidenceRelationId: relation?.id ?? null, rowsWritten: 1,
  } }
}
