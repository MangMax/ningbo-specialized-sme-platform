import { createHash } from 'node:crypto'
import { asc, desc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { postgresLeadListRow as leadRow, postgresLeadListVersion as leadVersion } from '../../../../db/postgresql/lead-tables'
import { registerPostgresEnterpriseSource, verifyRegisteredFileRead } from '../../../core/server/public'
import type { LeadCatalog, LeadVersionDetail, LeadVersionSummary, VersionInput } from '../../lib/contracts'

export function usePostgresLeadDb() {
  if (process.env.NUXT_POSTGRES_LEAD_REGISTRATION !== '1') return
  const db = usePostgresDirectoryDb()
  if (!db) throw createError({ statusCode: 503, message: '线索名单 PostgreSQL 验收未配置' })
  return db
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

async function dictionaries(db: NodePgDatabase) {
  const channels = await db.execute<LeadCatalog['channels'][number]>(sql`
    SELECT code, name FROM enterprise_source_channel WHERE code <> 'direct' ORDER BY code COLLATE "C"`)
  const listTypes = await db.execute<LeadCatalog['listTypes'][number]>(sql`
    SELECT code, name FROM enterprise_source_list_type WHERE code <> 'direct' ORDER BY code COLLATE "C"`)
  return { channels: channels.rows, listTypes: listTypes.rows }
}

export function listPostgresLeadVersions(db: NodePgDatabase): Promise<LeadCatalog> {
  return db.transaction(async tx => {
    const dict = await dictionaries(tx)
    // Drizzle 0.45 has no collation operator. Keep the catalog's bytewise ordering.
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
    const physical = await tx.execute(sql`SELECT 1 FROM file_physical_intent
      WHERE file_id = ${file.fileId} AND state IN ('pending', 'quarantined', 'recovering') LIMIT 1`)
    if (physical.rows.length) throw createError({ statusCode: 409, message: '原文件正在隔离或恢复，请稍后重试' })
    const dict = await dictionaries(tx)
    if (!dict.channels.some(row => row.code === fields.channel) || !dict.listTypes.some(row => row.code === fields.listType)) {
      throw createError({ statusCode: 400, message: '请选择已登记的来源和名单类型' })
    }
    const prior = (await tx.execute<{ id: string; requestHash: string }>(sql`
      SELECT id, request_hash AS "requestHash" FROM lead_list_version
      WHERE series = ${fields.series} AND channel_code = ${fields.channel} AND list_type_code = ${fields.listType}
        AND acquired_on = ${fields.acquiredOn} AND file_id = ${fields.fileId}`)).rows[0]
    if (prior) {
      if (prior.requestHash !== requestHash) throw createError({ statusCode: 409, message: '该原文件已登记为此版本，请使用新的版本资料' })
      return { id: Number(prior.id), created: false }
    }
    const created = await tx.execute<{ id: string }>(sql`INSERT INTO lead_list_version
      (series, channel_code, list_type_code, acquired_on, file_id, file_sha256, request_hash, created_at)
      VALUES (${fields.series}, ${fields.channel}, ${fields.listType}, ${fields.acquiredOn},
        ${fields.fileId}, ${file.sha256}, ${requestHash}, ${new Date().toISOString()}) RETURNING id`)
    const id = Number(created.rows[0]!.id)
    const values = ranked.map(row => sql`(${id}, ${row.rowNumber}, ${row.name}, ${row.uscc ?? null}, ${row.district ?? null}, ${row.note ?? null})`)
    await tx.execute(sql`INSERT INTO lead_list_row (version_id, row_number, name, uscc, district, note)
      VALUES ${sql.join(values, sql`, `)}`)
    await registerPostgresEnterpriseSource(tx, {
      module: 'lead-lists', businessTable: 'lead_list_version', versionKey: String(id),
      channel: fields.channel, listType: fields.listType, acquiredOn: fields.acquiredOn,
      series: fields.series, fileId: fields.fileId, sha256: file.sha256,
    }, [])
    return { id, created: true }
  })
}
