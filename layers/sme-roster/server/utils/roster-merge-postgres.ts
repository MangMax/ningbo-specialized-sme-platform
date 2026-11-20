import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterpriseAlias, record } from '../../../../db/schema'
import { applyPostgresEnterpriseMerge, findPostgresEnterpriseMergeAliasConflict, lockPostgresReviewedEnterpriseBatch, postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import type { RosterImportItemResult, RosterImportMerge } from '../../lib/roster-import-client'
import { managedDecision102 } from './decision-lifecycle-102'
import { evidenceDigest113 } from './evidence-impact-113'
import { appendPostgresEvidenceRevision } from './evidence-revision-postgres'
import { readPostgresIdentityMaterial } from './postgres-identity-evidence'
import type { MergeLineage } from './roster-import'
import { findPostgresImportQuery, findPostgresImportRelation } from './roster-import-references-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Subject = { id: number; name: string; nameNorm: string; uscc: string | null }
const subjectColumns = sql`e.id::float8 AS id,e.name,e.name_norm AS "nameNorm",e.uscc_norm AS uscc`

export interface PostgresRosterMergePlan {
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
  return id === null ? undefined : (await tx.execute<Subject>(sql`
    SELECT ${subjectColumns} FROM enterprise e WHERE e.id=${id}`)).rows[0]
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
    const { rows } = await tx.execute<Subject>(sql`
      SELECT ${subjectColumns} FROM enterprise e WHERE e.name_norm=${normalizeName(sourceName)}
      AND NOT EXISTS (SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=e.id) ORDER BY e.id`)
    if (rows.length > 1) return failure(ref, 'enterprise_ambiguous', `同名企业有 ${rows.length} 个候选 ⇒ 不猜是哪一家`, 'fromEnterpriseName')
    from = rows[0]
  }
  if (!from) return failure(ref, 'merge_source_not_found', `被并企业不存在：${sourceId ?? sourceName}`, sourceId == null ? 'fromEnterpriseName' : 'fromEnterpriseId')

  const { rows: [holder] } = await tx.execute<{ id: number }>(sql`SELECT id::float8 AS id FROM enterprise WHERE uscc_norm=${intoUscc}`)
  const into = holder && await subjectById(tx, holder.id)
  if (!into) return failure(ref, 'merge_target_not_found', `规范行（统代 ${intoUscc}）不存在`, 'intoUscc')
  if (from.id === into.id) return failure(ref, 'merge_same_enterprise', '被并企业与规范行是同一行', 'fromEnterpriseId')
  return { from, into, sourceId, sourceName, intoUscc, sourceRefId, evidenceQueryId }
}

const differencePair = sql`(a.title_code,a.direction,a.recorded_at)=(b.title_code,b.direction,b.recorded_at)`
const differenceContent = (alias: string) => sql`ROW(${sql.join([
  'status', 'reason_code', 'reason_note', 'measure_code', 'measure_note', 'evidence_query_id', 'evidence_relation_id',
  'moved_in_city', 'moved_in_title_code', 'moved_in_year', 'moved_in_batch', 'verification_status',
].map(column => sql`${sql.identifier(alias)}.${sql.identifier(column)}`), sql`,`)})`

async function mergeConflict(tx: Tx, from: number, into: number, ref: string) {
  const { rows: [managed] } = await tx.execute<{ id: string; enterpriseId: string; titleCode: string; direction: string }>(sql`
    SELECT d.id,d.enterprise_id AS "enterpriseId",d.title_code AS "titleCode",d.direction
    FROM difference_reason d WHERE (d.enterprise_id=${from} OR (d.enterprise_id=${into} AND EXISTS(
      SELECT 1 FROM difference_reason a WHERE a.enterprise_id=${from} AND (a.title_code,a.direction)=(d.title_code,d.direction))))
      AND ${managedDecision102(sql`d.id`, sql`d.lifecycle_action`)}
    ORDER BY (d.enterprise_id=${from}) DESC,d.id LIMIT 1`)
  if (managed) {
    return failure(ref, 'merge_difference_lifecycle_conflict',
      `差异决定版本 ${managed.id}（企业 ${managed.enterpriseId}/${managed.titleCode}/${managed.direction}）已接管；归并须保留原 ID、历史和接管状态`, 'merges')
  }
  const alias = await findPostgresEnterpriseMergeAliasConflict(tx, from, into)
  if (alias) return failure(ref, alias.code, alias.message, 'merges')
  const { rows: [difference] } = await tx.execute<{ titleCode: string; direction: string; recordedAt: string }>(sql`
    SELECT a.title_code AS "titleCode",a.direction,a.recorded_at AS "recordedAt"
    FROM difference_reason a JOIN difference_reason b ON b.enterprise_id=${into} AND ${differencePair}
    WHERE a.enterprise_id=${from} AND ${differenceContent('a')} IS DISTINCT FROM ${differenceContent('b')}
    ORDER BY a.id LIMIT 1`)
  return difference ? failure(ref, 'merge_difference_conflict',
    `差异唯一键已存在但内容不同：${difference.titleCode}/${difference.direction}/${difference.recordedAt}`, 'merges') : null
}

