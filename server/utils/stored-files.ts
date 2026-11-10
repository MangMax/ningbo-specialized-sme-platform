import { listRegisteredDeclarations681, registeredSummary681 } from './registered-declarations'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { and, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { compact } from 'es-toolkit'
import * as schema from '../../db/schema'
import {
  CATEGORY_STATE_ORDER,
  KIND_ORDER,
  PARSE_STATE_ORDER,
  SOURCE_ORDER,
  TITLE_ORDER,
} from '../../lib/labels'
import {
  baseName,
  categoryStateOf,
  deriveClassification,
  directoryOf,
  extensionOf,
  type CategoryState,
  type FileKind,
  type FileSource,
  type ParseState,
} from '../../lib/stored-file'
import { scopeOf, siblingIndex, type StoreScopeReason } from '../../lib/file-store-scope'
import type { StoredFilePart } from '../../lib/file-parts'
import { listFileParts, type PartsBackfillStats } from './file-parts'
import { compareFileContentIdentity, type FileContentConflict } from './file-content-identity'

type Db = BetterSQLite3Database<typeof schema>

/**
 * 白名单全部取自 `lib/labels.ts` 的展示顺序 —— 那里已经是这些枚举的**唯一来源**,
 * 在这里再写一份会漂移(改了一处忘另一处)。按钮上的中文也同源。
 */
export const KINDS: readonly FileKind[] = KIND_ORDER as FileKind[]
export const CATEGORY_STATES: readonly CategoryState[] = CATEGORY_STATE_ORDER as CategoryState[]
export const PARSE_STATES: readonly ParseState[] = PARSE_STATE_ORDER as ParseState[]

/** 列表一行的形状(含「被记录引用数」与**段**)。
 *
 * `year` / `batch` 是**公布**年份/批次(目录给出的、单值);文件**内容**含哪些年份/批次
 * 一律看 `parts`(票 17)。
 */
export interface StoredFileRow {
  id: number
  relPath: string
  /** 用户可见名称;没有覆写时等于磁盘 filename。 */
  displayName: string
  filename: string
  ext: string
  bytes: number
  sha256: string
  source: FileSource | null
  kind: FileKind | null
  /** **公布**年份(目录给的、单值)。内容年份见 `parts`。 */
  year: number | null
  /** **公布**批次(目录给的、单值)。内容批次见 `parts`。 */
  batch: number | null
  titleCode: string | null
  categoryState: CategoryState
  parseState: ParseState
  createdAt: string
  removedAt: string | null
  /** 有多少条 `record_evidence` 引用了这个文件(按 `source_file` 精确匹配 `rel_path`)。 */
  referenceCount: number
  /**
   * 文件里的**段**(票 17)。按 `compareParts` 排好序;没有段时是空数组
   * (尚无引用、留待票 11 解析时写入 —— **不是**「文件没有内容」)。
   */
  registeredSummary?: ReturnType<typeof registeredSummary681>
  parts: StoredFilePart[]
  partsBinding?: { historical: 'unknown'; inputLineage: { status: 'unknown' } | { status: 'bound'; inputRef: unknown } }
  contentIdentity?: { registered: { fileId: number; relPath: string; sha256: string; bytes: number }; status: 'unknown'; historical: 'unknown' }
}

/** 列表查询条件(与 `/api/files` 的 query 参数一一对应)。 */
export interface StoredFileQuery {
  /** 来源(多值命中任一)。 */
  source?: FileSource[]
  categoryState?: CategoryState[]
  parseState?: ParseState[]
  /** 用户可见名称或磁盘文件名关键词(子串,ASCII 大小写不敏感 —— SQLite `LIKE` 的语义)。 */
  q?: string
  /** 是否包含已移出库的文件。默认不含。 */
  includeRemoved?: boolean
  page?: number
  pageSize?: number
}

export const MAX_PAGE_SIZE = 200

// ---------------------------------------------------------------------------
// 扫描与哈希
// ---------------------------------------------------------------------------

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

/**
 * 递归扫描文件库根下的所有**数据文件**(跳过 `README.md` 与系统/临时文件)。
 *
 * 返回相对根的路径,`/` 分隔 —— 与 `record_evidence.source_file`、tus 的 `X-Upload-Path`
 * 同一口径。
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

// ---------------------------------------------------------------------------
// 回填(幂等)
// ---------------------------------------------------------------------------

export interface BackfillStats {
  /** 新插入的行数。 */
  inserted: number
  /** 内容一致、仅文件名等元数据刷新的行数。 */
  updated: number
  /** 已存在且一致、跳过的行数。 */
  unchanged: number
  /** 同路径字节与登记身份不符;保留原行,恢复原字节后可重扫。无冲突时省略。 */
  conflicts?: FileContentConflict[]
  /**
   * 被跳过的路径(认不出分类,如不在 `<source>/<kind>/` 规则下的文件)。
   * 这些文件仍**不入表** —— 不猜。
   */
  skipped: string[]
  /**
   * **认得出、但在入库范围之外**的文件(RL-16)。与 `skipped` 分开报:
   * 前者是「我不认识它」,后者是「我认识它,但按 `files/README.md` 的规则它不该入库」——
   * 两种不入表的理由完全不同,合成一个清单就没法验收了。
   *
   * 判据的唯一来源是 `lib/file-store-scope.ts`(纯函数,可单测)。
   */
  excluded: BackfillExclusion[]
}

