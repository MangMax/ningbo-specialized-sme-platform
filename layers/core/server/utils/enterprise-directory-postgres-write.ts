import { and, asc, desc, eq, inArray, ne, notExists, or, sql } from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAddress, enterpriseAlias, enterpriseDirectory, enterpriseIndustry, enterpriseMerge, enterpriseProfileAudit, enterpriseRegion } from '../../../../db/postgresql/enterprise-tables'
import { enterpriseSource, enterpriseSourceLink } from '../../../../db/postgresql/enterprise-source-tables'
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
  // Check all three codes in one statement snapshot. Drizzle has no SQL literal builder.
  type CodeKind = 'district' | 'township' | 'industry'
  const rows = await unionAll(
    tx.select({ kind: sql<CodeKind>`'district'` }).from(enterpriseRegion).where(and(
      eq(enterpriseRegion.level, 2), districtCode ? eq(enterpriseRegion.code, districtCode) : sql`false`,
    )),
    tx.select({ kind: sql<CodeKind>`'township'` }).from(enterpriseRegion).where(and(
      eq(enterpriseRegion.level, 3),
      townshipCode && districtCode
        ? and(eq(enterpriseRegion.code, townshipCode), eq(enterpriseRegion.parentCode, districtCode))
        : sql`false`,
    )),
    tx.select({ kind: sql<CodeKind>`'industry'` }).from(enterpriseIndustry).where(and(
      eq(enterpriseIndustry.level, 3), industryCode ? eq(enterpriseIndustry.code, industryCode) : sql`false`,
    )),
  )
  const valid = new Set(rows.map(row => row.kind))
  if (districtCode && !valid.has('district')) conflict('unknown_district', 'District code is absent from the supplied dictionary')
  if (townshipCode && !valid.has('township')) conflict('township_district_mismatch', 'Township code must belong to the selected district')
  if (industryCode && !valid.has('industry')) conflict('unknown_industry', 'Industry detail code is absent from the supplied dictionary')
}

async function checkedEnterprise(tx: Transaction, id: number, revision: number, operation: 'details' | 'membership') {
  await tx.select({ id: enterprise.id }).from(enterprise).where(eq(enterprise.id, id)).for('update')
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
  const profile = {
    districtCode: fields.districtCode ?? null,
    townshipCode: fields.townshipCode ?? null,
    industryCode: fields.industryCode ?? null,
    revision,
  }
  await tx.insert(enterpriseDirectory).values({ enterpriseId: id, ...profile })
    .onConflictDoUpdate({ target: enterpriseDirectory.enterpriseId, set: profile })
}

async function matchingUsccExists(tx: Transaction, uscc: string, exceptId: number | null = null) {
  // Drizzle has no PostgreSQL regex or collation expressions.
  const rows = await tx.select({ uscc: enterprise.usccNorm }).from(enterprise).where(and(
    exceptId === null ? undefined : ne(enterprise.id, exceptId),
    or(eq(enterprise.usccNorm, uscc), sql`${enterprise.usccNorm} COLLATE "C" ~ '[^A-Z0-9]'`),
  ))
  return rows.some(row => row.uscc !== null && normalizeReviewedUscc(row.uscc) === uscc)
}

