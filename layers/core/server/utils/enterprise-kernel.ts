import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as s from '../../../../db/schema'
import { normalizeEnterpriseName } from '../../lib/enterprise-name'
import { normalizeReviewedUscc, usccFormatVerdict } from '../../lib/enterprise-uscc'
import { directoryColumns, directoryOrder, directorySource, enterpriseSourcesSelection, type DirectoryQuery, type DirectoryRow } from './enterprise-directory-query'
import { currentEnterpriseIdentity } from './enterprise-identity'

type Db = BetterSQLite3Database<typeof s> & { $client: Database.Database }
type Writer = Pick<Db, 'insert' | 'update' | 'delete'>
type Connection = Pick<Db, '$client'>

export function insertEnterprise(tx: Writer, values: typeof s.enterprise.$inferInsert) {
  return tx.insert(s.enterprise).values(values).returning({ id: s.enterprise.id }).get()
}
export function updateEnterprise(tx: Writer, id: number, values: Partial<typeof s.enterprise.$inferInsert>) {
  tx.update(s.enterprise).set(values).where(eq(s.enterprise.id, id)).run()
}
export function insertEnterpriseAlias(tx: Writer, values: typeof s.enterpriseAlias.$inferInsert) {
  return tx.insert(s.enterpriseAlias).values(values).returning().get()
}
export function updateEnterpriseAlias(tx: Writer, where: SQL, values: Partial<typeof s.enterpriseAlias.$inferInsert>) {
  return tx.update(s.enterpriseAlias).set(values).where(where).returning().get()
}
export function insertEnterpriseAliasAudit(tx: Writer, values: typeof s.enterpriseAliasAudit.$inferInsert) {
  tx.insert(s.enterpriseAliasAudit).values(values).run()
}
export function insertEnterpriseProfileAudit(tx: Writer, values: typeof s.enterpriseProfileAudit.$inferInsert) {
  return tx.insert(s.enterpriseProfileAudit).values(values).returning().get()
}
export function moveEnterpriseAlias(tx: Writer, id: number, target: { enterpriseId: number } | { aliasId: number }) {
  if ('aliasId' in target) {
    tx.update(s.enterpriseAliasAudit).set({ aliasId: target.aliasId }).where(eq(s.enterpriseAliasAudit.aliasId, id)).run()
    tx.delete(s.enterpriseAlias).where(eq(s.enterpriseAlias.id, id)).run()
  } else {
    updateEnterpriseAlias(tx, eq(s.enterpriseAlias.id, id), target)
  }
}
export function insertEnterpriseMerge(tx: Writer, values: typeof s.enterpriseMerge.$inferInsert) {
  tx.insert(s.enterpriseMerge).values(values).run()
}

export class EnterpriseKernelError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message) }
}
function conflict(code: string, message: string): never {
  throw new EnterpriseKernelError(409, code, message)
}

const text = (length: number) => z.string().trim().min(1).max(length).refine(s => s.isWellFormed() && !s.includes('\0'))
const regionalCode = z.string().regex(/^\d+$/).nullable().optional()
export const enterpriseFieldsSchema = z.strictObject({
  name: text(300).refine(value => normalizeEnterpriseName(value).length > 0).optional(),
  uscc: text(80).transform(normalizeReviewedUscc).refine(value => usccFormatVerdict(value) === 'ok', 'Invalid USCC checksum or format').nullable().optional(),
  districtCode: regionalCode,
  townshipCode: regionalCode,
  industryCode: z.string().regex(/^\d{4}$/).nullable().optional(),
})
export type EnterpriseFields = z.infer<typeof enterpriseFieldsSchema>

function directory(db: Db, id: number) {
  return db.$client.prepare(`SELECT ${directoryColumns} ${directorySource} WHERE e.id=?`)
    .get(id) as DirectoryRow | undefined
}

function validateCodes(db: Db, values: Pick<EnterpriseFields, 'districtCode' | 'townshipCode' | 'industryCode'>) {
  const { districtCode, townshipCode, industryCode } = values
  if (districtCode && !db.$client.prepare('SELECT 1 FROM enterprise_region WHERE code=? AND level=2').get(districtCode)) {
    conflict('unknown_district', 'District code is absent from the supplied dictionary')
  }
  if (townshipCode && (!districtCode || !db.$client.prepare('SELECT 1 FROM enterprise_region WHERE code=? AND level=3 AND parent_code=?').get(townshipCode, districtCode))) {
    conflict('township_district_mismatch', 'Township code must belong to the selected district')
  }
  if (industryCode && !db.$client.prepare('SELECT 1 FROM enterprise_industry WHERE code=? AND level=3').get(industryCode)) {
    conflict('unknown_industry', 'Industry detail code is absent from the supplied dictionary')
  }
}

