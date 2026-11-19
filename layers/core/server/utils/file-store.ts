import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { and, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { baseName, directoryOf, extensionOf, siblingIndex } from '../../lib/core/file-path'
import { evaluateFileAdmission, type FileAdmissionPolicy, type FileFilter, type FileLanding, type ResolveUploadPlacement } from '../../lib/core/file-categories'
import { compareFileContentIdentity, type FileContentConflict } from './file-content-identity'
import { appLog, type LogContext } from '../../lib/logging'

export type FileStoreDb = BetterSQLite3Database<typeof schema>

export interface FileQuery {
  q?: string
  includeRemoved?: boolean
  page?: number
  pageSize?: number
}

export type FileQueryFilters = Readonly<Record<string, readonly string[] | undefined>>

export interface FileRegistrationResult {
  row: FileRow
  created: boolean
}

interface RegistrationFile {
  relPath: string
  filename: string
  abs: string
  bytes: number
}

export type RegistrationWriter = (db: FileStoreDb, file: RegistrationFile) => Promise<FileRegistrationResult>

export class UploadRegistrationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly conflict?: FileContentConflict,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'UploadRegistrationError'
  }
}

export interface FileCategoryServer {
  readonly id: string
  readonly admission?: FileAdmissionPolicy
  readonly filters?: readonly FileFilter[]
  readonly readFields?: (db: FileStoreDb, ids: readonly number[]) => ReadonlyMap<number, object>
  readonly constraint?: (db: FileStoreDb, filters: FileQueryFilters) => SQL | undefined
  readonly orderBy?: readonly SQL[]
  /** Return null to leave the path to another registered category. */
  readonly prepareBackfill?: (path: string) => ((db: FileStoreDb, fileId: number) => void) | null
  readonly metadata?: {
    readonly properties: Record<string, object>
    parse(input: Record<string, unknown>): object
    write(db: FileStoreDb, id: number, patch: Record<string, unknown>): boolean
  }
  readonly landing?: FileLanding
  /** Handles unqualified uploads and registration paths unclaimed by other contributions. */
  readonly defaultLanding?: boolean
  readonly registration?: {
    /** Claims a path for registration even when the request omits fileCategory. */
    matchesPath(relPath: string): boolean
    /** Validates the declaration and returns a writer that runs only after admission. */
    prepare(input: Record<string, unknown>): RegistrationWriter | Promise<RegistrationWriter>
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

export type FileRow = FileColumnsRow & {
  referenceCount?: number
  contentIdentity?: { registered: { fileId: number; relPath: string; sha256: string; bytes: number }; status: 'unknown'; historical: 'unknown' }
}

export const MAX_PAGE_SIZE = 200

/** 扫描到的磁盘事实。 */
export interface ScannedFile {
  relPath: string
  filename: string
  ext: string
  bytes: number
  sha256: string
}

/** 跳过系统/临时文件(以 `.` 或 `~` 开头):`.DS_Store`、`.~xxx.docx`、`~$xxx`。 */
function isSystemFile(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~')
}

/** 计算文件的 SHA-256(流式,避免把大文件整个读进内存)。 */
export function sha256Of(absPath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/**
 * 把一个库内相对路径**锁在文件库根内**,返回绝对路径;越界返回 `null`。
 *
 * 用 `resolve` 之后再比对前缀,而不是字符串过滤 `..` —— 符号链接与编码变体都绕不过
 * resolve。加 `sep` 是为了避免 `/root-evil` 被 `/root` 前缀匹配上。
 *
 * 三个地方需要同一条判据(回填/删除、预览路由、上传登记),各写一份的话
 * 修一处漏两处 —— 故收在这一处。
 */
export function resolveInsideRoot(root: string, relPath: string): string | null {
  const base = resolve(root)
  const abs = resolve(join(base, relPath))
  if (abs !== base && !abs.startsWith(base + sep)) return null
  return abs
}

export function splitRegistrationPath(relPath: string): string[] {
  const segments = relPath.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
    throw new UploadRegistrationError(`落位路径非法:${relPath}`)
  }
  return segments
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
  const startedAt = Date.now()
  try {
    const write = await prepare()
    const filename = splitRegistrationPath(relPath).at(-1)!
    const abs = resolveInsideRoot(root, relPath)
    if (!abs) throw new UploadRegistrationError(`落位路径越界:${relPath}`)
    let info
    try {
      info = await stat(abs)
    } catch {
      throw new UploadRegistrationError(`落位文件不存在:${relPath}`)
    }
    if (!info.isFile()) throw new UploadRegistrationError(`落位路径不是一个文件:${relPath}`)
    const siblings = await readdir(dirname(abs), { withFileTypes: true })
    const exclusion = checkAdmission(relPath, new Set(siblings.filter(entry => entry.isFile()).map(entry => entry.name)))
    if (exclusion) throw new UploadRegistrationError(exclusion.detail, 400, undefined, exclusion.reason)

    const result = await write(db, { relPath, filename, abs, bytes: info.size })
    appLog({ module: 'core', source: 'file', operation: result.created ? 'file.register' : 'file.register.refresh', outcome: 'success', fileId: result.row.id, durationMs: Date.now() - startedAt }, context)
    return result
  } catch (error) {
    appLog({ module: 'core', source: 'file', operation: 'file.register', outcome: error instanceof UploadRegistrationError ? 'denied' : 'failure', level: 'error', errorCode: error instanceof UploadRegistrationError ? 'file_registration_rejected' : 'file_registration_failed', durationMs: Date.now() - startedAt }, context)
    throw error
  }
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

/** 解析用户可见文件名。这个字段不会被用于路径或磁盘操作。 */
export function parseDisplayNamePatch(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('请求体必须是对象')
  }
  const patch = body as Record<string, unknown>
  const keys = Object.keys(patch)
  if (keys.length !== 1 || keys[0] !== 'displayName') {
    throw new Error('改显示名称时只能提供 displayName')
  }
  if (typeof patch.displayName !== 'string') throw new Error('显示名称必须是字符串')
  const displayName = patch.displayName.trim()
  if (!displayName) throw new Error('显示名称不能为空')
  if (Array.from(displayName).length > 255) throw new Error('显示名称不能超过 255 个字符')
  if (/[\u0000-\u001f\u007f-\u009f]/.test(displayName)) throw new Error('显示名称不能包含控制字符')
  return displayName
}

export class FileMaintenanceError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}

export function createFileStore<const Categories extends readonly FileCategoryServer[]>(registered: Categories) {
  type Row = FileRow & Record<string, unknown> & Partial<UnionToIntersection<CategoryFields<Categories[number]>>>
  const categories: readonly FileCategoryServer[] = registered
  const filtersByCategory = categories.flatMap(category => category.filters?.length ? [{ category, filters: category.filters }] : [])
  const backfillCategories = categories.flatMap(category => category.prepareBackfill ? [category.prepareBackfill] : [])
  const metadataByKey = new Map(categories.flatMap(category => category.metadata
    ? Object.keys(category.metadata.properties).map(key => [key, category.metadata!] as const)
    : []))
  for (const category of categories) {
    if (category.registration && typeof category.registration.matchesPath !== 'function') {
      throw new Error(`${category.id}: registration requires matchesPath`)
    }
    if (category.registration && typeof category.registration.prepare !== 'function') {
      throw new Error(`${category.id}: registration requires a writer`)
    }
    if (category.landing && !category.registration) {
      throw new Error(`${category.id}: upload placement requires registration`)
    }
  }
  const defaults = categories.filter(category => category.defaultLanding)
  if (defaults.length > 1) throw new Error('Multiple default file categories')
  const [defaultCategory] = defaults
  if (defaultCategory && !defaultCategory.landing) {
    throw new Error(`${defaultCategory.id}: default file category requires upload placement`)
  }
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

  function checkAdmission(relPath: string, siblings?: ReadonlySet<string>) {
    return evaluateFileAdmission(categories, relPath, siblings)
  }

  function listStoredFiles(db: FileStoreDb, params: FileQuery & Record<string, unknown> = {}) {
    return db.transaction(tx => {
      const where = and(
        params.includeRemoved ? undefined : isNull(schema.storedFile.removedAt),
        params.q ? or(
          like(schema.storedFile.displayName, `%${params.q}%`),
          like(schema.storedFile.filename, `%${params.q}%`),
        ) : undefined,
        ...filtersByCategory.map(({ category, filters }) => {
          const selected = Object.fromEntries(filters.flatMap(filter => {
            const raw = params[filter.key]
            const values = (Array.isArray(raw) ? raw : [raw])
              .flatMap(value => typeof value === 'string' ? value.split(',').map(part => part.trim()) : [])
              .filter(value => filter.options.some(option => option.value === value))
            return values.length ? [[filter.key, values]] : []
          }))
          return Object.keys(selected).length ? category.constraint?.(tx, selected) : undefined
        }),
      )
      const page = Math.max(1, params.page ?? 1)
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 50))
      const total = tx.select({ n: sql<number>`count(*)` }).from(schema.storedFile).where(where).get()!.n
      const rows = tx.select(fileColumns).from(schema.storedFile).where(where)
        .orderBy(...categories.flatMap(category => category.orderBy ?? []), schema.storedFile.filename)
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

  function extensionSnapshot(row: Row) {
    return Object.assign({}, ...categories.map(category => category.snapshot?.(row)))
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
    const abs = resolveInsideRoot(root, current.relPath)
    if (!abs) throw new FileMaintenanceError(409, '文件路径越界')
    try {
      const physicalRoot = await realpath(root)
      const physical = await realpath(abs)
      if (!physical.startsWith(physicalRoot + sep) || !(await lstat(abs)).isFile()) {
        throw new FileMaintenanceError(409, '恢复必须指向库内原始普通文件')
      }
      const before = await stat(abs)
      const hash = await sha256Of(abs)
      const after = await stat(abs)
      if (before.size !== current.bytes || hash !== current.sha256 || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new FileMaintenanceError(409, '文件字节数或哈希不匹配,不能恢复')
      }
    } catch (error) {
      if (error instanceof FileMaintenanceError) throw error
      throw new FileMaintenanceError(409, '恢复文件不存在或不可读取')
    }
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

  function registrationCategory(relPath: string) {
    const owners = categories.filter(category => category.registration?.matchesPath(relPath))
    if (owners.length > 1) throw new UploadRegistrationError('落位路径匹配多个上传分类')
    return owners[0] ?? defaultCategory
  }

  const resolveUploadPlacement: ResolveUploadPlacement = metadata => {
    const requested = metadata.fileCategory
    const category = requested ? categories.find(item => item.id === requested) : defaultCategory
    if (!category?.landing) throw { status_code: 400, body: '未登记上传落位规则\n' }
    const segments = category.landing(metadata)
    function assertOwnership(relPath: string) {
      try {
        splitRegistrationPath(relPath)
        if (registrationCategory(relPath) !== category) {
          throw new UploadRegistrationError('上传分类与实际落位不符')
        }
      } catch (error) {
        if (!(error instanceof UploadRegistrationError)) throw error
        throw { status_code: error.statusCode, body: `${error.message}\n` }
      }
    }
    assertOwnership(segments.join('/'))
    return { segments, assertOwnership }
  }

  function registerUploadedFile(db: FileStoreDb, root: string, body: unknown, context: LogContext) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new UploadRegistrationError('请求体必须是对象')
    }
    const { fileCategory, ...input } = body as Record<string, unknown>
    const requested = fileCategory === undefined ? undefined : categories.find(category => category.id === fileCategory)
    if (fileCategory !== undefined && !requested?.registration) {
      throw new UploadRegistrationError('未登记上传分类')
    }

    let relPath: string
    try {
      // Tus returns the actual disk path, including any surrounding whitespace.
      relPath = String(input.relPath ?? '')
    } catch (error) {
      throw new UploadRegistrationError((error as Error).message)
    }
    const owner = registrationCategory(relPath)
    if (requested && owner !== requested) {
      throw new UploadRegistrationError('上传分类与实际落位不符')
    }
    const registration = owner?.registration
    if (!registration) throw new UploadRegistrationError('无法确定登记上传分类')
    return runFileRegistration(db, root, relPath, () => registration.prepare({ ...input, relPath }), checkAdmission, context)
  }

  function divideMetadata(input: object) {
    const groups = new Map<NonNullable<FileCategoryServer['metadata']>, Record<string, unknown>>()
    for (const [key, value] of Object.entries(input)) {
      const owner = metadataByKey.get(key)
      if (!owner) throw new Error(`不可修改的字段:${key}`)
      const group = groups.get(owner) ?? {}
      group[key] = value
      groups.set(owner, group)
    }
    return groups
  }

  function parseMetadataPatch(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求体必须是对象')
    return Object.assign({}, ...Array.from(divideMetadata(input), ([owner, fields]) => owner.parse(fields)))
  }

  function updateStoredFile(db: FileStoreDb, id: number, patch: object): Row | null {
    const groups = divideMetadata(patch)
    try {
      return db.transaction(tx => {
        for (const [owner, fields] of groups) {
          if (!owner.write(tx, id, fields)) throw rollbackMetadata
        }
        return getStoredFile(tx, id)
      }, { behavior: 'immediate' })
    } catch (error) {
      if (error === rollbackMetadata) return null
      throw error
    }
  }

  return {
    parseMetadataPatch, updateStoredFile, resolveUploadPlacement, registerUploadedFile,
    checkAdmission, listStoredFiles, getStoredFile, extensionSnapshot,
    renameStoredFileDisplayName, verifyStoredFileRestoration, restoreVerifiedStoredFile,
    softRemoveStoredFile, backfillStoredFiles, backfillFromDisk,
  }
}
