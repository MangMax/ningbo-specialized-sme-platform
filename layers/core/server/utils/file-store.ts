import { readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { and, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { baseName, directoryOf, extensionOf, siblingIndex } from '../../lib/core/file-path'
import { type evaluateFileAdmission, type FileAdmissionPolicy, type FileFilter, type FileLanding } from '../../lib/core/file-categories'
import { compareFileContentIdentity, type FileContentConflict } from './file-content-identity'
import type { LogContext } from '../../lib/logging'
import {
  FileMaintenanceError, MAX_PAGE_SIZE, registerLandedFile, selectedFileFilters, sha256Of,
  verifyFileRestorationBytes,
  type FileQuery, type FileQueryFilters, type FileRegistrationResult, type FileRow, type RegistrationFile, type ScannedFile,
} from './file-store-contract'

export * from './file-store-contract'
import { createFileCategoryRules } from './file-category-rules'

export type FileStoreDb = BetterSQLite3Database<typeof schema>

export type RegistrationWriter<Database = FileStoreDb> = (db: Database, file: RegistrationFile) => Promise<FileRegistrationResult>

export interface FileCategoryServer {
  readonly id: string
  readonly admission?: FileAdmissionPolicy
  readonly filters?: readonly FileFilter[]
  readonly readFields?: (db: FileStoreDb, ids: readonly number[]) => ReadonlyMap<number, object>
  readonly constraint?: (db: FileStoreDb, filters: FileQueryFilters) => SQL | undefined
  readonly orderBy?: readonly SQL[]
  readonly postgres?: {
    readonly constraint?: (filters: FileQueryFilters) => SQL | undefined
    readonly countReferences?: (db: NodePgDatabase, ids: readonly number[]) => Promise<ReadonlyMap<number, number>>
    readonly readFields?: (db: NodePgDatabase, ids: readonly number[]) => Promise<ReadonlyMap<number, object>>
    readonly orderBy?: readonly SQL[]
  }
  /** Return null to leave the path to another registered category. */
  readonly prepareBackfill?: (path: string) => ((db: FileStoreDb, fileId: number) => void) | null
  readonly metadata?: {
    readonly properties: Record<string, object>
    parse(input: Record<string, unknown>): object
    write?(db: FileStoreDb, id: number, patch: Record<string, unknown>): boolean
    writePostgres?(db: NodePgDatabase, file: FileRow, patch: Record<string, unknown>): Promise<boolean>
  }
  readonly landing?: FileLanding
  /** Handles unqualified uploads and registration paths unclaimed by other contributions. */
  readonly defaultLanding?: boolean
  readonly registration?: {
    /** Claims a path for registration even when the request omits fileCategory. */
    matchesPath(relPath: string): boolean
    /** Validates the declaration and returns a writer that runs only after admission. */
    prepare?(input: Record<string, unknown>): RegistrationWriter | Promise<RegistrationWriter>
    preparePostgres?(input: Record<string, unknown>): RegistrationWriter<NodePgDatabase> | Promise<RegistrationWriter<NodePgDatabase>>
  }
  readonly snapshot?: (fields: FileRow) => Record<string, unknown>
  readonly openAPI?: {
    readonly listDescription?: string
    readonly rowProperties?: Record<string, object>
  }
}

type CategoryFields<C> = C extends { readFields: (...args: never[]) => ReadonlyMap<number, infer Fields> }
  ? Fields : never
type UnionToIntersection<U> = (U extends unknown ? (fields: U) => void : never) extends (fields: infer I) => void
  ? I : never

const fileColumns = {
  id: schema.storedFile.id,
  relPath: schema.storedFile.relPath,
  displayName: sql<string>`coalesce(${schema.storedFile.displayName}, ${schema.storedFile.filename})`,
  filename: schema.storedFile.filename,
  ext: schema.storedFile.ext,
  bytes: schema.storedFile.bytes,
  sha256: schema.storedFile.sha256,
  createdAt: schema.storedFile.createdAt,
  removedAt: schema.storedFile.removedAt,
}
type FileColumnsRow = ReturnType<typeof readBaseRows>[number]
function readBaseRows(db: FileStoreDb, where: SQL | undefined) {
  return db.select(fileColumns).from(schema.storedFile).where(where).all()
}

/** 跳过系统/临时文件(以 `.` 或 `~` 开头):`.DS_Store`、`.~xxx.docx`、`~$xxx`。 */
function isSystemFile(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~')
}

/** Prepare the declaration, then enforce disk admission before calling any category writer. */
export async function runFileRegistration(
  db: FileStoreDb,
  root: string,
  relPath: string,
  prepare: () => RegistrationWriter | Promise<RegistrationWriter>,
  checkAdmission: (path: string, siblings: ReadonlySet<string>) => ReturnType<typeof evaluateFileAdmission>,
  context: LogContext,
): Promise<FileRegistrationResult> {
  return registerLandedFile(root, relPath, async () => {
    const write = await prepare()
    return file => write(db, file)
  }, checkAdmission, context)
}

/**
 * 递归扫描文件库根下的所有**数据文件**(跳过 `README.md` 与系统/临时文件)。
 *
 * 返回相对根的路径,`/` 分隔。
 */
export async function scanFileStore(root: string): Promise<ScannedFile[]> {
  const absRoot = resolve(root)
  const out: ScannedFile[] = []

  async function walk(dir: string): Promise<void> {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (isSystemFile(d.name)) continue
      const abs = join(dir, d.name)
      if (d.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!d.isFile()) continue
      // 文件库的说明文档不是数据文件,不入表。
      if (abs === join(absRoot, 'README.md')) continue
      const info = await stat(abs)
      const relPath = abs.slice(absRoot.length + 1).split(sep).join('/')
      out.push({
        relPath,
        filename: baseName(relPath),
        ext: extensionOf(baseName(relPath)),
        bytes: info.size,
        sha256: await sha256Of(abs),
      })
    }
  }

  await walk(absRoot)
  // 稳定顺序:让回填的插入次序可预期(便于人工核对与测试断言)。
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

export interface BackfillExclusion { relPath: string; reason: string; detail: string }

export interface BackfillStats {
  inserted: number
  updated: number
  unchanged: number
  conflicts?: FileContentConflict[]
  skipped: string[]
  excluded: BackfillExclusion[]
}

export function createFileStore<const Categories extends readonly FileCategoryServer[]>(registered: Categories) {
  type Row = FileRow & Record<string, unknown> & Partial<UnionToIntersection<CategoryFields<Categories[number]>>>
  const categories: readonly FileCategoryServer[] = registered
  const filtersByCategory = categories.flatMap(category => category.filters?.length ? [{ category, filters: category.filters }] : [])
  const backfillCategories = categories.flatMap(category => category.prepareBackfill ? [category.prepareBackfill] : [])
  const metadataByKey = new Map(categories.flatMap(category => category.metadata
    ? Object.keys(category.metadata.properties).map(key => [key, category.metadata!] as const)
    : []))
  const { checkAdmission, resolveUploadPlacement, resolveFileRegistration, divideMetadata, parseMetadataPatch,
    updatePostgresFileMetadata, extensionSnapshot } = createFileCategoryRules(categories)
  const rollbackMetadata = Symbol('metadata write declined')

  function extendRows(db: FileStoreDb, rows: FileColumnsRow[]): Row[] {
    if (!rows.length) return []
    const ids = rows.map(row => row.id)
    const fields = categories.map(category => category.readFields?.(db, ids))
    return rows.map(row => {
      const contributions = fields.map(byId => byId?.get(row.id))
      const counts = contributions.flatMap(fields =>
        fields && 'referenceCount' in fields && typeof fields.referenceCount === 'number' ? [fields.referenceCount] : [])
      return Object.assign({
        ...row,
        contentIdentity: {
          registered: { fileId: row.id, relPath: row.relPath, sha256: row.sha256, bytes: row.bytes },
          status: 'unknown' as const,
          historical: 'unknown' as const,
        },
      }, ...contributions, counts.length ? { referenceCount: counts.reduce((sum, count) => sum + count, 0) } : {}) as Row
    })
  }

  function listStoredFiles(db: FileStoreDb, params: FileQuery & Record<string, unknown> = {}, membership?: SQL) {
    return db.transaction(tx => {
      const where = and(
        membership,
        params.includeRemoved ? undefined : isNull(schema.storedFile.removedAt),
        params.q ? or(
          like(schema.storedFile.displayName, `%${params.q}%`),
          like(schema.storedFile.filename, `%${params.q}%`),
        ) : undefined,
        ...filtersByCategory.map(({ category, filters }) => {
          const selected = selectedFileFilters(filters, params)
          return Object.keys(selected).length ? category.constraint?.(tx, selected) : undefined
        }),
      )
      const page = Math.max(1, params.page ?? 1)
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 50))
      const total = tx.select({ n: sql<number>`count(*)` }).from(schema.storedFile).where(where).get()!.n
      const rows = tx.select(fileColumns).from(schema.storedFile).where(where)
        .orderBy(...categories.flatMap(category => category.orderBy ?? []), schema.storedFile.filename, schema.storedFile.id)
        .limit(pageSize).offset((page - 1) * pageSize).all()
      return { rows: extendRows(tx, rows), total }
    })
  }

  function getStoredFile(db: FileStoreDb, id: number): Row | null {
    return db.transaction(tx => {
      const rows = readBaseRows(tx, eq(schema.storedFile.id, id))
      return extendRows(tx, rows)[0] ?? null
    })
  }

  /** 只更新用户可见名称并追加历史;`filename` / `relPath` 与磁盘内容保持不变。 */
  function renameStoredFileDisplayName(
    db: FileStoreDb,
    id: number,
    displayName: string,
  ): Row | null {
    return db.transaction((tx) => {
      const current = tx.select().from(schema.storedFile).where(eq(schema.storedFile.id, id)).get()
      if (!current) return null
      const oldDisplayName = current.displayName ?? current.filename
      if (oldDisplayName === displayName) return getStoredFile(tx, id)

      tx.update(schema.storedFile)
        .set({ displayName: displayName === current.filename ? null : displayName })
        .where(eq(schema.storedFile.id, id))
        .run()
      tx.insert(schema.storedFileAudit)
        .values({ storedFileId: id, oldDisplayName, newDisplayName: displayName })
        .run()
      return getStoredFile(tx, id)
    })
  }

  /** Restore only the original registered bytes. Never reimport events or refresh disk facts. */
  async function verifyStoredFileRestoration(db: FileStoreDb, root: string, id: number): Promise<Row> {
    const current = getStoredFile(db, id)
    if (!current) throw new FileMaintenanceError(404, '文件不存在')
    await verifyFileRestorationBytes(root, current)
    return current
  }

  function restoreVerifiedStoredFile(db: FileStoreDb, current: Row): Row {
    const id = current.id
    return db.transaction((tx) => {
      const latest = getStoredFile(tx, id)!
      if (latest.sha256 !== current.sha256 || latest.bytes !== current.bytes || latest.removedAt !== current.removedAt) {
        throw new FileMaintenanceError(409, '文件状态已变化,请重新读取')
      }
      tx.update(schema.storedFile).set({ removedAt: null }).where(eq(schema.storedFile.id, id)).run()
      return getStoredFile(tx, id)!
    })
  }

  /** Synchronous soft removal participates in the caller's audit transaction. */
  function softRemoveStoredFile(db: FileStoreDb, id: number): Row | null {
    const current = getStoredFile(db, id)
    if (!current || current.removedAt) return current
    db.update(schema.storedFile).set({ removedAt: new Date().toISOString() }).where(eq(schema.storedFile.id, id)).run()
    return getStoredFile(db, id)
  }

  function backfillStoredFiles(
    db: FileStoreDb,
    scanned: ScannedFile[],
  ): BackfillStats {
    const stats: BackfillStats = { inserted: 0, updated: 0, unchanged: 0, skipped: [], excluded: [] }
    const siblings = siblingIndex(scanned.map((f) => f.relPath))
    const existing = new Map(
      db
        .select()
        .from(schema.storedFile)
        .all()
        .map((row) => [row.relPath, row]),
    )

    for (const f of scanned) {
      const scope = checkAdmission(f.relPath, siblings.get(directoryOf(f.relPath)))
      if (scope) {
        stats.excluded.push({ relPath: f.relPath, reason: scope.reason, detail: scope.detail })
        continue
      }
      const writes = backfillCategories.map(prepare => prepare(f.relPath)).filter(write => write !== null)
      if (backfillCategories.length && !writes.length) {
        stats.skipped.push(f.relPath)
        continue
      }
      const row = existing.get(f.relPath)
      if (!row) {
        db.transaction(tx => {
          const inserted = tx.insert(schema.storedFile).values(f).returning({ id: schema.storedFile.id }).get()
          for (const write of writes) write(tx, inserted.id)
        })
        stats.inserted += 1
        continue
      }
      // 已移出库的:不复活。
      if (row.removedAt) continue
      const conflict = compareFileContentIdentity({ ...row, fileId: row.id }, f)
      if (conflict) {
        (stats.conflicts ??= []).push(conflict)
        continue
      }
      if (row.filename === f.filename && row.bytes === f.bytes && row.sha256 === f.sha256) {
        stats.unchanged += 1
        continue
      }
      db.update(schema.storedFile)
        .set({ filename: f.filename, ext: f.ext })
        .where(eq(schema.storedFile.id, row.id))
        .run()
      stats.updated += 1
    }

    return stats
  }

  /** 扫描 + 回填。文件库根默认取 `runtimeConfig.filesDir`。 */
  async function backfillFromDisk(db: FileStoreDb, root: string): Promise<BackfillStats> {
    return backfillStoredFiles(db, await scanFileStore(root))
  }

  function registerUploadedFile(db: FileStoreDb, root: string, body: unknown, context: LogContext) {
    const { registration, relPath, input } = resolveFileRegistration(body)
    const prepare = registration.prepare
    if (!prepare) throw new Error('File category does not support SQLite registration')
    return runFileRegistration(db, root, relPath, () => prepare(input), checkAdmission, context)
  }

  function updateStoredFile(db: FileStoreDb, id: number, patch: object): Row | null {
    const groups = divideMetadata(patch)
    try {
      return db.transaction(tx => {
        for (const [owner, fields] of groups) {
          if (!owner.write?.(tx, id, fields)) throw rollbackMetadata
        }
        return getStoredFile(tx, id)
      }, { behavior: 'immediate' })
    } catch (error) {
      if (error === rollbackMetadata) return null
      throw error
    }
  }

  return {
    parseMetadataPatch, updateStoredFile, updatePostgresFileMetadata, resolveUploadPlacement, resolveFileRegistration, registerUploadedFile,
    checkAdmission, listStoredFiles, getStoredFile, extensionSnapshot,
    renameStoredFileDisplayName, verifyStoredFileRestoration, restoreVerifiedStoredFile,
    softRemoveStoredFile, backfillStoredFiles, backfillFromDisk,
  }
}