function lockIdentity(tx: Transaction, kind: 'name' | 'uscc', value: string) {
  // Drizzle does not expose PostgreSQL transaction advisory locks or hashtextextended.
  return tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`enterprise:${kind}:${value}`}, 0))`)
}

export async function lockPostgresReviewedEnterpriseBatch(
  tx: Transaction,
  enterpriseIds: readonly number[],
  fields: readonly EnterpriseFields[],
) {
  const names = new Set(fields.flatMap(field => field.name === undefined ? [] : [normalizeEnterpriseName(field.name)]))
  if (enterpriseIds.length) {
    const rows = await tx.select({ name: enterprise.name }).from(enterprise)
      .where(inArray(enterprise.id, enterpriseIds)).orderBy(asc(enterprise.id)).for('update')
    if (names.size) for (const row of rows) names.add(normalizeEnterpriseName(row.name))
  }
  const codes = new Set(fields.flatMap(field => field.uscc ? [field.uscc] : []))
  for (const name of [...names].sort()) await lockIdentity(tx, 'name', name)
  for (const code of [...codes].sort()) await lockIdentity(tx, 'uscc', code)
}

export async function registerPostgresEnterpriseSource(tx: Transaction, input: EnterpriseSource, enterpriseIds: readonly number[]) {
  const { module, businessTable, versionKey, channel, listType, acquiredOn, series, fileId, sha256 } = input
  const [{ id: insertedId } = {}] = await tx.insert(enterpriseSource).values({
    module, businessTable, versionKey, channelCode: channel, listTypeCode: listType, acquiredOn, series, fileId, sha256,
  }).onConflictDoNothing({ target: [enterpriseSource.module, enterpriseSource.businessTable, enterpriseSource.versionKey] })
    .returning({ id: enterpriseSource.id })
  let id = insertedId
  if (id === undefined) {
    const [existing] = await tx.select({
      id: enterpriseSource.id, channel: enterpriseSource.channelCode, listType: enterpriseSource.listTypeCode,
      series: enterpriseSource.series, sha256: enterpriseSource.sha256,
    }).from(enterpriseSource).where(and(
      eq(enterpriseSource.module, module), eq(enterpriseSource.businessTable, businessTable), eq(enterpriseSource.versionKey, versionKey),
    ))
    if (!existing || existing.channel !== channel || existing.listType !== listType
      || existing.series !== series || existing.sha256 !== sha256) {
      conflict('source_conflict', 'This source version already has different provenance')
    }
    id = existing.id
  }
  if (enterpriseIds.length) {
    await tx.insert(enterpriseSourceLink).values(enterpriseIds.map(enterpriseId => ({ enterpriseId, sourceId: id })))
      .onConflictDoNothing()
  }
  return id
}

export async function createPostgresReviewedEnterprise(tx: Transaction, fields: EnterpriseFields & { name: string }) {
  await validateCodes(tx, fields)
  const name = normalizeEnterpriseName(fields.name)
  const uscc = fields.uscc ?? null
  await lockIdentity(tx, 'name', name)
  if (uscc) await lockIdentity(tx, 'uscc', uscc)
  const exists = uscc
    ? await matchingUsccExists(tx, uscc)
    : (await tx.select({ id: enterprise.id }).from(enterprise).where(eq(enterprise.nameNorm, name)).limit(1)).length > 0
  if (exists) {
    conflict('existing_subject', 'A matching identity already exists; confirm an enterprise ID')
  }
  const [inserted] = await tx.insert(enterprise).values({
    name: fields.name, nameNorm: name, usccNorm: uscc, qualityFlags: JSON.stringify(uscc ? [] : ['uscc_missing']),
  }).returning({ id: enterprise.id })
  await saveCodes(tx, inserted!.id, 1, fields)
  return inserted!.id
}

async function retainPostgresPreviousName(tx: Transaction, profile: EnterpriseProfile, nameNorm: string, idempotencyKey: string) {
  const { enterpriseId: id, name } = profile
  const oldNorm = normalizeEnterpriseName(name)
  if (!nameNorm || !oldNorm) throw new EnterpriseKernelError(422, 'invalid_name', 'Normalized enterprise name must not be empty')
  const names = [oldNorm, nameNorm]
  const owners = await unionAll(
    tx.select({ id: enterprise.id }).from(enterprise).where(and(
      ne(enterprise.id, id), inArray(enterprise.nameNorm, names),
      notExists(tx.select({ id: enterpriseMerge.fromEnterpriseId }).from(enterpriseMerge)
        .where(eq(enterpriseMerge.fromEnterpriseId, enterprise.id))),
    )),
    tx.select({ id: enterpriseAlias.id }).from(enterpriseAlias).where(and(
      ne(enterpriseAlias.enterpriseId, id), inArray(enterpriseAlias.nameNorm, names), eq(enterpriseAlias.verificationStatus, 'confirmed'),
    )),
  ).limit(1)
  if (owners.length) conflict('identity_conflict', 'Name belongs to another enterprise; use the identity operation')
  const [existing] = await tx.select({ id: enterpriseAlias.id, status: enterpriseAlias.verificationStatus }).from(enterpriseAlias)
    .where(and(eq(enterpriseAlias.enterpriseId, id), eq(enterpriseAlias.nameNorm, oldNorm), or(
      eq(enterpriseAlias.verificationStatus, 'confirmed'),
      and(eq(enterpriseAlias.sourceKind, 'manual'), eq(enterpriseAlias.sourceRefId, 0)),
    )))
    .orderBy(desc(eq(enterpriseAlias.verificationStatus, 'confirmed')), asc(enterpriseAlias.id)).limit(1)
  if (existing?.status === 'confirmed') return { id: existing.id, created: 0 }
  if (existing) conflict('alias_lifecycle_required', 'Previous-name record is not confirmed; confirm or restore it through alias lifecycle first')
  const [alias] = await tx.insert(enterpriseAlias).values({
    enterpriseId: id, name, nameNorm: oldNorm, sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'confirmed',
    note: `Enterprise profile rename: ${idempotencyKey}`, createdAt: new Date().toISOString(),
  }).returning({ id: enterpriseAlias.id })
  return { id: alias!.id, created: 1 }
}

export async function insertPostgresEnterpriseAlias(tx: Transaction, values: Pick<typeof enterpriseAlias.$inferInsert,
  'enterpriseId' | 'name' | 'nameNorm' | 'sourceKind' | 'sourceRefId' | 'validFrom' | 'validTo' | 'verificationStatus' | 'note'
> & { sourceRefId: number }) {
  const { enterpriseId, nameNorm, sourceKind, sourceRefId } = values
  const [inserted] = await tx.insert(enterpriseAlias).values({ ...values, createdAt: new Date().toISOString() })
    .onConflictDoNothing({ target: [enterpriseAlias.enterpriseId, enterpriseAlias.nameNorm, enterpriseAlias.sourceKind, enterpriseAlias.sourceRefId] })
    .returning({ id: enterpriseAlias.id })
  if (inserted) return { id: inserted.id, created: true }
  const [existing] = await tx.select({ id: enterpriseAlias.id }).from(enterpriseAlias).where(and(
    eq(enterpriseAlias.enterpriseId, enterpriseId), eq(enterpriseAlias.nameNorm, nameNorm),
    eq(enterpriseAlias.sourceKind, sourceKind), eq(enterpriseAlias.sourceRefId, sourceRefId),
  ))
  return { id: existing!.id, created: false }
}

export async function backfillPostgresEnterpriseUscc(tx: Transaction, id: number, uscc: string, qualityFlags: readonly string[]) {
  const flags = qualityFlags.filter(flag=>flag!=='uscc_missing')
  await tx.update(enterprise).set({ usccNorm: uscc, qualityFlags: JSON.stringify(flags) }).where(eq(enterprise.id, id))
}

type ReviewedAttachment = Extract<ReviewedSubject, { action: 'attach' }>

export async function postgresEnterpriseProfileState(tx: Transaction, id: number) {
  const latestAudit = tx.select({
    enterpriseId: enterpriseProfileAudit.enterpriseId, key: enterpriseProfileAudit.idempotencyKey,
  }).from(enterpriseProfileAudit)
    .where(eq(enterpriseProfileAudit.enterpriseId, id)).orderBy(desc(enterpriseProfileAudit.id)).limit(1).as('latest_audit')
  const [state] = await tx.select({
    name: enterprise.name, city: enterprise.city, district: enterprise.district, usccNorm: enterprise.usccNorm,
    nameNorm: enterprise.nameNorm, qualityFlags: enterprise.qualityFlags,
    key: latestAudit.key,
  }).from(enterprise).leftJoin(latestAudit, eq(latestAudit.enterpriseId, enterprise.id)).where(eq(enterprise.id, id))
  if (!state) throw new EnterpriseKernelError(404, 'not_found', 'Enterprise not found')
  const { name, city, district, key, ...row } = state
  return { profile: { enterpriseId: id, name, city, district }, row, key }
}

export async function applyPostgresEnterpriseProfileChange(
  tx: Transaction, current: Awaited<ReturnType<typeof postgresEnterpriseProfileState>>,
  changes: Partial<Pick<EnterpriseProfile, 'name' | 'city' | 'district'>> & { uscc?: string | null },
  audit: ReviewedAttachment['audit'] & { previousName?: string },
) {
  const { profile, row } = current
  const { enterpriseId: id } = profile
  const { uscc, ...profileChanges } = changes
  const after = { ...profile, ...profileChanges }
  const renamed = after.name !== profile.name
  const usccChanged = uscc !== undefined && uscc !== row.usccNorm
  if (renamed && audit.previousName !== profile.name) {
    throw new EnterpriseKernelError(422, 'previous_name_confirmation_required', 'Confirm the exact previous name belongs to this enterprise')
  }
  if (!renamed && audit.previousName !== undefined) {
    throw new EnterpriseKernelError(422, 'unexpected_previous_name', 'Previous-name confirmation is only valid for a name change')
  }
  const nameNorm = renamed ? normalizeEnterpriseName(after.name) : row.nameNorm
  const alias = renamed ? await retainPostgresPreviousName(tx, profile, nameNorm, audit.idempotencyKey) : { id: null, created: 0 }
  const updates: Partial<typeof enterprise.$inferInsert> = {}
  if (renamed) Object.assign(updates, { name: after.name, nameNorm })
  if (changes.city !== undefined) updates.city = after.city
  if (changes.district !== undefined) updates.district = after.district
  if (usccChanged) {
    const previousFlags = JSON.parse(row.qualityFlags ?? 'null') as string[] | null
    const flags = (previousFlags ?? []).filter(flag => flag !== 'uscc_missing')
    if (uscc === null) flags.push('uscc_missing')
    updates.usccNorm = uscc
    updates.qualityFlags = JSON.stringify(flags)
  }
  if (Object.keys(updates).length) await tx.update(enterprise).set(updates).where(eq(enterprise.id, id))
  const beforeVersion = enterpriseProfileVersion(current)
  const afterVersion = enterpriseProfileVersion({ profile: after, row: { nameNorm, usccNorm: usccChanged ? uscc : row.usccNorm }, key: audit.idempotencyKey })
  const committedAt = new Date().toISOString()
  const [inserted] = await tx.insert(enterpriseProfileAudit).values({
    enterpriseId: id, idempotencyKey: audit.idempotencyKey, requestHash: audit.requestHash, beforeVersion, afterVersion,
    before: JSON.stringify(usccChanged ? { ...profile, uscc: row.usccNorm } : profile),
    after: JSON.stringify(usccChanged ? { ...after, uscc } : after),
    actor: JSON.stringify(audit.actor), basis: audit.basis,
    retainedAliasId: alias.id, aliasCreated: alias.created, createdAt: committedAt,
  }).returning({ id: enterpriseProfileAudit.id })
  return { auditId: inserted!.id, profile: after, version: afterVersion,
    retainedAlias: alias.id === null ? null : { id: alias.id, name: profile.name, created: !!alias.created },
    committedAt }
}

async function revisePostgresReviewedProfile(tx: Transaction, before: NonNullable<Awaited<ReturnType<typeof readPostgresEnterpriseDetails>>>,
  next: typeof before, audit: ReviewedAttachment['audit']) {
  const renamed = next.name !== before.name
  if (!renamed && next.uscc === before.uscc) return null
  const current = await postgresEnterpriseProfileState(tx, before.id)
  return (await applyPostgresEnterpriseProfileChange(tx, current, {
    name: next.name, uscc: next.uscc,
  }, { ...audit, previousName: renamed ? before.name : undefined })).auditId
}

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
    await tx.delete(enterpriseAddress).where(eq(enterpriseAddress.enterpriseId, id))
    const values: (typeof enterpriseAddress.$inferInsert)[] = []
    if (registeredAddress !== null) values.push({ enterpriseId: id, kind: 'registered', address: registeredAddress })
    if (operatingAddress !== null) values.push({ enterpriseId: id, kind: 'operating', address: operatingAddress })
    if (values.length) await tx.insert(enterpriseAddress).values(values)
    return (await readPostgresEnterpriseDetails(tx, id))!
  })
}

export function setPostgresEnterpriseRemoved(db: NodePgDatabase, id: number, revision: number, reason: string | null) {
  return db.transaction(async tx => {
    const before = await checkedEnterprise(tx, id, revision, 'membership')
    const membership = { revision: before.revision + 1, removedReason: reason }
    await tx.insert(enterpriseDirectory).values({ enterpriseId: id, ...membership })
      .onConflictDoUpdate({ target: enterpriseDirectory.enterpriseId, set: membership })
    return (await readPostgresEnterpriseDetails(tx, id))!
  })
}