/** Plan against rows visible on the caller's connection, including its staged import writes. */
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
  await tx.execute(sql`
    DELETE FROM difference_reason a USING difference_reason b
    WHERE a.enterprise_id=${from} AND b.enterprise_id=${into} AND ${differencePair}`)
  const { rowCount } = await tx.execute(sql`UPDATE difference_reason SET enterprise_id=${into} WHERE enterprise_id=${from}`)
  return rowCount ?? 0
}

async function appendMergeAssignments(tx: Tx, from: number, into: number, basis: string, recordedAt: string) {
  const { rowCount } = await tx.execute(sql`
    INSERT INTO platform_observation_assignment (observation_id,revision,enterprise_id,match_basis,verification_status,
      uscc_raw,name_raw,alias_name_raw,basis,recorded_at,origin)
    SELECT a.observation_id,a.revision+1,${into},a.match_basis,a.verification_status,
      a.uscc_raw,a.name_raw,a.alias_name_raw,${basis},${recordedAt},'command'
    FROM platform_observation_assignment a WHERE a.enterprise_id=${from}
      AND NOT EXISTS (SELECT 1 FROM platform_observation_assignment later
        WHERE later.observation_id=a.observation_id AND later.revision>a.revision)
    ORDER BY a.observation_id`)
  return rowCount ?? 0
}

async function moveRecords(tx: Tx, from: number, into: number) {
  const { rows: records } = await tx.execute<{ snapshot: typeof record.$inferSelect; survivorId: number | null }>(sql`
    SELECT ${postgresRosterRow(record, 'r')} AS snapshot,survivor.id::float8 AS "survivorId"
    FROM record r LEFT JOIN record survivor
      ON survivor.enterprise_id=${into} AND (survivor.title_code,survivor.source)=(r.title_code,r.source)
    WHERE r.enterprise_id=${from} ORDER BY r.id FOR UPDATE OF r`)
  const recordsMoved: number[] = []
  const recordsFolded: MergeLineage['recordsFolded'] = []
  const eventsMoved: number[] = []
  const evidenceMoved: number[] = []
  for (const { snapshot, survivorId } of records) {
    const { rows: events } = await tx.execute<{ id: number }>(sql`
      SELECT id::float8 AS id FROM record_event WHERE record_id=${snapshot.id} ORDER BY id FOR UPDATE`)
    const { rows: evidence } = await tx.execute<{ id: number }>(sql`
      SELECT v.id::float8 AS id FROM record_evidence v JOIN record_event e ON e.id=v.record_event_id
      WHERE e.record_id=${snapshot.id} ORDER BY e.id,v.id`)
    const eventIds = events.map(event => event.id)
    eventsMoved.push(...eventIds)
    evidenceMoved.push(...evidence.map(row => row.id))
    if (survivorId !== null) {
      await tx.execute(sql`UPDATE record_event SET record_id=${survivorId} WHERE record_id=${snapshot.id}`)
      await tx.execute(sql`DELETE FROM record WHERE id=${snapshot.id}`)
      recordsFolded.push({ fromRecordId: snapshot.id, intoRecordId: survivorId, fromRecordSnapshot: snapshot, eventIds })
    } else {
      await tx.execute(sql`UPDATE record SET enterprise_id=${into} WHERE id=${snapshot.id}`)
      recordsMoved.push(snapshot.id)
    }
  }
  return { recordsMoved, recordsFolded, eventsMoved, evidenceMoved }
}

async function captureMergeIdentity(tx: Tx, from: number, into: number, before: string) {
  const after = await readPostgresIdentityMaterial(tx, into)
  const revisionId = await appendPostgresEvidenceRevision(tx, {
    sourceKind: 'identity', sourceKey: `merge:${from}:${into}`, sourceVersion: '1', enterpriseId: into,
    beforeFactDigest: evidenceDigest113({ identity: before, from }),
    factDigest: evidenceDigest113({ identity: after, merged: from }), metadata: { fromEnterpriseId: from },
  })
  if (revisionId === null) return
  await tx.execute(sql`
    INSERT INTO evidence_revision_event_113 (revision_id,event_id,enterprise_id,title_code)
    SELECT ${revisionId},e.id,r.enterprise_id,r.title_code FROM record r JOIN record_event e ON e.record_id=r.id
    WHERE r.enterprise_id=${into} ON CONFLICT DO NOTHING`)
}

/** Apply on the caller's transaction. The caller owns batch rollback and the receipt. */
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

  const identityBefore = await readPostgresIdentityMaterial(tx, into.id)
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
  await tx.execute(sql`UPDATE record_correspondence SET enterprise_id=${into.id} WHERE enterprise_id=${from.id}`)
  await captureMergeIdentity(tx, from.id, into.id, identityBefore)

  const lineage: MergeLineage = {
    fromEnterpriseId: from.id, fromEnterpriseName: from.name, intoEnterpriseId: into.id, intoUscc: into.uscc ?? '',
    canonicalName, rename: renamedFrom === null ? null : { from: renamedFrom, to: canonicalName, aliasId: renameAlias.id },
    aliasId: alias.id, evidenceQueryId,
    childRowsMoved: { aliases: aliasesMoved, differences, relations, records: records.recordsMoved.length + records.recordsFolded.length },
    ...records,
  }
  return { ok: true, kind: 'merge', ref, detail: { lineage, rowsWritten: Number(alias.created) + Number(renameAlias.created) } }
}
