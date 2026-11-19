import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { storedFile } from '../../../../db/schema'
import type { useApplicationDb } from '../../../../db/client'
import { applyReviewedEnterprise, enterpriseFieldsSchema, EnterpriseKernelError, registerEnterpriseSource } from '../../../core/server/utils/enterprise-kernel'
import { verifyFileRead } from '../../../core/server/utils/file-read-identity'
import { leadListId, type LeadCatalog, type LeadVersionDetail, type VersionInput } from '../../lib/contracts'
import { leadListSchemaPresent } from '../../install-schema'
import { leadListRow, leadListVersion } from '../../schema'

type Db = ReturnType<typeof useApplicationDb>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function checkSchema(db: Db) {
  if (!leadListSchemaPresent(db.$client)) throw createError({ statusCode: 503, message: '线索名单尚未完成数据库升级' })
}

function dictionaries(db: Db) {
  return {
    channels: db.$client.prepare("SELECT code,name FROM enterprise_source_channel WHERE code<>'direct' ORDER BY code").all() as LeadCatalog['channels'],
    listTypes: db.$client.prepare("SELECT code,name FROM enterprise_source_list_type WHERE code<>'direct' ORDER BY code").all() as LeadCatalog['listTypes'],
  }
}

const summaryFields = {
  id: leadListVersion.id,
  series: leadListVersion.series,
  channel: leadListVersion.channel,
  listType: leadListVersion.listType,
  acquiredOn: leadListVersion.acquiredOn,
  fileId: leadListVersion.fileId,
  filePath: storedFile.relPath,
  name: storedFile.filename,
  displayName: storedFile.displayName,
  removedAt: storedFile.removedAt,
}
function summaries(db: Db) {
  return db.select(summaryFields).from(leadListVersion).innerJoin(storedFile, eq(storedFile.id, leadListVersion.fileId))
}
function toSummary({ name, displayName, removedAt, ...row }: ReturnType<ReturnType<typeof summaries>['all']>[number]) {
  return { ...row, fileName: displayName ?? name, fileAvailable: removedAt === null }
}

export function listLeadVersions(db: Db): LeadCatalog {
  checkSchema(db)
  return {
    ...dictionaries(db),
    versions: summaries(db).orderBy(asc(leadListVersion.series), desc(leadListVersion.acquiredOn), desc(leadListVersion.id)).all().map(toSummary),
  }
}

export function readLeadVersion(db: Db, id: number): LeadVersionDetail {
  checkSchema(db)
  const version = summaries(db).where(eq(leadListVersion.id, id)).get()
  if (!version) throw createError({ statusCode: 404, message: '名单版本不存在' })
  const rows = db.select({
    id: leadListRow.id, rowNumber: leadListRow.rowNumber, name: leadListRow.name, uscc: leadListRow.uscc,
    district: leadListRow.district, note: leadListRow.note, enterpriseId: leadListRow.enterpriseId,
  }).from(leadListRow).where(eq(leadListRow.versionId, id)).orderBy(asc(leadListRow.rowNumber)).all()
  return { ...toSummary(version), rows }
}

export function readLeadVersionSource(db: Db, id: number) {
  checkSchema(db)
  const source = db.select({
    fileId: leadListVersion.fileId,
    sha256: leadListVersion.fileSha256,
    relPath: storedFile.relPath,
    filename: storedFile.filename,
    removedAt: storedFile.removedAt,
  }).from(leadListVersion).innerJoin(storedFile, eq(storedFile.id, leadListVersion.fileId))
    .where(eq(leadListVersion.id, id)).get()
  if (!source || source.removedAt) throw createError({ statusCode: 404, message: '原文件不存在或已移出' })
  return source
}

const sourceTable = 'lead_list_version'
function registerSource(db: Db, version: typeof leadListVersion.$inferSelect, enterpriseIds: readonly number[]) {
  return registerEnterpriseSource(db, {
    module: 'lead-lists', businessTable: sourceTable, versionKey: String(version.id),
    channel: version.channel, listType: version.listType, acquiredOn: version.acquiredOn,
    series: version.series, fileId: version.fileId, sha256: version.fileSha256,
  }, enterpriseIds)
}

