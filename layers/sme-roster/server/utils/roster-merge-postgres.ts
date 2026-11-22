import { and, desc, eq, exists, gt, isNotNull, isNull, ne, notExists, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise, enterpriseAlias, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import { evidenceReviewReceipt114 } from '../../../../db/postgresql/evidence-review-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { platformObservationAssignment } from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { applyPostgresEnterpriseMerge, findPostgresEnterpriseMergeAliasConflict, lockPostgresReviewedEnterpriseBatch, postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import type { RosterImportItemResult, RosterImportMerge } from '../../lib/roster-import-client'
import type { MergeLineage } from './roster-import'
import { findPostgresImportQuery, findPostgresImportRelation } from './roster-import-references-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Subject = { id: number; name: string; nameNorm: string; uscc: string | null }
const subjectColumns = { id: enterprise.id, name: enterprise.name, nameNorm: enterprise.nameNorm, uscc: enterprise.usccNorm }

interface PostgresRosterMergePlan {
  readonly merge: RosterImportMerge
  readonly index: number
  readonly sourceEnterpriseId: number
  readonly intoEnterpriseId: number
}

function optionalText(value: unknown) {
  return typeof value === 'string' ? value.trim() || null : null
}
function optionalInt(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}
function failure(ref: string, code: string, message: string, field: string): RosterImportItemResult {
  return { ok: false, kind: 'merge', ref, error: { code, message, field } }
}

async function subjectById(tx: Tx, ref: number) {
  const id = Number.isSafeInteger(ref) ? await postgresCanonicalEnterpriseId(tx, ref) : null
  return id === null ? undefined : (await tx.select(subjectColumns).from(enterprise).where(eq(enterprise.id, id)))[0]
}

async function resolveMerge(tx: Tx, merge: RosterImportMerge, index: number) {
  const ref = `merge:${index}`
  const intoUscc = normalizeUscc(merge?.intoUscc)
  if (!intoUscc) return failure(ref, 'into_uscc_required', '归并缺少 intoUscc（规范行统代）', 'intoUscc')
  if (merge.sourceKind != null && !enterpriseAlias.sourceKind.enumValues.includes(merge.sourceKind)) {
    return failure(ref, 'alias_source_kind_unknown', `sourceKind 不在字典内：${String(merge.sourceKind)}`, 'sourceKind')
  }
  if (merge.canonicalName != null && !optionalText(merge.canonicalName)) {
    return failure(ref, 'canonical_name_invalid', 'canonicalName 必须是非空字符串（不给则不改名）', 'merges[].canonicalName')
  }
  const sourceRef = optionalInt(merge.sourceRefId)
  const queryId = optionalInt(merge.evidenceQueryId)
  if (sourceRef !== null && merge.sourceRelationRef != null) {
    return failure(ref, 'source_ref_conflict', '同时给了 sourceRefId 与 sourceRelationRef；请只给其一', 'merges[].sourceRelationRef')
  }
  if (queryId !== null && merge.evidenceQueryRef != null) {
    return failure(ref, 'evidence_ref_conflict', '同时给了 evidenceQueryId 与 evidenceQueryRef；请只给其一', 'merges[].evidenceQueryRef')
  }
  const relation = merge.sourceRelationRef == null ? null
    : await findPostgresImportRelation(tx, merge.sourceRelationRef, 'merges[].sourceRelationRef')
  if (relation && !relation.ok) return { ...relation, kind: 'merge', ref }
  const query = merge.evidenceQueryRef == null ? null
    : await findPostgresImportQuery(tx, merge.evidenceQueryRef, 'merges[].evidenceQueryRef')
  if (query && !query.ok) return { ...query, kind: 'merge', ref }
  const sourceRefId = relation?.value.id ?? sourceRef ?? 0
  const evidenceQueryId = query?.value.id ?? queryId
  const sourceId = optionalInt(merge.fromEnterpriseId)
  const sourceName = optionalText(merge.fromEnterpriseName)
  if (sourceId == null && !sourceName) {
    return failure(ref, 'merge_source_required', '归并缺少 fromEnterpriseId 或 fromEnterpriseName', 'fromEnterpriseId')
  }
  let from: Subject | undefined
  if (sourceId != null) {
    from = await subjectById(tx, sourceId)
    if (from && sourceName && normalizeName(sourceName) !== from.nameNorm) {
      return failure(ref, 'enterprise_selector_conflict', `enterpriseId=${sourceId} 的名称与给定 fromEnterpriseName 不一致`, 'fromEnterpriseName')
    }
  } else {
    const rows = await tx.select(subjectColumns).from(enterprise).where(and(eq(enterprise.nameNorm, normalizeName(sourceName)),
      notExists(tx.select({ id: enterpriseMerge.fromEnterpriseId }).from(enterpriseMerge)
        .where(eq(enterpriseMerge.fromEnterpriseId, enterprise.id))))).orderBy(enterprise.id)
    if (rows.length > 1) return failure(ref, 'enterprise_ambiguous', `同名企业有 ${rows.length} 个候选 ⇒ 不猜是哪一家`, 'fromEnterpriseName')
    from = rows[0]
  }
  if (!from) return failure(ref, 'merge_source_not_found', `被并企业不存在：${sourceId ?? sourceName}`, sourceId == null ? 'fromEnterpriseName' : 'fromEnterpriseId')

  const [holder] = await tx.select({ id: enterprise.id }).from(enterprise).where(eq(enterprise.usccNorm, intoUscc))
  const into = holder && await subjectById(tx, holder.id)
  if (!into) return failure(ref, 'merge_target_not_found', `规范行（统代 ${intoUscc}）不存在`, 'intoUscc')
  if (from.id === into.id) return failure(ref, 'merge_same_enterprise', '被并企业与规范行是同一行', 'fromEnterpriseId')
  return { from, into, sourceId, sourceName, intoUscc, sourceRefId, evidenceQueryId }
}

const targetDifference = alias(differenceReason, 'target_difference')
const sourceDifference = alias(differenceReason, 'source_difference')
const differenceScope = and(eq(differenceReason.titleCode, targetDifference.titleCode), eq(differenceReason.direction, targetDifference.direction))
const differencePair = and(differenceScope, eq(differenceReason.recordedAt, targetDifference.recordedAt))
const differenceFields = [
  'status', 'reasonCode', 'reasonNote', 'measureCode', 'measureNote', 'evidenceQueryId', 'evidenceRelationId',
  'movedInCity', 'movedInTitleCode', 'movedInYear', 'movedInBatch', 'verificationStatus',
] as const

async function mergeConflict(tx: Tx, from: number, into: number, ref: string) {
  const receipt = evidenceReviewReceipt114
  const managedReview = tx.select({ id: receipt.id }).from(receipt).where(and(
    or(eq(receipt.decisionId, differenceReason.id), eq(receipt.sourceDecisionId, differenceReason.id)),
    isNotNull(receipt.reviewedRevisionId)))
  const sourceScope = tx.select({ id: sourceDifference.id }).from(sourceDifference).where(and(
    eq(sourceDifference.enterpriseId, from), eq(sourceDifference.titleCode, differenceReason.titleCode),
    eq(sourceDifference.direction, differenceReason.direction)))
  const [managed] = await tx.select({ id: differenceReason.id, enterpriseId: differenceReason.enterpriseId,
    titleCode: differenceReason.titleCode, direction: differenceReason.direction }).from(differenceReason)
    .where(and(or(eq(differenceReason.enterpriseId, from), and(eq(differenceReason.enterpriseId, into), exists(sourceScope))),
      or(isNotNull(differenceReason.lifecycleAction), exists(managedReview))))
    .orderBy(desc(eq(differenceReason.enterpriseId, from)), differenceReason.id).limit(1)
  if (managed) {
    return failure(ref, 'merge_difference_lifecycle_conflict',
      `差异决定版本 ${managed.id}（企业 ${managed.enterpriseId}/${managed.titleCode}/${managed.direction}）已接管；归并须保留原 ID、历史和接管状态`, 'merges')
  }
  const aliasConflict = await findPostgresEnterpriseMergeAliasConflict(tx, from, into)
  if (aliasConflict) return failure(ref, aliasConflict.code, aliasConflict.message, 'merges')
  const distinct = or(...differenceFields.map(field => {
    const left = differenceReason[field], right = targetDifference[field]
    return or(ne(left, right), and(isNull(left), isNotNull(right)), and(isNotNull(left), isNull(right)))
  }))
  const [difference] = await tx.select({ titleCode: differenceReason.titleCode, direction: differenceReason.direction,
    recordedAt: differenceReason.recordedAt }).from(differenceReason)
    .innerJoin(targetDifference, and(eq(targetDifference.enterpriseId, into), differencePair))
    .where(and(eq(differenceReason.enterpriseId, from), distinct)).orderBy(differenceReason.id).limit(1)
  return difference ? failure(ref, 'merge_difference_conflict',
    `差异唯一键已存在但内容不同：${difference.titleCode}/${difference.direction}/${difference.recordedAt}`, 'merges') : null
}

export async function planPostgresRosterMerge(tx: Tx, merge: RosterImportMerge, index: number): Promise<{
  item: RosterImportItemResult; plan: PostgresRosterMergePlan | null
}> {
  const resolved = await resolveMerge(tx, merge, index)
  if ('ok' in resolved) return { item: resolved, plan: null }
  const { from, into, sourceId, sourceName, intoUscc } = resolved
  const conflict = await mergeConflict(tx, from.id, into.id, `merge:${index}`)
  if (conflict) return { item: conflict, plan: null }
  return {
    item: { ok: true, kind: 'merge', ref: `merge:${sourceId ?? sourceName}->${intoUscc}`,
      detail: { intoUscc, requestedCanonicalName: optionalText(merge.canonicalName) } },
    plan: { merge, index, sourceEnterpriseId: from.id, intoEnterpriseId: into.id },
  }
}

async function moveDifferences(tx: Tx, from: number, into: number) {
  const duplicates = tx.select({ id: targetDifference.id }).from(targetDifference)
    .where(and(eq(targetDifference.enterpriseId, into), differencePair))
  await tx.delete(differenceReason).where(and(eq(differenceReason.enterpriseId, from), exists(duplicates)))
  const { rowCount } = await tx.update(differenceReason).set({ enterpriseId: into, retiredEvidenceValidity: null, retiredEvidenceReviewed: null }).where(eq(differenceReason.enterpriseId, from))
  return rowCount ?? 0
}

async function appendMergeAssignments(tx: Tx, from: number, into: number, basis: string, recordedAt: string) {
  const assignment = platformObservationAssignment
  const later = alias(assignment, 'later')
  const newer = tx.select({ revision: later.revision }).from(later)
    .where(and(eq(later.observationId, assignment.observationId), gt(later.revision, assignment.revision)))
  const { rowCount } = await tx.insert(assignment).select(tx.select({
    observationId: assignment.observationId,
    // Drizzle has no arithmetic expression builder. All command values are bound.
    revision: sql<number>`${assignment.revision} + 1`.as('revision'),
    enterpriseId: sql<number>`${into}`.as('enterprise_id'),
    usccRaw: assignment.usccRaw,
    nameRaw: assignment.nameRaw,
    matchBasis: assignment.matchBasis,
    verificationStatus: assignment.verificationStatus,
    aliasNameRaw: assignment.aliasNameRaw,
    actor: sql<null>`${null}`.as('actor'),
    basis: sql<string>`${basis}`.as('basis'),
    commandReceiptId: sql<null>`${null}`.as('command_receipt_id'),
    recordedAt: sql<string>`${recordedAt}`.as('recorded_at'),
    origin: sql<string>`${'command'}`.as('origin'),
  }).from(assignment).where(and(eq(assignment.enterpriseId, from), notExists(newer))).orderBy(assignment.observationId))
  return rowCount ?? 0
}

async function moveRecords(tx: Tx, from: number, into: number) {
  const source = alias(record, 'source_record')
  const survivor = alias(record, 'survivor')
  const records = await tx.select({ snapshot: source, survivorId: survivor.id }).from(source)
    .leftJoin(survivor, and(eq(survivor.enterpriseId, into), eq(survivor.titleCode, source.titleCode), eq(survivor.source, source.source)))
    .where(eq(source.enterpriseId, from)).orderBy(source.id).for('update', { of: source })
  const recordsMoved: number[] = []
  const recordsFolded: MergeLineage['recordsFolded'] = []
  const eventsMoved: number[] = []
  const evidenceMoved: number[] = []
  for (const { snapshot: row, survivorId } of records) {
    const snapshot = { ...row, qualityFlags: row.qualityFlags === null ? null : JSON.parse(row.qualityFlags) as string[] }
    const events = await tx.select({ id: recordEvent.id }).from(recordEvent).where(eq(recordEvent.recordId, snapshot.id))
      .orderBy(recordEvent.id).for('update')
    const evidence = await tx.select({ id: recordEvidence.id }).from(recordEvidence)
      .innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
      .where(eq(recordEvent.recordId, snapshot.id)).orderBy(recordEvent.id, recordEvidence.id)
    const eventIds = events.map(event => event.id)
    eventsMoved.push(...eventIds)
    evidenceMoved.push(...evidence.map(row => row.id))
    if (survivorId !== null) {
      await tx.update(recordEvent).set({ recordId: survivorId }).where(eq(recordEvent.recordId, snapshot.id))
      await tx.delete(record).where(eq(record.id, snapshot.id))
      recordsFolded.push({ fromRecordId: snapshot.id, intoRecordId: survivorId, fromRecordSnapshot: snapshot, eventIds })
    } else {
      await tx.update(record).set({ enterpriseId: into }).where(eq(record.id, snapshot.id))
      recordsMoved.push(snapshot.id)
    }
  }
  return { recordsMoved, recordsFolded, eventsMoved, evidenceMoved }
}

export async function applyPostgresRosterMerge(tx: Tx, plan: PostgresRosterMergePlan): Promise<RosterImportItemResult> {
  const { merge, sourceEnterpriseId, intoEnterpriseId } = plan
  const ref = `merge:${sourceEnterpriseId}->${intoEnterpriseId}`
  const requestedName = optionalText(merge.canonicalName)
  await lockPostgresReviewedEnterpriseBatch(tx, [sourceEnterpriseId, intoEnterpriseId],
    requestedName ? [{ name: requestedName }] : [])
  const resolved = await resolveMerge(tx, merge, plan.index)
  if ('ok' in resolved) return resolved
  const { from, into, sourceRefId, evidenceQueryId } = resolved
  if (from.id !== sourceEnterpriseId || into.id !== intoEnterpriseId) {
    return failure(ref, 'merge_identity_changed', '归并主体已变更，请重新预检', 'merges')
  }
  const conflict = await mergeConflict(tx, from.id, into.id, ref)
  if (conflict) return conflict

  const canonicalName = requestedName ?? into.name
  const sourceKind = merge.sourceKind ?? 'manual'
  const note = optionalText(merge.note)
  const renamedFrom = canonicalName !== into.name ? into.name : null
  const renameNote = `主名称改为「${canonicalName}」（导出表侧）后被顶掉的原名`
  const aliasName = optionalText(merge.aliasName) ?? from.name
  const basis = note ?? ref
  const applied = await applyPostgresEnterpriseMerge(tx, {
    fromEnterpriseId: from.id,
    intoEnterpriseId: into.id,
    rename: renamedFrom === null ? null : {
      from: renamedFrom, to: canonicalName, note: note ? `${renameNote}；${note}` : renameNote,
    },
    sourceAlias: aliasName === canonicalName ? null : {
      name: aliasName, note: note ?? `归并自 enterprise:${from.id}（${from.name}）`,
    },
    sourceKind, sourceRefId, basis,
  })
  if (!applied.ok) return failure(ref, applied.error.code, applied.error.message, 'merges')
  const { alias, renameAlias, aliasesMoved, recordedAt } = applied
  const differences = await moveDifferences(tx, from.id, into.id)
  const relations = await appendMergeAssignments(tx, from.id, into.id, basis, recordedAt)
  const records = await moveRecords(tx, from.id, into.id)
  await tx.update(recordCorrespondence).set({ enterpriseId: into.id }).where(eq(recordCorrespondence.enterpriseId, from.id))

  const lineage: MergeLineage = {
    fromEnterpriseId: from.id, fromEnterpriseName: from.name, intoEnterpriseId: into.id, intoUscc: into.uscc ?? '',
    canonicalName, rename: renamedFrom === null ? null : { from: renamedFrom, to: canonicalName, aliasId: renameAlias.id },
    aliasId: alias.id, evidenceQueryId,
    childRowsMoved: { aliases: aliasesMoved, differences, relations, records: records.recordsMoved.length + records.recordsFolded.length },
    ...records,
  }
  return { ok: true, kind: 'merge', ref, detail: { lineage, rowsWritten: Number(alias.created) + Number(renameAlias.created) } }
}
