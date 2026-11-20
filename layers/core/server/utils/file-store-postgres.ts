import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { libraryUploadCategory } from '../../lib/core/library-uploads'
import { checkAdmission, resolveFileRegistration, serverFileCategories } from '../../../../server/file-store'
import type { LogContext } from '../../lib/logging'
import { compareFileContentIdentity } from './file-content-identity'
import { FileMaintenanceError, MAX_PAGE_SIZE, registerLandedFile, selectedFileFilters, UploadRegistrationError, type FileQuery, type FileRow } from './file-store'
import { libraryFileFacts, validateLibraryRegistration } from './library-file-category'

export type PostgresFileDb = NodePgDatabase

export function usePostgresFileDb() {
  if (process.env.NUXT_POSTGRES_FILE_LIBRARY !== '1') return
  const db = usePostgresDirectoryDb()
  if (!db) throw createError({ statusCode: 503, message: '文件库 PostgreSQL 验收未配置' })
  return db
}

export function requirePostgresFileWrite() {
  if (process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1') {
    throw new FileMaintenanceError(503, 'PostgreSQL 文件库处于只读模式')
  }
}

type PgFile = Omit<FileRow, 'id' | 'bytes'> & {
  id: string
  bytes: string
}

const columns = sql`id, rel_path AS "relPath", coalesce(display_name, filename) AS "displayName",
  filename, ext, bytes, sha256, created_at AS "createdAt", removed_at AS "removedAt"`

function baseFile(row: PgFile) {
  return { ...row, id: Number(row.id), bytes: Number(row.bytes) }
}

export function postgresFileIdentity(row: Pick<FileRow, 'id' | 'relPath' | 'sha256' | 'bytes'>) {
  return { fileId: row.id, relPath: row.relPath, sha256: row.sha256, bytes: row.bytes }
}

function withIdentity(file: FileRow): FileRow {
  return { ...file, contentIdentity: { registered: postgresFileIdentity(file), status: 'unknown', historical: 'unknown' } }
}

export async function readPostgresFileIdentity(db: PostgresFileDb, locator: number | string) {
  const where = typeof locator === 'number' ? sql`id = ${locator}` : sql`rel_path = ${locator}`
  if (typeof locator === 'number' && !Number.isSafeInteger(locator)) return null
  const { rows: [file] } = await db.execute<{ id: string; relPath: string; sha256: string; bytes: string }>(sql`
    SELECT id, rel_path AS "relPath", sha256, bytes FROM stored_file WHERE ${where}`)
  return file ? postgresFileIdentity({ ...file, id: Number(file.id), bytes: Number(file.bytes) }) : null
}

/** Lead registration locks this same stored_file row before inspecting physical intents. */
export async function lockPostgresFile(db: PostgresFileDb, id: number) {
  const { rows } = await db.execute(sql`SELECT id FROM stored_file WHERE id = ${id} FOR UPDATE`)
  if (!rows.length) throw new FileMaintenanceError(404, '文件不存在')
}

export async function readPostgresFile(db: PostgresFileDb, id: number) {
  const { rows: [file] } = await db.execute<PgFile>(sql`
    SELECT ${columns} FROM stored_file WHERE id = ${id}`)
  if (!file) throw new FileMaintenanceError(404, '文件不存在')
  return (await withFileReferences(db, [withIdentity(baseFile(file))]))[0]!
}

async function withFileReferences(db: PostgresFileDb, files: FileRow[]) {
  if (!files.length) return files
  const ids = files.map(file => file.id)
  const { rows } = await db.execute<{ rel_path: string; reference_count: string }>(sql`
    SELECT rel_path, reference_count FROM file_roster_reference_baseline
    WHERE rel_path IN (${sql.join(files.map(file => sql`${file.relPath}`), sql`, `)})`)
  const legacy = new Map(rows.map(row => [row.rel_path, Number(row.reference_count)]))
  const counts = new Map(files.map(file => [file.id, legacy.get(file.relPath) ?? 0]))
  for (const category of serverFileCategories) {
    const addReferences = category.postgres?.countReferences
    if (!addReferences) continue
    for (const [id, count] of await addReferences(db, ids)) {
      counts.set(id, (counts.get(id) ?? 0) + count)
    }
  }
  return files.map(file => ({ ...file, referenceCount: counts.get(file.id) ?? 0 }))
}

