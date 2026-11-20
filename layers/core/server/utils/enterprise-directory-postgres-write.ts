import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { normalizeEnterpriseName } from '../../lib/enterprise-name'
import { normalizeReviewedUscc } from '../../lib/enterprise-uscc'
import { EnterpriseKernelError, enterpriseProfileVersion, type EnterpriseFields, type EnterpriseProfile, type EnterpriseSource, type ReviewedSubject, type enterpriseDetailsSchema } from './enterprise-kernel'
import { readPostgresEnterpriseDetails } from './enterprise-directory-postgres'
import type { z } from 'zod'

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Codes = Pick<EnterpriseFields, 'districtCode' | 'townshipCode' | 'industryCode'>

function conflict(code: string, message: string): never {
  throw new EnterpriseKernelError(409, code, message)
}

async function validateCodes(tx: Transaction, { districtCode, townshipCode, industryCode }: Codes) {
  if (!districtCode && !townshipCode && !industryCode) return
  const { rows } = await tx.execute<{ district: boolean; township: boolean; industry: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM enterprise_region WHERE code = ${districtCode ?? null} AND level = 2) AS district,
           EXISTS (SELECT 1 FROM enterprise_region WHERE code = ${townshipCode ?? null} AND level = 3
                   AND parent_code = ${districtCode ?? null}) AS township,
           EXISTS (SELECT 1 FROM enterprise_industry WHERE code = ${industryCode ?? null} AND level = 3) AS industry`)
  const valid = rows[0]!
  if (districtCode && !valid.district) conflict('unknown_district', 'District code is absent from the supplied dictionary')
  if (townshipCode && !valid.township) conflict('township_district_mismatch', 'Township code must belong to the selected district')
  if (industryCode && !valid.industry) conflict('unknown_industry', 'Industry detail code is absent from the supplied dictionary')
}

async function checkedEnterprise(tx: Transaction, id: number, revision: number, operation: 'details' | 'membership') {
  await tx.execute(sql`SELECT id FROM enterprise WHERE id = ${id} FOR UPDATE`)
  const before = await readPostgresEnterpriseDetails(tx, id)
  if (!before) {
    throw new EnterpriseKernelError(404, 'enterprise_not_found', operation === 'details' ? '未找到企业。' : 'Enterprise not found')
  }
  if (before.mergedInto !== null || before.revision !== revision) {
    conflict('enterprise_changed', operation === 'details'
      ? '企业资料已变更，请重新打开后再编辑。'
      : 'Enterprise target or revision changed')
  }
  return before
}

async function saveCodes(tx: Transaction, id: number, revision: number, fields: Codes) {
  await tx.execute(sql`INSERT INTO enterprise_directory (enterprise_id, district_code, township_code, industry_code, revision)
    VALUES (${id}, ${fields.districtCode ?? null}, ${fields.townshipCode ?? null}, ${fields.industryCode ?? null}, ${revision})
    ON CONFLICT (enterprise_id) DO UPDATE SET district_code = excluded.district_code, township_code = excluded.township_code,
      industry_code = excluded.industry_code, revision = excluded.revision`)
}

async function matchingUsccExists(tx: Transaction, uscc: string, exceptId: number | null = null) {
  const { rows } = await tx.execute<{ uscc: string }>(sql`SELECT uscc_norm AS uscc FROM enterprise
    WHERE id IS DISTINCT FROM ${exceptId} AND (uscc_norm = ${uscc} OR uscc_norm COLLATE "C" ~ '[^A-Z0-9]')`)
  return rows.some(row => normalizeReviewedUscc(row.uscc) === uscc)
}

function lockIdentity(tx: Transaction, kind: 'name' | 'uscc', value: string) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`enterprise:${kind}:${value}`}, 0))`)
}