/** 一条入库范围排除记录。 */
export interface BackfillExclusion {
  relPath: string
  /** 排除原因码(`lib/file-store-scope.ts` 的 `StoreScopeReason`,不会是 `in-scope`)。 */
  reason: Exclude<StoreScopeReason, 'in-scope'>
  /** 中文说明,直接可读。 */
  detail: string
}

/**
 * 两趟懒回填的**合并回报**(文件行 + 段)。接口与页面共用这一处 ——
 * 各写一份的话,加一个字段就会漂移。
 */
export interface BackfillReport extends BackfillStats {
  parts: PartsBackfillStats
}

/**
 * 扫描文件库,按目录规则反推分类,写入 `stored_file`。**幂等**:以 `rel_path` 为键,
 * 重跑不产生重复行,也不改动已有的**分类**(回填只补磁盘事实与首次分类)。
 *
 * 三条不回填的情形:
 *  1. 路径认不出分类(`<source>/<kind>/` 规则之外)→ 跳过并报出;
 *  2. **在入库范围之外**(入库培育 / 重复 `.doc` / 人工 OCR 的 `.docx`,判据见
 *     `lib/file-store-scope.ts`)→ **不进表**,并带原因报出(RL-16)。规则**在这里生效**,
 *     不是只写在文档里 —— 否则下次再把入库培育文件或重复 `.doc` 拷进来,它会照样混进列表;
 *  3. 该 `rel_path` 已被**人工移出库**(`removed_at` 非空)→ 跳过 —— 否则回填会把
 *     用户刚移出的文件又插回来,那就不是幂等了。
 *
 * 已有的行:内容身份不符时报冲突,内容一致才刷新 filename/ext,不覆盖分类 ——
 * 分类一旦被人改过(或由票 12 回写),回填不该把它冲回去。
 */
