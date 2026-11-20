import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { registerPostgresEnterpriseSource, verifyRegisteredFileRead } from '../../../core/server/public'
import type { LeadCatalog, LeadRow, LeadVersionDetail, LeadVersionSummary, VersionInput } from '../../lib/contracts'

type PgSummary = Omit<LeadVersionSummary, 'id' | 'fileId'> & { id: string; fileId: string }
type PgRow = Omit<LeadRow, 'id' | 'enterpriseId' | 'rowNumber'> & { id: string; enterpriseId: string | null; rowNumber: string }
type PgFile = { fileId: string; relPath: string; filename: string; removedAt: string | null; sha256: string; bytes: string }
export function usePostgresLeadDb() {
  if (process.env.NUXT_POSTGRES_LEAD_REGISTRATION !== '1') return
  const db = usePostgresDirectoryDb()
  if (!db) throw createError({ statusCode: 503, message: '线索名单 PostgreSQL 验收未配置' })
  return db
}

const summary = sql`SELECT v.id, v.series, v.channel_code AS channel, v.list_type_code AS "listType",
  v.acquired_on AS "acquiredOn", v.file_id AS "fileId", f.rel_path AS "filePath",
  coalesce(f.display_name, f.filename) AS "fileName", f.removed_at IS NULL AS "fileAvailable"
  FROM lead_list_version v JOIN stored_file f ON f.id = v.file_id`
const fileColumns = sql`f.id AS "fileId", f.rel_path AS "relPath", f.filename, f.removed_at AS "removedAt", f.sha256, f.bytes`

function versionDto(row: PgSummary): LeadVersionSummary {
  return { ...row, id: Number(row.id), fileId: Number(row.fileId) }
}
function fileDto(row: PgFile) {
  return { ...row, fileId: Number(row.fileId), bytes: Number(row.bytes) }
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
    const versions = await tx.execute<PgSummary>(sql`${summary}
      ORDER BY v.series COLLATE "C", v.acquired_on COLLATE "C" DESC, v.id DESC`)
    return { ...dict, versions: versions.rows.map(versionDto) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function readPostgresLeadVersion(db: NodePgDatabase, id: number): Promise<LeadVersionDetail> {
  return db.transaction(tx => readPostgresLeadVersionInSnapshot(tx, id), { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function readPostgresLeadVersionInSnapshot(db: NodePgDatabase, id: number): Promise<LeadVersionDetail> {
  const version = (await db.execute<PgSummary>(sql`${summary} WHERE v.id = ${id}`)).rows[0]
  if (!version) throw createError({ statusCode: 404, message: '名单版本不存在' })
  const { rows } = await db.execute<PgRow>(sql`SELECT id, row_number AS "rowNumber", name, uscc, district, note,
    enterprise_id AS "enterpriseId" FROM lead_list_row WHERE version_id = ${id} ORDER BY row_number`)
  return { ...versionDto(version), rows: rows.map(row => ({
    ...row, id: Number(row.id), rowNumber: Number(row.rowNumber),
    enterpriseId: row.enterpriseId === null ? null : Number(row.enterpriseId),
  })) }
}

export async function readPostgresLeadVersionSource(db: NodePgDatabase, id: number) {
  const { rows } = await db.execute<PgFile & { versionSha: string }>(sql`SELECT ${fileColumns}, v.file_sha256 AS "versionSha"
    FROM lead_list_version v JOIN stored_file f ON f.id = v.file_id WHERE v.id = ${id}`)
  const row = rows[0]
  if (!row || row.removedAt) throw createError({ statusCode: 404, message: '原文件不存在或已移出' })
  return { ...fileDto(row), versionSha: row.versionSha }
}

export async function registerPostgresLeadVersion(db: NodePgDatabase, root: string, input: VersionInput) {
  const { rows, ...fields } = input
  const registered = (await db.execute<PgFile>(sql`SELECT ${fileColumns} FROM stored_file f WHERE f.id = ${fields.fileId}`)).rows[0]
  if (!registered || registered.removedAt) throw createError({ statusCode: 404, message: '原文件不存在或已移出' })
  const file = fileDto(registered)
  const verified = await verifyRegisteredFileRead(root, file)
  if (verified.status !== 'verified') throw createError({ statusCode: 409, message: '无法确认原文件内容' })
  const ranked = rows.toSorted((a, b) => a.rowNumber - b.rowNumber)
  const requestHash = createHash('sha256').update(JSON.stringify({ ...fields, rows: ranked, sha256: file.sha256 })).digest('hex')

  return db.transaction(async tx => {
    const live = (await tx.execute<PgFile>(sql`SELECT ${fileColumns} FROM stored_file f WHERE f.id = ${file.fileId} FOR UPDATE`)).rows[0]
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