export async function registerLeadVersion(db: Db, root: string, input: VersionInput) {
  checkSchema(db)
  const file = db.select().from(storedFile).where(eq(storedFile.id, input.fileId)).get()
  if (!file || file.removedAt) throw createError({ statusCode: 404, message: '原文件不存在或已移出' })
  const verified = await verifyFileRead(db, root, file.relPath)
  if (verified.status !== 'verified' || verified.registered?.fileId !== file.id) {
    throw createError({ statusCode: 409, message: '无法确认原文件内容' })
  }
  const sourceHash = verified.registered.sha256
  const { rows, ...fields } = input
  const ranked = rows.toSorted((a, b) => a.rowNumber - b.rowNumber)
  const requestHash = hash({ ...fields, rows: ranked, sha256: sourceHash })
  return db.$client.transaction(() => {
    const live = db.select().from(storedFile).where(eq(storedFile.id, file.id)).get()
    if (!live || live.removedAt || live.sha256 !== sourceHash) {
      throw createError({ statusCode: 409, message: '原文件登记已变化，请重新选择' })
    }
    if (db.$client.prepare("SELECT 1 FROM file_physical_intent WHERE file_id=? AND state IN ('pending','quarantined','recovering')").get(file.id)) {
      throw createError({ statusCode: 409, message: '原文件正在隔离或恢复，请稍后重试' })
    }
    const options = dictionaries(db)
    if (!options.channels.some(item => item.code === fields.channel) || !options.listTypes.some(item => item.code === fields.listType)) {
      throw createError({ statusCode: 400, message: '请选择已登记的来源和名单类型' })
    }
    const prior = db.select().from(leadListVersion).where(and(
      eq(leadListVersion.series, fields.series), eq(leadListVersion.channel, fields.channel),
      eq(leadListVersion.listType, fields.listType), eq(leadListVersion.acquiredOn, fields.acquiredOn), eq(leadListVersion.fileId, fields.fileId),
    )).get()
    if (prior) {
      if (prior.requestHash !== requestHash) throw createError({ statusCode: 409, message: '该原文件已登记为此版本，请使用新的版本资料' })
      return { id: prior.id, created: false }
    }
    const version = db.insert(leadListVersion).values({
      ...fields, fileSha256: live.sha256, requestHash, createdAt: new Date().toISOString(),
    }).returning().get()
    for (const row of ranked) db.insert(leadListRow).values({ ...row, versionId: version.id }).run()
    registerSource(db, version, [])
    return { id: version.id, created: true }
  }).immediate()
}

const reviewer = z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1).max(120) })
const decision = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), rowId: leadListId, fields: enterpriseFieldsSchema.required({ name: true }) }),
  z.strictObject({ action: z.literal('attach'), rowId: leadListId, enterpriseId: leadListId, expectedRevision: leadListId }),
])
export const supplementInput = z.strictObject({
  actor: reviewer,
  basis: z.string().trim().min(1).max(500),
  decisions: z.array(decision).min(1).max(200).refine(items => new Set(items.map(item => item.rowId)).size === items.length),
})

export function supplementLeadVersion(db: Db, id: number, input: z.infer<typeof supplementInput>) {
  checkSchema(db)
  try {
    return db.$client.transaction(() => {
      const version = db.select().from(leadListVersion).where(eq(leadListVersion.id, id)).get()
      if (!version) throw createError({ statusCode: 404, message: '名单版本不存在' })
      const resolved = input.decisions.map(item => {
        const row = db.select().from(leadListRow).where(and(eq(leadListRow.id, item.rowId), eq(leadListRow.versionId, id))).get()
        if (!row) throw createError({ statusCode: 404, message: '所选行不在此名单版本中' })
        const auditHash = hash({ decision: item, actor: input.actor, basis: input.basis })
        if (row.enterpriseId !== null) {
          if (row.reviewHash !== auditHash) throw createError({ statusCode: 409, message: '该行已有核对结果' })
          return { rowId: item.rowId, enterpriseId: row.enterpriseId }
        }
        const audit = { idempotencyKey: `lead-lists:${row.id}`, requestHash: auditHash, actor: input.actor, basis: input.basis }
        const { id: enterpriseId } = applyReviewedEnterprise(db, item.action === 'create' ? item : { ...item, audit })
        db.update(leadListRow).set({
          enterpriseId, reviewHash: auditHash, reviewActor: JSON.stringify(input.actor), reviewBasis: input.basis, reviewedAt: new Date().toISOString(),
        }).where(eq(leadListRow.id, item.rowId)).run()
        return { rowId: item.rowId, enterpriseId }
      })
      const sourceId = registerSource(db, version, resolved.map(row => row.enterpriseId))
      return { sourceId, rows: resolved }
    }).immediate()
  } catch (error) {
    if (error instanceof EnterpriseKernelError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code } })
    throw error
  }
}
