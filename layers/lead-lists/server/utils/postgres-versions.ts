import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { enterpriseSourceChannel, enterpriseSourceListType } from '../../../../db/postgresql/enterprise-source-tables'
import { filePhysicalIntent, storedFile } from '../../../../db/postgresql/file-tables'
import { postgresLeadListRow as leadRow, postgresLeadListVersion as leadVersion } from '../../../../db/postgresql/lead-tables'
import { registerPostgresEnterpriseSource, verifyRegisteredFileRead } from '../../../core/server/public'
import type { LeadCatalog, LeadVersionDetail, LeadVersionSummary, VersionInput } from '../../lib/contracts'

export function usePostgresLeadWriteDb() {
  if (process.env.NUXT_DB_READONLY === '1') {
    throw createError({ statusCode: 503, message: '线索名单处于只读验收模式。' })
  }
  return usePostgresDirectoryDb()
}

const fileColumns = {
  fileId: storedFile.id,
  relPath: storedFile.relPath,
  filename: storedFile.filename,
  removedAt: storedFile.removedAt,
  sha256: storedFile.sha256,
  bytes: storedFile.bytes,
}

function summaries(db: NodePgDatabase) {
  return db.select({
    id: leadVersion.id,
    series: leadVersion.series,
    channel: leadVersion.channel,
    listType: leadVersion.listType,
    acquiredOn: leadVersion.acquiredOn,
    fileId: leadVersion.fileId,
    filePath: storedFile.relPath,
    filename: storedFile.filename,
    displayName: storedFile.displayName,
    removedAt: storedFile.removedAt,
  }).from(leadVersion).innerJoin(storedFile, eq(leadVersion.fileId, storedFile.id))
}

function versionDto({ filename, displayName, removedAt, ...row }: Awaited<ReturnType<typeof summaries>>[number]): LeadVersionSummary {
  return { ...row, fileName: displayName ?? filename, fileAvailable: removedAt === null }
}

// Drizzle 0.45 has no collation operator. Keep the catalog and dictionary bytewise ordering.
async function dictionaries(db: NodePgDatabase) {
  const channels = await db.select().from(enterpriseSourceChannel).where(ne(enterpriseSourceChannel.code, 'direct'))
    .orderBy(asc(sql`${enterpriseSourceChannel.code} COLLATE "C"`))
  const listTypes = await db.select().from(enterpriseSourceListType).where(ne(enterpriseSourceListType.code, 'direct'))
    .orderBy(asc(sql`${enterpriseSourceListType.code} COLLATE "C"`))
  return { channels, listTypes }
}