function existingUscc(db: Db, candidate: string) {
  const exact = db.$client.prepare('SELECT id FROM enterprise WHERE uscc_norm=?').all(candidate) as { id: number }[]
  const legacy = db.$client.prepare("SELECT id, uscc_norm AS uscc FROM enterprise WHERE uscc_norm GLOB '*[^A-Z0-9]*'")
    .all() as { id: number; uscc: string }[]
  return [...exact, ...legacy.filter(row => normalizeReviewedUscc(row.uscc) === candidate)]
}

export interface EnterpriseProfile { enterpriseId: number; name: string; city: string | null; district: string | null }
export function enterpriseProfileState(db: Pick<Db, 'select'>, enterpriseId: number) {
  const row = db.select({
    name: s.enterprise.name, nameNorm: s.enterprise.nameNorm, city: s.enterprise.city,
    district: s.enterprise.district, usccNorm: s.enterprise.usccNorm,
  }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()
  if (!row) throw new EnterpriseKernelError(404, 'not_found', 'Enterprise not found')
  const last = db.select({ key: s.enterpriseProfileAudit.idempotencyKey }).from(s.enterpriseProfileAudit)
    .where(eq(s.enterpriseProfileAudit.enterpriseId, enterpriseId)).orderBy(desc(s.enterpriseProfileAudit.id)).limit(1).get()
  const profile: EnterpriseProfile = { enterpriseId, name: row.name, city: row.city, district: row.district }
  return { profile, row, key: last?.key ?? null }
}
export function enterpriseProfileVersion({ profile, row, key }: ReturnType<typeof enterpriseProfileState>) {
  return createHash('sha256').update(JSON.stringify({ profile, uscc: row.usccNorm, nameNorm: row.nameNorm, lastWrite: key })).digest('hex')
}

type ProfileWriter = Writer & Pick<Db, 'select'>
type ProfileAuditContext = Pick<typeof s.enterpriseProfileAudit.$inferInsert, 'idempotencyKey' | 'requestHash' | 'actor' | 'basis'>

function retainPreviousName(db: ProfileWriter, profile: EnterpriseProfile, newNameNorm: string, idempotencyKey: string) {
  const { enterpriseId, name } = profile
  const oldNorm = normalizeEnterpriseName(name)
  if (!newNameNorm || !oldNorm) throw new EnterpriseKernelError(422, 'invalid_name', 'Normalized enterprise name must not be empty')
  const nameOwner = db.select({ id: s.enterprise.id }).from(s.enterprise)
    .where(and(currentEnterpriseIdentity(db), inArray(s.enterprise.nameNorm, [newNameNorm, oldNorm]), ne(s.enterprise.id, enterpriseId))).limit(1).get()
  const aliasOwner = db.select({ id: s.enterpriseAlias.id }).from(s.enterpriseAlias)
    .where(and(inArray(s.enterpriseAlias.nameNorm, [newNameNorm, oldNorm]), eq(s.enterpriseAlias.verificationStatus, 'confirmed'), ne(s.enterpriseAlias.enterpriseId, enterpriseId))).limit(1).get()
  if (nameOwner || aliasOwner) conflict('identity_conflict', 'Name belongs to another enterprise; use the identity operation')
  const aliasScope = and(eq(s.enterpriseAlias.enterpriseId, enterpriseId), eq(s.enterpriseAlias.nameNorm, oldNorm))
  const existing = db.select({ id: s.enterpriseAlias.id }).from(s.enterpriseAlias)
    .where(and(aliasScope, eq(s.enterpriseAlias.verificationStatus, 'confirmed'))).orderBy(asc(s.enterpriseAlias.id)).limit(1).get()
  if (existing) return { retainedAliasId: existing.id, aliasCreated: false }
  const sameKey = db.select({ id: s.enterpriseAlias.id }).from(s.enterpriseAlias)
    .where(and(aliasScope, eq(s.enterpriseAlias.sourceKind, 'manual'), eq(s.enterpriseAlias.sourceRefId, 0))).limit(1).get()
  if (sameKey) conflict('alias_lifecycle_required', 'Previous-name record is not confirmed; confirm or restore it through alias lifecycle first')
  const alias = insertEnterpriseAlias(db, { enterpriseId, name, nameNorm: oldNorm, sourceKind: 'manual', sourceRefId: 0,
    verificationStatus: 'confirmed', note: `Enterprise profile rename: ${idempotencyKey}` })
  return { retainedAliasId: alias.id, aliasCreated: true }
}

/** Apply the reviewed fields and their audit in the caller's transaction. */
export function applyEnterpriseProfileChange(db: ProfileWriter, current: ReturnType<typeof enterpriseProfileState>,
  changes: Partial<Pick<EnterpriseProfile, 'name' | 'city' | 'district'>> & { uscc?: string | null },
  audit: ProfileAuditContext & { previousName?: string }) {
  const { profile, row } = current
  const { enterpriseId } = profile
  const { uscc, ...profileChanges } = changes
  const { previousName, ...auditFields } = audit
  const after = { ...profile, ...profileChanges }
  const renamed = after.name !== profile.name
  const usccChanged = uscc !== undefined && uscc !== row.usccNorm
  let alias = { retainedAliasId: null as number | null, aliasCreated: false }
  let nameNorm = row.nameNorm
  if (renamed) {
    if (previousName !== profile.name) throw new EnterpriseKernelError(422, 'previous_name_confirmation_required', 'Confirm the exact previous name belongs to this enterprise')
    nameNorm = normalizeEnterpriseName(after.name)
    alias = retainPreviousName(db, profile, nameNorm, auditFields.idempotencyKey)
  } else if (previousName !== undefined) {
    throw new EnterpriseKernelError(422, 'unexpected_previous_name', 'Previous-name confirmation is only valid for a name change')
  }
  const values: Partial<typeof s.enterprise.$inferInsert> = { ...profileChanges }
  if (renamed) values.nameNorm = nameNorm
  if (usccChanged) {
    const quality = db.select({ flags: s.enterprise.qualityFlags }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()
    const flags = (quality?.flags ?? []).filter(flag => flag !== 'uscc_missing')
    values.usccNorm = uscc
    values.qualityFlags = uscc ? flags : [...flags, 'uscc_missing']
  }
  updateEnterprise(db, enterpriseId, values)
  const afterVersion = enterpriseProfileVersion({ profile: after, row: { ...row, nameNorm, usccNorm: usccChanged ? uscc : row.usccNorm }, key: auditFields.idempotencyKey })
  return insertEnterpriseProfileAudit(db, {
    ...auditFields, ...alias, enterpriseId, beforeVersion: enterpriseProfileVersion(current), afterVersion,
    before: usccChanged ? { ...profile, uscc: row.usccNorm } : profile,
    after: usccChanged ? { ...after, uscc } : after,
  })
}

export type ReviewedSubject =
  | { action: 'create'; fields: EnterpriseFields & { name: string } }
  | { action: 'attach'; enterpriseId: number; expectedRevision: number; fields?: EnterpriseFields; audit: ProfileAuditContext }

export function applyReviewedEnterprise(db: Db, subject: ReviewedSubject) {
  if (!db.$client.inTransaction) throw new Error('Reviewed enterprise write requires a caller transaction')
  const fields = subject.fields ?? {}
  if (subject.action === 'create') {
    validateCodes(db, fields)
    if (fields.uscc ? existingUscc(db, fields.uscc).length : db.select({ id: s.enterprise.id }).from(s.enterprise).where(eq(s.enterprise.nameNorm, normalizeEnterpriseName(subject.fields.name))).get()) {
      conflict('existing_subject', 'A matching identity already exists; confirm an enterprise ID')
    }
    const { id } = insertEnterprise(db, {
      name: subject.fields.name, nameNorm: normalizeEnterpriseName(subject.fields.name), usccNorm: fields.uscc ?? null,
      qualityFlags: fields.uscc ? [] : ['uscc_missing'],
    })
    db.$client.prepare('INSERT INTO enterprise_directory(enterprise_id,district_code,township_code,industry_code) VALUES (?,?,?,?)')
      .run(id, fields.districtCode ?? null, fields.townshipCode ?? null, fields.industryCode ?? null)
    return { id, created: true, auditId: null }
  }

  const before = directory(db, subject.enterpriseId)
  if (!before) throw new EnterpriseKernelError(404, 'enterprise_not_found', 'Enterprise not found')
  if (before.mergedInto !== null || before.revision !== subject.expectedRevision) conflict('enterprise_changed', 'Enterprise target or revision changed')
  if (Object.keys(fields).length === 0) return { id: before.id, created: false, auditId: null }
  if (fields.uscc && existingUscc(db, fields.uscc).some(row => row.id !== before.id)) conflict('uscc_taken', 'USCC belongs to another enterprise')
  const next = { ...before, ...fields }
  validateCodes(db, next)
  const changes: { name?: string; uscc?: string | null } = {}
  if (fields.name !== undefined && fields.name !== before.name) changes.name = fields.name
  if (fields.uscc !== undefined && fields.uscc !== before.uscc) changes.uscc = fields.uscc
  const auditId = Object.keys(changes).length ? applyEnterpriseProfileChange(db, enterpriseProfileState(db, before.id), changes, {
    ...subject.audit, previousName: changes.name === undefined ? undefined : before.name,
  }).id : null
  writeDirectoryFields(db, before.id, before.revision + 1, next)
  return { id: before.id, created: false, auditId }
}

function writeDirectoryFields(db: Db, id: number, revision: number, fields: Pick<EnterpriseFields, 'districtCode' | 'townshipCode' | 'industryCode'>) {
  db.$client.prepare(`INSERT INTO enterprise_directory(enterprise_id,district_code,township_code,industry_code,revision)
    VALUES (?,?,?,?,?) ON CONFLICT(enterprise_id) DO UPDATE SET district_code=excluded.district_code,
    township_code=excluded.township_code,industry_code=excluded.industry_code,revision=excluded.revision`)
    .run(id, fields.districtCode, fields.townshipCode, fields.industryCode, revision)
}

export const enterpriseDetailsSchema = enterpriseFieldsSchema.pick({ districtCode: true, townshipCode: true, industryCode: true }).extend({
  expectedRevision: z.number().int().positive(),
  registeredAddress: text(500).nullable(),
  operatingAddress: text(500).nullable(),
})

export function readEnterpriseDetails(db: Db, id: number) {
  const row = directory(db, id)
  if (!row) throw new EnterpriseKernelError(404, 'enterprise_not_found', '未找到企业。')
  return row
}

export function saveEnterpriseDetails(db: Db, id: number, input: z.infer<typeof enterpriseDetailsSchema>) {
  return db.$client.transaction(() => {
    const before = readEnterpriseDetails(db, id)
    const { expectedRevision, registeredAddress, operatingAddress, ...fields } = input
    if (before.mergedInto !== null || before.revision !== expectedRevision) {
      conflict('enterprise_changed', '企业资料已变更，请重新打开后再编辑。')
    }
    if (before.removedReason !== null) conflict('enterprise_removed', '企业已移出基础库。')
    const next = { ...before, ...fields }
    validateCodes(db, next)
    writeDirectoryFields(db, id, before.revision + 1, next)
    db.delete(s.enterpriseAddress).where(eq(s.enterpriseAddress.enterpriseId, id)).run()
    const rows: typeof s.enterpriseAddress.$inferInsert[] = []
    if (registeredAddress) rows.push({ enterpriseId: id, kind: 'registered', address: registeredAddress })
    if (operatingAddress) rows.push({ enterpriseId: id, kind: 'operating', address: operatingAddress })
    if (rows.length) db.insert(s.enterpriseAddress).values(rows).run()
    return readEnterpriseDetails(db, id)
  }).immediate()
}

export type EnterpriseSource = {
  module: string; businessTable: string; versionKey: string; channel: string; listType: string;
  acquiredOn: string | null; series: string; fileId: number | null; sha256: string | null;
}

export function registerEnterpriseSource({ $client }: Connection, input: EnterpriseSource, enterpriseIds: readonly number[]) {
  if (!$client.inTransaction) throw new Error('Enterprise source registration requires a caller transaction')
  const existing = $client.prepare(`SELECT id,channel_code AS channel,list_type_code AS listType,acquired_on AS acquiredOn,
    series,file_id AS fileId,sha256 FROM enterprise_source WHERE module=? AND business_table=? AND version_key=?`)
    .get(input.module, input.businessTable, input.versionKey) as (Pick<EnterpriseSource, 'channel' | 'listType' | 'acquiredOn' | 'series' | 'fileId' | 'sha256'> & { id: number }) | undefined
  if (existing && (existing.channel !== input.channel || existing.listType !== input.listType || existing.series !== input.series || existing.sha256 !== input.sha256)) {
    conflict('source_conflict', 'This source version already has different provenance')
  }
  const id = existing?.id ?? ($client.prepare(`INSERT INTO enterprise_source
    (module,business_table,version_key,channel_code,list_type_code,acquired_on,series,file_id,sha256)
    VALUES (@module,@businessTable,@versionKey,@channel,@listType,@acquiredOn,@series,@fileId,@sha256) RETURNING id`).get(input) as { id: number }).id
  const link = $client.prepare('INSERT INTO enterprise_source_link(enterprise_id,source_id) VALUES (?,?) ON CONFLICT DO NOTHING')
  for (const enterpriseId of enterpriseIds) link.run(enterpriseId, id)
  return id
}

export function addEnterprise(db: Db, fields: EnterpriseFields & { name: string }) {
  return db.$client.transaction(() => {
    const { id } = applyReviewedEnterprise(db, { action: 'create', fields })
    registerEnterpriseSource(db, {
      module: 'core', businessTable: 'enterprise', versionKey: String(id), channel: 'direct', listType: 'direct',
      acquiredOn: new Date().toISOString().slice(0, 10), series: '直接添加', fileId: null, sha256: null,
    }, [id])
    return directory(db, id)!
  }).immediate()
}

export function setEnterpriseRemoved(db: Db, id: number, expectedRevision: number, reason: string | null) {
  return db.$client.transaction(() => {
    const before = directory(db, id)
    if (!before) throw new EnterpriseKernelError(404, 'enterprise_not_found', 'Enterprise not found')
    if (before.revision !== expectedRevision || before.mergedInto !== null) conflict('enterprise_changed', 'Enterprise target or revision changed')
    db.$client.prepare(`INSERT INTO enterprise_directory(enterprise_id,revision,removed_reason) VALUES (?,?,?)
      ON CONFLICT(enterprise_id) DO UPDATE SET revision=excluded.revision,removed_reason=excluded.removed_reason`)
      .run(id, before.revision + 1, reason)
    return directory(db, id)!
  }).immediate()
}

export function listDirectoryEnterprises(db: Db, query: DirectoryQuery) {
  const predicates = ['m.from_enterprise_id IS NULL']
  if (query.name !== undefined) predicates.push('instr(e.name_norm,@name)>0')
  if (query.uscc !== undefined) predicates.push('e.uscc_norm=@uscc')
  if (query.districtCode !== undefined) predicates.push('d.district_code=@districtCode')
  if (query.townshipCode !== undefined) predicates.push('d.township_code=@townshipCode')
  if (query.industryDivisionCode !== undefined) predicates.push('ig.parent_code=@industryDivisionCode')
  if (query.industryCode !== undefined) predicates.push('d.industry_code=@industryCode')
  if (query.registeredAddress !== undefined) predicates.push('instr(ra.address,@registeredAddress)>0')
  if (query.operatingAddress !== undefined) predicates.push('instr(oa.address,@operatingAddress)>0')
  if (query.sourceId !== undefined) predicates.push('EXISTS (SELECT 1 FROM enterprise_source_link l WHERE l.enterprise_id=e.id AND l.source_id=@sourceId)')
  if (!query.includeRemoved) predicates.push('d.removed_reason IS NULL')

  const conditions = `${directorySource} WHERE ${predicates.join(' AND ')}`
  const values = { ...query, name: query.name === undefined ? null : normalizeEnterpriseName(query.name) }
  if (query.page !== undefined || query.sorts?.length) {
    const requestedPage = query.page ?? 1
    const orderedColumns = (query.sorts ?? []).map(({ field, direction }) =>
      `${directoryOrder[field]} COLLATE NOCASE ${direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`)
    const order = [...orderedColumns, 'e.id'].join(', ')
    return db.$client.transaction(() => {
      const total = db.$client.prepare(`SELECT count(*) ${conditions}`).pluck().get(values) as number
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / query.limit)))
      const rows = db.$client.prepare(`SELECT ${directoryColumns}
        ${conditions} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
        .all({ ...values, offset: (page - 1) * query.limit }) as DirectoryRow[]
      return { rows, page, total }
    })()
  }
  const rows = db.$client.prepare(`SELECT ${directoryColumns} ${conditions} AND e.id > @after ORDER BY e.id LIMIT @limit`)
    .all({ ...values, after: query.after ?? 0, limit: query.limit + 1 }) as DirectoryRow[]
  return { rows: rows.slice(0, query.limit), nextAfter: rows.length > query.limit ? rows[query.limit - 1]!.id : null }
}

export function listEnterpriseSources(db: Db, id: number) {
  return db.$client.prepare(`${enterpriseSourcesSelection} WHERE l.enterprise_id=? ORDER BY s.id`).all(id)
}
