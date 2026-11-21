import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { lockPostgresReviewedEnterpriseBatch, postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeUscc } from '../../lib/domain'
import {
  aliasDecisionSchema, aliasListInput, aliasPageInput, boundedAliasPage, decideEnterpriseAlias, failAlias, parseAliasInput, positiveAliasId,
} from './alias-maintenance'
import { capturePostgresIdentityChange, readPostgresIdentityMaterial } from './postgres-identity-evidence'

type Db = NodePgDatabase
type Alias = Parameters<typeof decideEnterpriseAlias>[0]
const aliasJson = sql`json_build_object(
  'id',id,'enterpriseId',enterprise_id,'version',version,
  'originalName',coalesce(original_name,name),'originalSourceKind',coalesce(original_source_kind,source_kind),
  'originalSourceRefId',coalesce(original_source_ref_id,source_ref_id),'name',name,'nameNorm',name_norm,
  'sourceKind',source_kind,'sourceRefId',source_ref_id,'validFrom',valid_from,'validTo',valid_to,
  'verificationStatus',verification_status,'note',note,'createdAt',created_at)`
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

async function enterprise(db: Db, rawId: unknown) {
  const requested = parseAliasInput(positiveAliasId, rawId)
  const id = await postgresCanonicalEnterpriseId(db, requested)
  if (id === null) return failAlias(404, 'enterprise_not_found', '企业不存在')
  return { id, requested }
}

async function readAlias(db: Db, enterpriseId: number, aliasId: unknown) {
  const id = parseAliasInput(positiveAliasId, aliasId)
  const { rows: [row] } = await db.execute<{ alias: Alias }>(sql`
    SELECT ${aliasJson} AS alias FROM enterprise_alias WHERE id = ${id} AND enterprise_id = ${enterpriseId}`)
  return row?.alias ?? failAlias(404, 'alias_not_found', '该企业没有此别名')
}

export function getPostgresEnterpriseAlias(db: Db, enterpriseId: unknown, aliasId: unknown) {
  return db.transaction(async tx => readAlias(tx, (await enterprise(tx, enterpriseId)).id, aliasId), snapshot)
}