export async function lockPostgresReviewedEnterpriseBatch(
  tx: Transaction,
  enterpriseIds: readonly number[],
  fields: readonly EnterpriseFields[],
) {
  const names = new Set(fields.flatMap(field => field.name === undefined ? [] : [normalizeEnterpriseName(field.name)]))
  if (enterpriseIds.length) {
    const { rows } = await tx.execute<{ name: string }>(sql`SELECT name FROM enterprise
      WHERE id IN (${sql.join(enterpriseIds.map(id => sql`${id}`), sql`, `)})
      ORDER BY id FOR UPDATE`)
    if (names.size) for (const row of rows) names.add(normalizeEnterpriseName(row.name))
  }
  const codes = new Set(fields.flatMap(field => field.uscc ? [field.uscc] : []))
  for (const name of [...names].sort()) await lockIdentity(tx, 'name', name)
  for (const code of [...codes].sort()) await lockIdentity(tx, 'uscc', code)
}

export async function registerPostgresEnterpriseSource(tx: Transaction, input: EnterpriseSource, enterpriseIds: readonly number[]) {
  const { module, businessTable, versionKey, channel, listType, acquiredOn, series, fileId, sha256 } = input
  const { rows } = await tx.execute<{ id: string }>(sql`INSERT INTO enterprise_source
    (module, business_table, version_key, channel_code, list_type_code, acquired_on, series, file_id, sha256)
    VALUES (${module}, ${businessTable}, ${versionKey}, ${channel}, ${listType}, ${acquiredOn}, ${series}, ${fileId}, ${sha256})
    ON CONFLICT (module, business_table, version_key) DO NOTHING RETURNING id`)
  let id = rows[0]?.id
  if (id === undefined) {
    const prior = await tx.execute<{ id: string; channel: string; listType: string; series: string; sha256: string | null }>(sql`
      SELECT id, channel_code AS channel, list_type_code AS "listType", series, sha256
      FROM enterprise_source
      WHERE module = ${module} AND business_table = ${businessTable} AND version_key = ${versionKey}`)
    const existing = prior.rows[0]
    if (!existing || existing.channel !== channel || existing.listType !== listType
      || existing.series !== series || existing.sha256 !== sha256) {
      conflict('source_conflict', 'This source version already has different provenance')
    }
    id = existing.id
  }
  if (enterpriseIds.length) {
    await tx.execute(sql`INSERT INTO enterprise_source_link (enterprise_id, source_id)
      VALUES ${sql.join(enterpriseIds.map(enterpriseId => sql`(${enterpriseId}, ${id})`), sql`, `)}
      ON CONFLICT DO NOTHING`)
  }
  return Number(id)
}

/** Create a reviewed subject inside the caller's transaction, with provenance supplied by the caller. */
export async function createPostgresReviewedEnterprise(tx: Transaction, fields: EnterpriseFields & { name: string }) {
  await validateCodes(tx, fields)
  const name = normalizeEnterpriseName(fields.name)
  const uscc = fields.uscc ?? null
  // Serialize matching submissions, including legacy rows whose stored codes are not normalized.
  await lockIdentity(tx, 'name', name)
  if (uscc) await lockIdentity(tx, 'uscc', uscc)
  const exists = uscc
    ? await matchingUsccExists(tx, uscc)
    : (await tx.execute(sql`SELECT id FROM enterprise WHERE name_norm = ${name} LIMIT 1`)).rows.length > 0
  if (exists) {
    conflict('existing_subject', 'A matching identity already exists; confirm an enterprise ID')
  }
  const inserted = await tx.execute<{ id: string }>(sql`INSERT INTO enterprise (name, name_norm, uscc_norm, quality_flags)
    VALUES (${fields.name}, ${name}, ${uscc}, ${JSON.stringify(uscc ? [] : ['uscc_missing'])}) RETURNING id`)
  const id = Number(inserted.rows[0]!.id)
  await saveCodes(tx, id, 1, fields)
  return id
}