export function backfillStoredFiles(
  db: Db,
  scanned: ScannedFile[],
): BackfillStats {
  const stats: BackfillStats = { inserted: 0, updated: 0, unchanged: 0, skipped: [], excluded: [] }
  // 兄弟名集合来自**本次扫描**的结果:同目录的 `.doc` 与 `.docx` 都在里面,
  // 「同名兄弟」的两条判据才能成立(见 lib/file-store-scope.ts 的文件头)。
  const siblings = siblingIndex(scanned.map((f) => f.relPath))
  const existing = new Map(
    db
      .select()
      .from(schema.storedFile)
      .all()
      .map((row) => [row.relPath, row]),
  )

  for (const f of scanned) {
    const scope = scopeOf(f.relPath, siblings.get(directoryOf(f.relPath)))
    if (!scope.inScope) {
      stats.excluded.push({ relPath: f.relPath, reason: scope.reason, detail: scope.detail })
      continue
    }
    const derived = deriveClassification(f.relPath)
    if (!derived) {
      stats.skipped.push(f.relPath)
      continue
    }
    const row = existing.get(f.relPath)
    if (!row) {
      db.insert(schema.storedFile)
        .values({
          relPath: f.relPath,
          filename: f.filename,
          ext: f.ext,
          bytes: f.bytes,
          sha256: f.sha256,
          source: derived.source,
          kind: derived.kind,
          year: derived.year,
          batch: derived.batch,
          categoryState: derived.categoryState,
        })
        .run()
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
export async function backfillFromDisk(db: Db, root: string): Promise<BackfillStats> {
  return backfillStoredFiles(db, await scanFileStore(root))
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

/** 「被记录引用数」相关子查询:数 `record_evidence` 里 `source_file` 恰好等于本行 `rel_path` 的条数。 */
function referenceCountExpr(): SQL<number> {
  return sql<number>`(
    select count(*) from ${schema.recordEvidence}
    where ${schema.recordEvidence.sourceFile} = ${schema.storedFile.relPath}
  )`
}

/**
 * 列表与单行的**列投影**。抽成一处 —— 两处各写一份的话,加一列要改两个地方,
 * 迟早漏一个(单行接口就会少返回一个字段)。
 */
const fileColumns = {
  id: schema.storedFile.id,
  relPath: schema.storedFile.relPath,
  displayName: sql<string>`coalesce(${schema.storedFile.displayName}, ${schema.storedFile.filename})`,
  filename: schema.storedFile.filename,
  ext: schema.storedFile.ext,
  bytes: schema.storedFile.bytes,
  sha256: schema.storedFile.sha256,
  source: schema.storedFile.source,
  kind: schema.storedFile.kind,
  year: schema.storedFile.year,
  batch: schema.storedFile.batch,
  titleCode: schema.storedFile.titleCode,
  categoryState: schema.storedFile.categoryState,
  parseState: schema.storedFile.parseState,
  createdAt: schema.storedFile.createdAt,
  removedAt: schema.storedFile.removedAt,
  referenceCount: referenceCountExpr(),
}

export function buildFileWhere(params: StoredFileQuery): SQL | undefined {
  const conds: (SQL | undefined)[] = []
  if (!params.includeRemoved) conds.push(isNull(schema.storedFile.removedAt))
  if (params.source?.length) conds.push(inArray(schema.storedFile.source, params.source))
  if (params.categoryState?.length) {
    conds.push(inArray(schema.storedFile.categoryState, params.categoryState))
  }
  if (params.parseState?.length) {
    conds.push(inArray(schema.storedFile.parseState, params.parseState))
  }
  if (params.q) {
    conds.push(
      or(
        like(schema.storedFile.displayName, `%${params.q}%`),
        like(schema.storedFile.filename, `%${params.q}%`),
      ),
    )
  }
  const filtered = compact(conds)
  return filtered.length ? and(...filtered) : undefined
}

/** 给已取出的行补上**段**(票 17)。一次查询取回本页所有文件的段,按 `file_id` 分到各行。 */
function withParts(db: Db, rows: StoredFileRow[]): StoredFileRow[] {
  if (!rows.length) return rows
  const byFile = listFileParts(
    db,
    rows.map((r) => r.id),
  )
  const declarations = listRegisteredDeclarations681(db, rows.map(row => row.id))
  const audits = db.select({ fileId: schema.fileParseAudit105.fileId, inputLineage: sql<string | null>`json_extract(${schema.fileParseAudit105.after}, '$.inputLineage')` }).from(schema.fileParseAudit105)
    .where(and(inArray(schema.fileParseAudit105.fileId, rows.map(row => row.id)), sql`${schema.fileParseAudit105.id} = (select max(a.id) from file_parse_audit_105 a where a.file_id = ${schema.fileParseAudit105.fileId})`)).all()
  const lineage = new Map<number, NonNullable<StoredFileRow['partsBinding']>['inputLineage']>()
  for (const audit of audits) {
    if (!lineage.has(audit.fileId)) {
      const input = (audit.inputLineage ? JSON.parse(audit.inputLineage) : undefined) as NonNullable<StoredFileRow['partsBinding']>['inputLineage'] | undefined
      lineage.set(audit.fileId, input?.status === 'bound' ? input : { status: 'unknown' })
    }
  }
  return rows.map((row) => ({ ...row, registeredSummary: registeredSummary681(declarations.get(row.id) ?? []), parts: byFile.get(row.id) ?? [],
    contentIdentity: { registered: { fileId: row.id, relPath: row.relPath, sha256: row.sha256, bytes: row.bytes }, status: 'unknown', historical: 'unknown' },
    partsBinding: { historical: 'unknown', inputLineage: lineage.get(row.id) ?? { status: 'unknown' } },
  }))
}

/**
 * 分页列出文件库。
 *
 * 排序:**来源**(经信局 → 工信部)→ **公布年份**倒序(无年份的排在后)→ **公布批次**倒序
 * → **文件名**。同一年里新的批次在上;`null` 一律排在最后(SQLite 的 `IS NULL` 前置排序),
 * 免得「未分类」的文件插在年份中间。
 *
 * > 排序用**公布**年份/批次(`stored_file.year` / `batch`),不是文件内容的年份 ——
 * > 列表是「文件按批次的陈列」,内容的多年份在「年份」列上并排显示(票 17)。
 */
export function listStoredFiles(
  db: Db,
  params: StoredFileQuery = {},
): { rows: StoredFileRow[]; total: number } {
  const where = buildFileWhere(params)
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 50))

  const total =
    db.select({ n: sql<number>`count(*)` }).from(schema.storedFile).where(where).get()?.n ?? 0

  const sourceRank = sql`case ${schema.storedFile.source} ${sql.join(
    SOURCE_ORDER.map((code, i) => sql`when ${code} then ${i}`),
    sql` `,
  )} else ${SOURCE_ORDER.length} end`

  const rows = db
    .select(fileColumns)
    .from(schema.storedFile)
    .where(where)
    .orderBy(
      sourceRank,
      sql`${schema.storedFile.year} is null`,
      desc(schema.storedFile.year),
      sql`${schema.storedFile.batch} is null`,
      desc(schema.storedFile.batch),
      schema.storedFile.filename,
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  return { rows: withParts(db, rows as StoredFileRow[]), total }
}

// ---------------------------------------------------------------------------
// PATCH:只改元数据
// ---------------------------------------------------------------------------

/**
 * 可改的元数据字段 —— **票 09 只允许这五项**:`source / kind / year / batch / titleCode`。
 * `rel_path` 明确不在其中(它由磁盘决定,不由人改);`category_state` / `parse_state` 也不在,
 * 因为那是**状态**,由分类是否补齐(本文件自动维持)与解析管线(票 11/14)决定,不该手改。
 */
export interface FileMetadataPatch {
  source?: FileSource | null
  kind?: FileKind | null
  year?: number | null
  batch?: number | null
  titleCode?: string | null
}

/** 一个可空字段的「未提供 / 设为 null / 设为值」三态。 */
interface Tri<T> {
  provided: boolean
  value: T | null
}

function tri<T>(raw: unknown): Tri<T> {
  if (raw === undefined) return { provided: false, value: null }
  if (raw === null || raw === '') return { provided: true, value: null }
  return { provided: true, value: raw as T }
}

/**
 * 解析并校验 PATCH body。**只接受元数据字段** —— 出现 `relPath` / `bytes` / `sha256`
 * 之类磁盘事实的键一律 400,免得「改元数据」悄悄变成改路径或改库外的东西。
 */
export function parseMetadataPatch(body: unknown): FileMetadataPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('请求体必须是对象')
  }
  const b = body as Record<string, unknown>

  const ALLOWED = new Set(['source', 'kind', 'year', 'batch', 'titleCode'])
  for (const key of Object.keys(b)) {
    if (!ALLOWED.has(key)) throw new Error(`不可修改的字段:${key}`)
  }

  const patch: FileMetadataPatch = {}

  const source = tri<FileSource>(b.source)
  if (source.provided) {
    if (source.value !== null && !SOURCE_ORDER.includes(source.value)) {
      throw new Error(`来源不在白名单:${source.value}`)
    }
    patch.source = source.value
  }

  const kind = tri<FileKind>(b.kind)
  if (kind.provided) {
    if (kind.value !== null && !KINDS.includes(kind.value)) {
      throw new Error(`类别不在白名单:${kind.value}`)
    }
    patch.kind = kind.value
  }

  const year = tri<number>(b.year)
  if (year.provided) {
    if (year.value !== null) {
      if (typeof year.value !== 'string' && typeof year.value !== 'number') throw new Error('年份必须是四位数字')
      const n = Number(year.value)
      if (!Number.isInteger(n) || n < 1900 || n > 2100) throw new Error('年份必须是四位数字')
      patch.year = n
    } else patch.year = null
  }

  const batch = tri<number>(b.batch)
  if (batch.provided) {
    if (batch.value !== null) {
      if (typeof batch.value !== 'string' && typeof batch.value !== 'number') throw new Error('批次必须是正整数')
      const n = Number(batch.value)
      if (!Number.isInteger(n) || n <= 0) throw new Error('批次必须是正整数')
      patch.batch = n
    } else patch.batch = null
  }

  const title = tri<string>(b.titleCode)
  if (title.provided) {
    if (title.value !== null && !TITLE_ORDER.includes(title.value)) {
      throw new Error(`称号不在白名单:${title.value}`)
    }
    patch.titleCode = title.value
  }

  return patch
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

/** 只更新用户可见名称并追加历史;`filename` / `relPath` 与磁盘内容保持不变。 */
export function renameStoredFileDisplayName(
  db: Db,
  id: number,
  displayName: string,
): StoredFileRow | null {
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

/**
 * 改一行的**元数据**。返回改后的行;不存在返回 null。
 *
 * **只写元数据列**:`rel_path` / `filename` / `ext` / `bytes` / `sha256` 一律不动
 * (那是磁盘事实),也**不碰磁盘上的任何文件**。这是票 09 的硬要求。
 *
 * 改完 `source` / `kind` / `year` / `batch` 之后,若分类由缺到全,自动把
 * `categoryState` 从 `unset` 提升为 `set` —— 用户刚把分类补齐了,不该还挂着「待分类」。
 */
export function updateStoredFile(
  db: Db,
  id: number,
  patch: FileMetadataPatch,
): StoredFileRow | null {
  const current = db.select().from(schema.storedFile).where(eq(schema.storedFile.id, id)).get()
  if (!current) return null

  const next = {
    source: patch.source !== undefined ? patch.source : current.source,
    kind: patch.kind !== undefined ? patch.kind : current.kind,
    year: patch.year !== undefined ? patch.year : current.year,
    batch: patch.batch !== undefined ? patch.batch : current.batch,
  }

  const set: Record<string, unknown> = {}
  if (patch.source !== undefined) set.source = patch.source
  if (patch.kind !== undefined) set.kind = patch.kind
  if (patch.year !== undefined) set.year = patch.year
  if (patch.batch !== undefined) set.batch = patch.batch
  if (patch.titleCode !== undefined) set.titleCode = patch.titleCode

  // 分类状态由分类是否补齐**自动维持**(人只改分类,不该手工去填一个状态):
  // 分类补齐 → 提升为 `set`;分类被清空 → 退回 `unset`。改分类时才算,只改称号/批次不算。
  if (patch.source !== undefined || patch.kind !== undefined || patch.year !== undefined) {
    if (next.source && next.kind) {
      const derived = categoryStateOf({
        source: next.source,
        kind: next.kind,
        year: next.year,
        batch: next.batch,
      })
      if (derived === 'set' && current.categoryState === 'unset') set.categoryState = 'set'
      if (derived === 'unset') set.categoryState = 'unset'
    } else {
      set.categoryState = 'unset'
    }
  }

  if (Object.keys(set).length) {
    db.update(schema.storedFile).set(set).where(eq(schema.storedFile.id, id)).run()
  }

  return getStoredFile(db, id)
}

/** 取一行(含引用数与段);不存在返回 null。 */
export function getStoredFile(db: Db, id: number): StoredFileRow | null {
  const row = db
    .select(fileColumns)
    .from(schema.storedFile)
    .where(eq(schema.storedFile.id, id))
    .get()
  if (!row) return null
  return withParts(db, [row as StoredFileRow])[0]!
}

// ---------------------------------------------------------------------------
// DELETE:移出库(默认不删磁盘)
// ---------------------------------------------------------------------------

export interface RemoveResult {
  row: StoredFileRow
  /** 磁盘文件是否被真的删掉了。默认 false。 */
  diskDeleted: boolean
  /** 被引用数 > 0 时的提示(删了会让台账的出处指向不存在的文件)。 */
  referenceCount: number
}

/**
 * 把一个文件**移出库与索引**。默认**不删磁盘**:只打 `removed_at` 标(软删除)。
 * `deleteDisk: true` 时才真的 unlink —— 调用方(路由)必须先做二次确认。
 *
 * 被记录引用时允许软移出并回报引用数；磁盘删除在同一个写锁内拒绝仍被引用的文件。
 */
export async function removeStoredFile(
  db: Db,
  filesRoot: string,
  id: number,
  options: { deleteDisk?: boolean } = {},
): Promise<RemoveResult | null> {
  return removeStoredFileSync(db, filesRoot, id, options)
}

/** Short filesystem metadata operation under the SQLite write lock protects references. */
export function removeStoredFileSync(
  db: Db,
  filesRoot: string,
  id: number,
  options: { deleteDisk?: boolean } = {},
): RemoveResult | null {
  return db.transaction((tx) => {
    const current = tx.select().from(schema.storedFile).where(eq(schema.storedFile.id, id)).get()
    if (!current) return null

    const refs = getStoredFile(tx, id)?.referenceCount ?? 0

    const diskDeleted = false
    if (options.deleteDisk) throw new FileMaintenanceError(400, '物理删除必须通过带版本封套的隔离命令执行')

    softRemoveStoredFile(tx, id)

    return { row: getStoredFile(tx, id)!, diskDeleted, referenceCount: refs }
  }, { behavior: 'immediate' })
}

export class FileMaintenanceError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}

/** Restore only the original registered bytes. Never reimport events or refresh disk facts. */
export async function verifyStoredFileRestoration(db: Db, root: string, id: number): Promise<StoredFileRow> {
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

export function restoreVerifiedStoredFile(db: Db, current: StoredFileRow): StoredFileRow {
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
export function softRemoveStoredFile(db: Db, id: number): StoredFileRow | null {
  const current = getStoredFile(db, id)
  if (!current || current.removedAt) return current
  db.update(schema.storedFile).set({ removedAt: new Date().toISOString() }).where(eq(schema.storedFile.id, id)).run()
  return getStoredFile(db, id)
}
