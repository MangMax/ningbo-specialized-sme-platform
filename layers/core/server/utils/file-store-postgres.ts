import { and, asc, count, eq, inArray, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { filePhysicalIntent, storedFile } from '../../../../db/postgresql/file-tables'
import { postgresFileCategoryRules, serverFileCategories } from './file-category-runtime'
import type { FileCategoryServer } from './file-store'
import type { LogContext } from '../../lib/logging'
import { FileMaintenanceError, MAX_PAGE_SIZE, registerLandedFile, selectedFileFilters, UploadRegistrationError, type FileQuery, type FileRow, type ScannedFile } from './file-store-contract'

export type PostgresFileDb = NodePgDatabase

export function usePostgresFileDb() {
  return usePostgresDirectoryDb()
}

export function requirePostgresFileWrite() {
  if (process.env.NUXT_DB_READONLY === '1') {
    throw new FileMaintenanceError(503, 'PostgreSQL 文件库处于只读模式')
  }
}

function baseFile(row: typeof storedFile.$inferSelect): FileRow {
  return { ...row, displayName: row.displayName ?? row.filename, bytes: Number(row.bytes) }
}

export function postgresFileIdentity(row: Pick<FileRow, 'id' | 'relPath' | 'sha256' | 'bytes'>) {
  return { fileId: row.id, relPath: row.relPath, sha256: row.sha256, bytes: row.bytes }
}

function withIdentity(file: FileRow): FileRow {
  return { ...file, contentIdentity: { registered: postgresFileIdentity(file), status: 'unknown', historical: 'unknown' } }
}

async function readFileIdentities(db: PostgresFileDb, where: SQL) {
  const rows = await db.select({
    id: storedFile.id, relPath: storedFile.relPath, sha256: storedFile.sha256, bytes: storedFile.bytes,
  }).from(storedFile).where(where)
  return rows.map(file => postgresFileIdentity({ ...file, bytes: Number(file.bytes) }))
}

export async function readPostgresFileIdentity(db: PostgresFileDb, locator: number | string) {
  if (typeof locator === 'number' && !Number.isSafeInteger(locator)) return null
  const where = typeof locator === 'number' ? eq(storedFile.id, locator) : eq(storedFile.relPath, locator)
  return (await readFileIdentities(db, where))[0] ?? null
}

export async function readPostgresFileIdentities(db: PostgresFileDb, paths: string[]) {
  // Drizzle inArray binds each element separately. ANY keeps the unbounded path batch
  // in a single bound array, below PostgreSQL's per-statement parameter limit.
  const rows = await readFileIdentities(db, sql`${storedFile.relPath} = ANY(${sql.param(paths.filter(path => !path.includes('\0')))}::text[])`)
  const byPath = new Map(rows.map(row => [row.relPath, row]))
  return paths.map(path => byPath.get(path) ?? null)
}

export async function lockPostgresFile(db: PostgresFileDb, id: number) {
  const rows = await db.select({ id: storedFile.id }).from(storedFile).where(eq(storedFile.id, id)).for('update')
  if (!rows.length) throw new FileMaintenanceError(404, '文件不存在')
}

export async function readPostgresFile(db: PostgresFileDb, locator: number | string) {
  const where = typeof locator === 'number' ? eq(storedFile.id, locator) : eq(storedFile.relPath, locator)
  const [file] = await db.select().from(storedFile).where(where)
  if (!file) throw new FileMaintenanceError(404, '文件不存在')
  return (await withFileFields(db, [withIdentity(baseFile(file))], serverFileCategories))[0]!
}

async function withFileReferences(db: PostgresFileDb, files: FileRow[], categories: readonly FileCategoryServer[] = serverFileCategories) {
  if (!files.length) return files
  const ids = files.map(file => file.id)
  const counts = new Map<number, number>()
  for (const category of categories) {
    const addReferences = category.postgres?.countReferences
    if (!addReferences) continue
    for (const [id, count] of await addReferences(db, ids)) {
      counts.set(id, (counts.get(id) ?? 0) + count)
    }
  }
  return files.map(file => ({ ...file, referenceCount: counts.get(file.id) ?? 0 }))
}

async function withFileFields(db: PostgresFileDb, files: FileRow[], categories: readonly FileCategoryServer[]): Promise<Array<FileRow & Record<string, unknown>>> {
  const ids = files.map(file => file.id)
  const fields: ReadonlyMap<number, object>[] = []
  for (const category of categories) {
    if (category.postgres?.readFields) fields.push(await category.postgres.readFields(db, ids))
  }
  const referenced = await withFileReferences(db, files, categories)
  return referenced.map(file => Object.assign({}, file, ...fields.map(byId => byId.get(file.id))))
}

export function listPostgresFiles(
  db: PostgresFileDb,
  params: FileQuery & Record<string, unknown>,
  view?: { categories: readonly FileCategoryServer[]; membership?: SQL },
) {
  const page = params.page ?? 1
  const pageSize = Math.min(MAX_PAGE_SIZE, params.pageSize ?? 50)
  const offset = (BigInt(page) - BigInt(1)) * BigInt(pageSize)
  // Drizzle has no translate or COLLATE API. SQLite LIKE folds ASCII case only
  // and treats backslashes literally. Escape backslashes for PostgreSQL's LIKE.
  const foldAscii = (column: typeof storedFile.filename | typeof storedFile.displayName) =>
    sql`translate(${column}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE "C"`
  const pattern = params.q ? `%${params.q.replace(/[A-Z]/g, letter => letter.toLowerCase()).replaceAll('\\', '\\\\')}%` : undefined
  const search = pattern === undefined ? undefined : pattern.includes('\0') ? inArray(storedFile.id, []) :
    or(like(foldAscii(storedFile.displayName), pattern), like(foldAscii(storedFile.filename), pattern))
  const conditions = [params.includeRemoved ? undefined : isNull(storedFile.removedAt), search]
  if (view) {
    if (view.membership) conditions.push(view.membership)
    for (const category of view.categories) {
      const filters = selectedFileFilters(category.filters ?? [], params)
      if (!Object.keys(filters).length) continue
      const constraint = category.postgres?.constraint
      if (!constraint) throw createError({ statusCode: 503, message: '业务文件筛选尚未接入 PostgreSQL 文件库' })
      const condition = constraint(filters)
      if (condition) conditions.push(condition)
    }
  }
  const where = and(...conditions)
  const order = [
    ...(view?.categories.flatMap(category => category.postgres?.orderBy ?? []) ?? []),
    sql`${storedFile.filename} COLLATE "C"`, asc(storedFile.id),
  ]

  return db.transaction(async tx => {
    const [counted] = await tx.select({ total: count() }).from(storedFile).where(where)
    const total = counted!.total
    if (offset >= BigInt(total)) return { rows: [], total }
    const rows = await tx.select().from(storedFile).where(where)
      .orderBy(...order).limit(pageSize).offset(Number(offset))
    const files = rows.map(row => withIdentity(baseFile(row)))
    if (!view) return { rows: files, total }
    return { rows: await withFileFields(tx, files, view.categories), total }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function activePostgresPhysicalIntent(db: PostgresFileDb, id: number) {
  const [intent] = await db.select({ state: filePhysicalIntent.state }).from(filePhysicalIntent)
    .where(and(eq(filePhysicalIntent.fileId, id), ne(filePhysicalIntent.state, 'recovered')))
  return intent?.state
}

export async function lockOrRegisterPostgresFile(db: PostgresFileDb, facts: ScannedFile) {
  const { relPath, filename, ext, bytes, sha256 } = facts
  const find = () => db.select().from(storedFile).where(eq(storedFile.relPath, relPath)).for('update')
  const [existing] = await find()
  if (existing) return { row: baseFile(existing), created: false }

  const [created] = await db.insert(storedFile)
    .values({ relPath, filename, ext, bytes: BigInt(bytes), sha256, createdAt: new Date().toISOString() })
    .onConflictDoNothing({ target: storedFile.relPath }).returning()
  return created ? { row: baseFile(created), created: true } : { row: baseFile((await find())[0]!), created: false }
}

export async function registerPostgresFile(db: PostgresFileDb, root: string, body: unknown, context: LogContext) {
  requirePostgresFileWrite()
  const { checkAdmission, resolveFileRegistration } = postgresFileCategoryRules
  const { registration: { preparePostgres }, relPath, input } = resolveFileRegistration(body)
  if (!preparePostgres) {
    throw new UploadRegistrationError('此文件分类尚未接入 PostgreSQL 文件库', 503)
  }
  return registerLandedFile(root, relPath, async () => {
    const writer = await preparePostgres(input)
    return file => writer(db, file)
  }, checkAdmission, context)
}