export function listPostgresFiles(db: PostgresFileDb, params: FileQuery & Record<string, unknown>, withReferences = false) {
  const page = params.page ?? 1
  const pageSize = Math.min(MAX_PAGE_SIZE, params.pageSize ?? 50)
  const offset = (BigInt(page) - BigInt(1)) * BigInt(pageSize)
  const asciiLower = (column: ReturnType<typeof sql>) => sql`translate(${column}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE "C"`
  const pattern = params.q ? `%${params.q.replace(/[A-Z]/g, letter => letter.toLowerCase())}%` : undefined
  // SQLite LIKE folds ASCII case only and treats a backslash literally.
  const search = pattern === undefined ? sql`TRUE` : pattern.includes('\0') ? sql`FALSE` : sql`
    (${asciiLower(sql`stored_file.display_name`)} LIKE ${pattern} ESCAPE '' OR ${asciiLower(sql`stored_file.filename`)} LIKE ${pattern} ESCAPE '')`
  const conditions = [params.includeRemoved ? sql`TRUE` : sql`stored_file.removed_at IS NULL`, search]
  if (withReferences) {
    for (const category of serverFileCategories) {
      const filters = selectedFileFilters(category.filters ?? [], params)
      if (!Object.keys(filters).length) continue
      const constraint = category.postgres?.constraint
      if (!constraint) throw createError({ statusCode: 503, message: '业务文件筛选尚未接入 PostgreSQL 文件库' })
      const condition = constraint(filters)
      if (condition) conditions.push(condition)
    }
  }
  const where = sql`WHERE ${sql.join(conditions, sql` AND `)}`

  return db.transaction(async tx => {
    const { rows: [total] } = await tx.execute<{ total: string }>(sql`SELECT count(*) AS total FROM stored_file ${where}`)
    if (offset >= BigInt(total!.total)) return { rows: [], total: Number(total!.total) }
    const { rows } = await tx.execute<PgFile>(sql`SELECT ${columns} FROM stored_file ${where}
      ORDER BY stored_file.filename COLLATE "C", stored_file.id LIMIT ${pageSize} OFFSET ${String(offset)}`)
    const files = rows.map(row => withIdentity(baseFile(row)))
    return { rows: withReferences ? await withFileReferences(tx, files) : files, total: Number(total!.total) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function activePostgresPhysicalIntent(db: PostgresFileDb, id: number) {
  const { rows: [intent] } = await db.execute<{ state: string }>(sql`
    SELECT state FROM file_physical_intent WHERE file_id = ${id} AND state <> 'recovered'`)
  return intent?.state
}

export async function registerPostgresLibraryFile(db: PostgresFileDb, root: string, body: unknown, context: LogContext) {
  requirePostgresFileWrite()
  const { category, relPath, input } = resolveFileRegistration(body)
  if (category !== libraryUploadCategory) {
    throw new UploadRegistrationError('此文件分类尚未接入 PostgreSQL 文件库', 503)
  }
  return registerLandedFile(root, relPath, async () => {
    validateLibraryRegistration(input)
    return async file => {
      const facts = await libraryFileFacts(file)
      return db.transaction(async tx => {
        const find = () => tx.execute<PgFile>(sql`SELECT ${columns} FROM stored_file WHERE rel_path = ${relPath} FOR UPDATE`)
        let { rows: [existing] } = await find()
        if (!existing) {
          const { rows: [created] } = await tx.execute<PgFile>(sql`
            INSERT INTO stored_file (rel_path, filename, ext, bytes, sha256, created_at)
            VALUES (${relPath}, ${facts.filename}, ${facts.ext}, ${facts.bytes}, ${facts.sha256}, ${new Date().toISOString()})
            ON CONFLICT (rel_path) DO NOTHING RETURNING ${columns}`)
          if (created) return { row: baseFile(created), created: true }
          existing = (await find()).rows[0]
        }
        const row = baseFile(existing!)
        const conflict = compareFileContentIdentity(postgresFileIdentity(row), facts)
        if (conflict) throw new UploadRegistrationError('当前内容与已登记文件不一致。', 409, conflict)
        if (row.removedAt || await activePostgresPhysicalIntent(tx, row.id)) throw new UploadRegistrationError('文件已移出文件库。', 409)
        return { row, created: false }
      })
    }
  }, checkAdmission, context)
}