export function listPostgresEnterpriseAliases(db: Db, enterpriseId: unknown, input: unknown) {
  return db.transaction(async tx => {
    const { id } = await enterprise(tx, enterpriseId)
    const { page, pageSize, status } = parseAliasInput(z.strictObject(aliasListInput), input)
    const scope = sql`FROM enterprise_alias WHERE enterprise_id = ${id}
      ${status === 'all' ? sql.empty() : sql`AND verification_status = ${status}`}`
    const { rows: [count] } = await tx.execute<{ total: string }>(sql`SELECT count(*) AS total ${scope}`)
    const { rows } = await tx.execute<{ alias: Alias }>(sql`
      SELECT ${aliasJson} AS alias ${scope} ORDER BY id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
    return boundedAliasPage({ page, pageSize, total: Number(count!.total), rows: rows.map(row => row.alias) })
  }, snapshot)
}

export function getPostgresEnterpriseAliasHistory(db: Db, enterpriseId: unknown, aliasId: unknown, input: unknown) {
  return db.transaction(async tx => {
    const alias = await readAlias(tx, (await enterprise(tx, enterpriseId)).id, aliasId)
    const { page, pageSize } = parseAliasInput(z.strictObject(aliasPageInput), input)
    const scope = sql`FROM enterprise_alias_audit WHERE alias_id = ${alias.id}`
    const { rows: [count] } = await tx.execute<{ total: string }>(sql`SELECT count(*) AS total ${scope}`)
    const { rows } = await tx.execute<{ audit: Record<string, unknown> }>(sql`
      SELECT json_build_object('id',id,'aliasId',alias_id,'enterpriseId',enterprise_id,'action',action,
        'actor',actor,'basis',basis,'idempotencyKey',idempotency_key,'requestHash',request_hash,
        'before',before::json,'after',after::json,'createdAt',created_at) AS audit
      ${scope} ORDER BY id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
    return boundedAliasPage({ page, pageSize, total: Number(count!.total), rows: rows.map(row => row.audit) })
  }, snapshot)
}

async function checkSource(db: Db, alias: Alias) {
  const { sourceKind, sourceRefId, enterpriseId, name } = alias
  if (sourceKind === 'manual') {
    if (sourceRefId !== 0) failAlias(400, 'alias_source_evidence_mismatch', '人工依据使用basis，不接受来源行ID')
    return
  }
  if (sourceKind === 'announcement') {
    const { rows } = await db.execute(sql`
      SELECT 1 FROM record_evidence v
      JOIN record_event e ON e.id = v.record_event_id JOIN record r ON r.id = e.record_id
      JOIN source_document d ON d.path = v.source_file
      WHERE d.id = ${sourceRefId} AND d.source = 'jxj' AND r.enterprise_id = ${enterpriseId} AND r.name_raw = ${name} LIMIT 1`)
    if (!rows.length) failAlias(400, 'alias_source_evidence_mismatch', '公布文件ID必须由该企业同原名称的记录出处支持')
    return
  }
  const { rows: [source] } = await db.execute<{ interface: string; enterpriseId: string | null; uscc: string | null;
    originalUscc: string | null; originalName: string | null }>(sql`
    SELECT c.interface, latest.enterprise_id AS "enterpriseId", e.uscc_norm AS uscc,
      original.uscc_raw AS "originalUscc", original.name_raw AS "originalName"
    FROM platform_legacy_relation_alias a JOIN platform_business_observation o ON o.id = a.observation_id
    JOIN platform_collection c ON c.id = o.collection_id JOIN enterprise e ON e.id = ${enterpriseId}
    JOIN platform_observation_assignment original ON original.observation_id = o.id AND original.revision = 1
    JOIN LATERAL (SELECT enterprise_id FROM platform_observation_assignment
      WHERE observation_id = o.id ORDER BY revision DESC LIMIT 1) latest ON true
    WHERE a.old_id = ${sourceRefId}`)
  if (!source) return failAlias(400, 'alias_source_evidence_required', '平台别名必须引用真实平台关系')
  const expectedInterface = sourceKind === 'platform_business' ? 'business_list' : 'apply_list'
  if (source.interface !== expectedInterface || !source.uscc || normalizeUscc(source.originalUscc) !== source.uscc || source.originalName !== name) {
    failAlias(400, 'alias_source_evidence_mismatch', '平台关系的接口、统一社会信用代码或 qymc 与该别名不一致')
  }
  if (source.enterpriseId !== null && await postgresCanonicalEnterpriseId(db, Number(source.enterpriseId)) !== enterpriseId) {
    failAlias(400, 'alias_source_evidence_mismatch', '平台关系已归属的企业与该别名归属企业不一致')
  }
}

async function checkConflict(db: Db, alias: Alias) {
  const { nameNorm, enterpriseId, sourceKind, sourceRefId, id } = alias
  if (alias.verificationStatus === 'confirmed') {
    const { rows } = await db.execute(sql`
      SELECT 1 FROM enterprise e WHERE e.id <> ${enterpriseId} AND e.name_norm = ${nameNorm}
        AND NOT EXISTS (SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id = e.id)
      UNION ALL
      SELECT 1 FROM enterprise_alias WHERE enterprise_id <> ${enterpriseId} AND name_norm = ${nameNorm}
        AND verification_status = 'confirmed' LIMIT 1`)
    if (rows.length) failAlias(409, 'alias_subject_conflict', '该名称已由其他企业使用，不能自动确认归属')
  }
  const { rows } = await db.execute(sql`
    SELECT 1 FROM enterprise_alias WHERE id <> ${id} AND enterprise_id = ${enterpriseId} AND name_norm = ${nameNorm}
      AND source_kind = ${sourceKind} AND source_ref_id = ${sourceRefId} LIMIT 1`)
  if (rows.length) failAlias(409, 'alias_identity_conflict', '更正后的自然键已有别名，请维护其稳定ID')
}

export function maintainPostgresEnterpriseAlias(db: Db, enterpriseId: unknown, aliasId: unknown, input: unknown) {
  if (process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1') failAlias(503, 'write_unavailable', 'PostgreSQL 企业别名处于只读模式')
  const request = parseAliasInput(aliasDecisionSchema, input)
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  return db.transaction(async tx => {
    const { id: owner, requested } = await enterprise(tx, enterpriseId)
    await tx.execute(sql`SELECT id FROM enterprise WHERE id = ${owner} FOR UPDATE`)
    if (owner !== await postgresCanonicalEnterpriseId(tx, requested)) failAlias(409, 'alias_version_conflict', '别名版本已改变，请重新读取')
    const before = await readAlias(tx, owner, aliasId)
    const { rows: [prior] } = await tx.execute<{ hash: string; alias: Alias }>(sql`
      SELECT request_hash AS hash, after::json AS alias FROM enterprise_alias_audit
      WHERE alias_id = ${before.id} AND idempotency_key = ${request.idempotencyKey}`)
    if (prior) {
      if (prior.hash !== requestHash) failAlias(409, 'alias_idempotency_conflict', '同一幂等键载荷不同')
      return { alias: prior.alias, replayed: true }
    }
    const next = decideEnterpriseAlias(before, request)
    if (request.action !== 'withdraw') {
      await lockPostgresReviewedEnterpriseBatch(tx, [owner], [{ name: before.name }, { name: next.name }])
      await checkSource(tx, next)
      await checkConflict(tx, next)
    }
    const identity = await readPostgresIdentityMaterial(tx, owner)
    const { rows: [updated] } = await tx.execute<{ alias: Alias }>(sql`
      UPDATE enterprise_alias SET name = ${next.name}, name_norm = ${next.nameNorm}, source_kind = ${next.sourceKind},
        source_ref_id = ${next.sourceRefId}, valid_from = ${next.validFrom}, valid_to = ${next.validTo}, note = ${next.note},
        verification_status = ${next.verificationStatus}, version = version + 1, original_name = ${before.originalName},
        original_source_kind = ${before.originalSourceKind}, original_source_ref_id = ${before.originalSourceRefId}
      WHERE id = ${before.id} AND version = ${request.expectedVersion} RETURNING ${aliasJson} AS alias`)
    if (!updated) return failAlias(409, 'alias_version_conflict', '别名版本已改变')
    await tx.execute(sql`
      INSERT INTO enterprise_alias_audit (alias_id,enterprise_id,action,actor,basis,idempotency_key,request_hash,before,after,created_at)
      VALUES (${before.id},${owner},${request.action},${request.actor},${request.basis},${request.idempotencyKey},${requestHash},
        ${JSON.stringify(before)},${JSON.stringify(updated.alias)},${new Date().toISOString()})`)
    await capturePostgresIdentityChange(tx, owner, `alias:${before.id}:${updated.alias.version}`, identity)
    return { alias: updated.alias, replayed: false }
  })
}
