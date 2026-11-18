import type Database from 'better-sqlite3'
import { eq, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as s from '../../../../db/schema'
import { normalizeEnterpriseName } from '../../lib/enterprise-name'
import { normalizeReviewedUscc, usccFormatVerdict } from '../../lib/enterprise-uscc'

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
  return db.$client.prepare(`SELECT e.id,e.name,e.uscc_norm AS uscc,e.city,e.district,
    d.district_code AS districtCode,d.township_code AS townshipCode,d.industry_code AS industryCode,
    major.parent_code AS industryDivisionCode,d.removed_reason AS removedReason,coalesce(d.revision,1) AS revision,
    m.into_enterprise_id AS mergedInto
    FROM enterprise e LEFT JOIN enterprise_directory d ON d.enterprise_id=e.id
    LEFT JOIN enterprise_industry detail ON detail.code=d.industry_code
    LEFT JOIN enterprise_industry major ON major.code=detail.parent_code
    LEFT JOIN enterprise_merge m ON m.from_enterprise_id=e.id WHERE e.id=?`).get(id) as {
      id: number; name: string; uscc: string | null; city: string | null; district: string | null;
      districtCode: string | null; townshipCode: string | null; industryCode: string | null;
      industryDivisionCode: string | null; removedReason: string | null; revision: number; mergedInto: number | null;
    } | undefined
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

export type ReviewedSubject =
  | { action: 'create'; fields: EnterpriseFields & { name: string } }
  | { action: 'attach'; enterpriseId: number; expectedRevision: number; fields?: EnterpriseFields }

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
    return { id, created: true }
  }

  const before = directory(db, subject.enterpriseId)
  if (!before) throw new EnterpriseKernelError(404, 'enterprise_not_found', 'Enterprise not found')
  if (before.mergedInto !== null || before.revision !== subject.expectedRevision) conflict('enterprise_changed', 'Enterprise target or revision changed')
  if (Object.keys(fields).length === 0) return { id: before.id, created: false }
  if (fields.uscc && existingUscc(db, fields.uscc).some(row => row.id !== before.id)) conflict('uscc_taken', 'USCC belongs to another enterprise')
  const next = { ...before, ...fields }
  validateCodes(db, next)
  if (fields.name !== undefined || fields.uscc !== undefined) {
    const changes = fields.name === undefined ? {} : { name: fields.name, nameNorm: normalizeEnterpriseName(fields.name) }
    if (fields.uscc !== undefined) {
      const row = db.select({ qualityFlags: s.enterprise.qualityFlags }).from(s.enterprise).where(eq(s.enterprise.id, before.id)).get()
      const flags = (row?.qualityFlags ?? []).filter(flag => flag !== 'uscc_missing')
      updateEnterprise(db, before.id, { ...changes, usccNorm: fields.uscc, qualityFlags: fields.uscc ? flags : [...flags, 'uscc_missing'] })
    } else updateEnterprise(db, before.id, changes)
  }
  db.$client.prepare(`INSERT INTO enterprise_directory(enterprise_id,district_code,township_code,industry_code,revision)
    VALUES (?,?,?,?,?) ON CONFLICT(enterprise_id) DO UPDATE SET district_code=excluded.district_code,
    township_code=excluded.township_code,industry_code=excluded.industry_code,revision=excluded.revision`)
    .run(before.id, next.districtCode, next.townshipCode, next.industryCode, before.revision + 1)
  return { id: before.id, created: false }
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

export function listDirectoryEnterprises(db: Db, query: { name?: string; districtCode?: string; industryCode?: string; sourceId?: number; includeRemoved?: boolean; after: number; limit: number }) {
  const predicates = ['e.id > @after', 'm.from_enterprise_id IS NULL']
  if (query.name !== undefined) predicates.push('instr(e.name_norm,@name)>0')
  if (query.districtCode !== undefined) predicates.push('d.district_code=@districtCode')
  if (query.industryCode !== undefined) predicates.push('d.industry_code=@industryCode')
  if (query.sourceId !== undefined) predicates.push('EXISTS (SELECT 1 FROM enterprise_source_link l WHERE l.enterprise_id=e.id AND l.source_id=@sourceId)')
  if (!query.includeRemoved) predicates.push('d.removed_reason IS NULL')
  const ids = db.$client.prepare(`SELECT e.id FROM enterprise e
    LEFT JOIN enterprise_directory d ON d.enterprise_id=e.id LEFT JOIN enterprise_merge m ON m.from_enterprise_id=e.id
    WHERE ${predicates.join(' AND ')} ORDER BY e.id LIMIT @limit`)
    .pluck().all({ ...query, name: query.name === undefined ? null : normalizeEnterpriseName(query.name), limit: query.limit + 1 }) as number[]
  return { rows: ids.slice(0, query.limit).map(id => directory(db, id)!), nextAfter: ids.length > query.limit ? ids[query.limit - 1] : null }
}

export function listEnterpriseSources(db: Db, id: number) {
  return db.$client.prepare(`SELECT s.id,s.module,s.business_table AS businessTable,s.version_key AS versionKey,
    c.name AS channel,t.name AS listType,s.acquired_on AS acquiredOn,s.series,s.file_id AS fileId,s.sha256
    FROM enterprise_source_link l JOIN enterprise_source s ON s.id=l.source_id
    JOIN enterprise_source_channel c ON c.code=s.channel_code JOIN enterprise_source_list_type t ON t.code=s.list_type_code
    WHERE l.enterprise_id=? ORDER BY s.id`).all(id)
}