async function retainPostgresPreviousName(tx: Transaction, profile: EnterpriseProfile, nameNorm: string, idempotencyKey: string) {
  const { enterpriseId: id, name } = profile
  const oldNorm = normalizeEnterpriseName(name)
  if (!nameNorm || !oldNorm) throw new EnterpriseKernelError(422, 'invalid_name', 'Normalized enterprise name must not be empty')
  const owner = await tx.execute(sql`
    SELECT e.id FROM enterprise e WHERE e.id <> ${id} AND e.name_norm IN (${oldNorm}, ${nameNorm})
      AND NOT EXISTS (SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id = e.id)
    UNION ALL
    SELECT id FROM enterprise_alias WHERE enterprise_id <> ${id} AND name_norm IN (${oldNorm}, ${nameNorm})
      AND verification_status = 'confirmed'
    LIMIT 1`)
  if (owner.rows.length) conflict('identity_conflict', 'Name belongs to another enterprise; use the identity operation')
  const { rows } = await tx.execute<{ id: string; status: string }>(sql`
    SELECT id, verification_status AS status FROM enterprise_alias WHERE enterprise_id = ${id} AND name_norm = ${oldNorm}
      AND (verification_status = 'confirmed' OR (source_kind = 'manual' AND source_ref_id = 0))
    ORDER BY (verification_status = 'confirmed') DESC, id LIMIT 1`)
  const existing = rows[0]
  if (existing?.status === 'confirmed') return { id: existing.id, created: 0 }
  if (existing) conflict('alias_lifecycle_required', 'Previous-name record is not confirmed; confirm or restore it through alias lifecycle first')
  const alias = await tx.execute<{ id: string }>(sql`INSERT INTO enterprise_alias
    (enterprise_id, name, name_norm, source_kind, source_ref_id, verification_status, note, created_at)
    VALUES (${id}, ${name}, ${oldNorm}, 'manual', 0, 'confirmed', ${`Enterprise profile rename: ${idempotencyKey}`},
      ${new Date().toISOString()}) RETURNING id`)
  return { id: alias.rows[0]!.id, created: 1 }
}

type ReviewedAttachment = Extract<ReviewedSubject, { action: 'attach' }>

async function revisePostgresReviewedProfile(tx: Transaction, before: NonNullable<Awaited<ReturnType<typeof readPostgresEnterpriseDetails>>>,
  next: typeof before, audit: ReviewedAttachment['audit']) {
  const renamed = next.name !== before.name
  const usccChanged = next.uscc !== before.uscc
  if (!renamed && !usccChanged) return null
  const { id, name, city, district, uscc } = before
  const { rows: [state] } = await tx.execute<{ nameNorm: string; qualityFlags: string | null; lastWrite: string | null }>(sql`
    SELECT name_norm AS "nameNorm", quality_flags AS "qualityFlags",
      (SELECT idempotency_key FROM enterprise_profile_audit WHERE enterprise_id = ${id} ORDER BY id DESC LIMIT 1) AS "lastWrite"
    FROM enterprise WHERE id = ${id}`)
  const profile = { enterpriseId: id, name, city, district }
  const after = { ...profile, name: next.name }
  const nameNorm = renamed ? normalizeEnterpriseName(next.name) : state!.nameNorm
  const alias = renamed ? await retainPostgresPreviousName(tx, profile, nameNorm, audit.idempotencyKey) : { id: null, created: 0 }
  const updates = []
  if (renamed) updates.push(sql`name = ${next.name}, name_norm = ${nameNorm}`)
  if (usccChanged) {
    const previousFlags = JSON.parse(state!.qualityFlags ?? 'null') as string[] | null
    const flags = (previousFlags ?? []).filter(flag => flag !== 'uscc_missing')
    if (next.uscc === null) flags.push('uscc_missing')
    updates.push(sql`uscc_norm = ${next.uscc}, quality_flags = ${JSON.stringify(flags)}`)
  }
  await tx.execute(sql`UPDATE enterprise SET ${sql.join(updates, sql`, `)} WHERE id = ${id}`)
  const beforeVersion = enterpriseProfileVersion({ profile, row: { nameNorm: state!.nameNorm, usccNorm: uscc }, key: state!.lastWrite })
  const afterVersion = enterpriseProfileVersion({ profile: after, row: { nameNorm, usccNorm: next.uscc }, key: audit.idempotencyKey })
  const inserted = await tx.execute<{ id: string }>(sql`INSERT INTO enterprise_profile_audit
    (enterprise_id, idempotency_key, request_hash, before_version, after_version, before, after, actor, basis,
      retained_alias_id, alias_created, created_at)
    VALUES (${id}, ${audit.idempotencyKey}, ${audit.requestHash}, ${beforeVersion}, ${afterVersion},
      ${JSON.stringify(usccChanged ? { ...profile, uscc } : profile)},
      ${JSON.stringify(usccChanged ? { ...after, uscc: next.uscc } : after)}, ${JSON.stringify(audit.actor)},
      ${audit.basis}, ${alias.id}, ${alias.created}, ${new Date().toISOString()}) RETURNING id`)
  return Number(inserted.rows[0]!.id)
}