export function listPostgresLeadVersions(db: NodePgDatabase): Promise<LeadCatalog> {
  return db.transaction(async tx => {
    const dict = await dictionaries(tx)
    const versions = await summaries(tx).orderBy(
      asc(sql`${leadVersion.series} COLLATE "C"`),
      desc(sql`${leadVersion.acquiredOn} COLLATE "C"`),
      desc(leadVersion.id),
    )
    return { ...dict, versions: versions.map(versionDto) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function readPostgresLeadVersion(db: NodePgDatabase, id: number): Promise<LeadVersionDetail> {
  return db.transaction(tx => readPostgresLeadVersionInSnapshot(tx, id), { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function readPostgresLeadVersionInSnapshot(db: NodePgDatabase, id: number): Promise<LeadVersionDetail> {
  const [version] = await summaries(db).where(eq(leadVersion.id, id))
  if (!version) throw createError({ statusCode: 404, message: '名单版本不存在' })
  const rows = await db.select({
    id: leadRow.id,
    rowNumber: leadRow.rowNumber,
    name: leadRow.name,
    uscc: leadRow.uscc,
    district: leadRow.district,
    note: leadRow.note,
    enterpriseId: leadRow.enterpriseId,
  }).from(leadRow).where(eq(leadRow.versionId, id)).orderBy(asc(leadRow.rowNumber))
  return { ...versionDto(version), rows }
}

export async function readPostgresLeadVersionSource(db: NodePgDatabase, id: number) {
  const [row] = await db.select({ ...fileColumns, versionSha: leadVersion.fileSha256 })
    .from(leadVersion).innerJoin(storedFile, eq(leadVersion.fileId, storedFile.id)).where(eq(leadVersion.id, id))
  if (!row || row.removedAt) throw createError({ statusCode: 404, message: '原文件不存在或已移出' })
  return { ...row, bytes: Number(row.bytes) }
}

export async function registerPostgresLeadVersion(db: NodePgDatabase, root: string, input: VersionInput) {
  const { rows, ...fields } = input
  const [registered] = await db.select(fileColumns).from(storedFile).where(eq(storedFile.id, fields.fileId))
  if (!registered || registered.removedAt) throw createError({ statusCode: 404, message: '原文件不存在或已移出' })
  const file = { ...registered, bytes: Number(registered.bytes) }
  const verified = await verifyRegisteredFileRead(root, file)
  if (verified.status !== 'verified') throw createError({ statusCode: 409, message: '无法确认原文件内容' })
  const ranked = rows.toSorted((a, b) => a.rowNumber - b.rowNumber)
  const requestHash = createHash('sha256').update(JSON.stringify({ ...fields, rows: ranked, sha256: file.sha256 })).digest('hex')

  return db.transaction(async tx => {
    const [live] = await tx.select(fileColumns).from(storedFile).where(eq(storedFile.id, file.fileId)).for('update')
    if (!live || live.removedAt || live.sha256 !== file.sha256 || live.relPath !== file.relPath || Number(live.bytes) !== file.bytes) {
      throw createError({ statusCode: 409, message: '原文件登记已变化，请重新选择' })
    }
    const [physical] = await tx.select({ id: filePhysicalIntent.id }).from(filePhysicalIntent)
      .where(and(eq(filePhysicalIntent.fileId, file.fileId), inArray(filePhysicalIntent.state, ['pending', 'quarantined', 'recovering'])))
      .limit(1)
    if (physical) throw createError({ statusCode: 409, message: '原文件正在隔离或恢复，请稍后重试' })
    const dict = await dictionaries(tx)
    if (!dict.channels.some(row => row.code === fields.channel) || !dict.listTypes.some(row => row.code === fields.listType)) {
      throw createError({ statusCode: 400, message: '请选择已登记的来源和名单类型' })
    }
    const [prior] = await tx.select({ id: leadVersion.id, requestHash: leadVersion.requestHash }).from(leadVersion)
      .where(and(
        eq(leadVersion.series, fields.series),
        eq(leadVersion.channel, fields.channel),
        eq(leadVersion.listType, fields.listType),
        eq(leadVersion.acquiredOn, fields.acquiredOn),
        eq(leadVersion.fileId, fields.fileId),
      ))
    if (prior) {
      if (prior.requestHash !== requestHash) throw createError({ statusCode: 409, message: '该原文件已登记为此版本，请使用新的版本资料' })
      return { id: prior.id, created: false }
    }
    const [created] = await tx.insert(leadVersion).values({
      ...fields, fileSha256: file.sha256, requestHash, createdAt: new Date().toISOString(),
    }).returning({ id: leadVersion.id })
    const id = created!.id
    await tx.insert(leadRow).values(ranked.map(row => ({
      versionId: id, rowNumber: row.rowNumber, name: row.name,
      uscc: row.uscc ?? null, district: row.district ?? null, note: row.note ?? null,
    })))
    await registerPostgresEnterpriseSource(tx, {
      module: 'lead-lists', businessTable: 'lead_list_version', versionKey: String(id),
      channel: fields.channel, listType: fields.listType, acquiredOn: fields.acquiredOn,
      series: fields.series, fileId: fields.fileId, sha256: file.sha256,
    }, [])
    return { id, created: true }
  })
}