/** Update only explicitly reviewed fields and retain their audit inside the caller's transaction. */
export async function attachPostgresReviewedEnterprise(tx: Transaction, subject: ReviewedAttachment) {
  const before = await checkedEnterprise(tx, subject.enterpriseId, subject.expectedRevision, 'membership')
  const fields = subject.fields ?? {}
  if (Object.keys(fields).length === 0) return { id: before.id, auditId: null }
  if (fields.name !== undefined && fields.name !== before.name) {
    const names = new Set([normalizeEnterpriseName(before.name), normalizeEnterpriseName(fields.name)].sort())
    for (const name of names) await lockIdentity(tx, 'name', name)
  }
  if (fields.uscc) {
    await lockIdentity(tx, 'uscc', fields.uscc)
    if (await matchingUsccExists(tx, fields.uscc, before.id)) conflict('uscc_taken', 'USCC belongs to another enterprise')
  }
  const next = { ...before, ...fields }
  await validateCodes(tx, next)
  const auditId = await revisePostgresReviewedProfile(tx, before, next, subject.audit)
  await saveCodes(tx, before.id, before.revision + 1, next)
  return { id: before.id, auditId }
}

export function addPostgresEnterprise(db: NodePgDatabase, fields: EnterpriseFields & { name: string }) {
  return db.transaction(async tx => {
    const id = await createPostgresReviewedEnterprise(tx, fields)
    await registerPostgresEnterpriseSource(tx, {
      module: 'core', businessTable: 'enterprise', versionKey: String(id), channel: 'direct', listType: 'direct',
      acquiredOn: new Date().toISOString().slice(0, 10), series: '直接添加', fileId: null, sha256: null,
    }, [id])
    return (await readPostgresEnterpriseDetails(tx, id))!
  })
}

export function savePostgresEnterpriseDetails(db: NodePgDatabase, id: number, input: z.infer<typeof enterpriseDetailsSchema>) {
  return db.transaction(async tx => {
    const { expectedRevision, registeredAddress, operatingAddress, ...fields } = input
    const before = await checkedEnterprise(tx, id, expectedRevision, 'details')
    if (before.removedReason !== null) conflict('enterprise_removed', '企业已移出基础库。')
    const next = { ...before, ...fields }
    await validateCodes(tx, next)
    await saveCodes(tx, id, before.revision + 1, next)
    await tx.execute(sql`DELETE FROM enterprise_address WHERE enterprise_id = ${id}`)
    const values = [
      { kind: 'registered', address: registeredAddress },
      { kind: 'operating', address: operatingAddress },
    ].filter(row => row.address !== null)
    if (values.length) {
      await tx.execute(sql`INSERT INTO enterprise_address (enterprise_id, kind, address) VALUES ${sql.join(
        values.map(row => sql`(${id}, ${row.kind}, ${row.address})`), sql`, `,
      )}`)
    }
    return (await readPostgresEnterpriseDetails(tx, id))!
  })
}

export function setPostgresEnterpriseRemoved(db: NodePgDatabase, id: number, revision: number, reason: string | null) {
  return db.transaction(async tx => {
    const before = await checkedEnterprise(tx, id, revision, 'membership')
    await tx.execute(sql`INSERT INTO enterprise_directory (enterprise_id, revision, removed_reason)
      VALUES (${id}, ${before.revision + 1}, ${reason})
      ON CONFLICT (enterprise_id) DO UPDATE SET revision = excluded.revision, removed_reason = excluded.removed_reason`)
    return (await readPostgresEnterpriseDetails(tx, id))!
  })
}
