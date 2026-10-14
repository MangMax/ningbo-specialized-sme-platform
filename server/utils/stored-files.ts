import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { and, desc, eq, inArray, isNull, like, sql, type SQL } from 'drizzle-orm'
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
  extensionOf,
  type CategoryState,
  type FileKind,
  type FileSource,
  type ParseState,
} from '../../lib/stored-file'
import type { FilePart } from '../../lib/file-parts'
import { listFileParts } from './file-parts'

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
  parts: FilePart[]
}

/** 列表查询条件(与 `/api/files` 的 query 参数一一对应)。 */
export interface StoredFileQuery {
  /** 来源(多值命中任一)。 */
  source?: FileSource[]
  categoryState?: CategoryState[]
  parseState?: ParseState[]
  /** 文件名关键词(子串,ASCII 大小写不敏感 —— SQLite `LIKE` 的语义)。 */
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
function sha256Of(absPath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
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
  /** 已存在但磁盘事实变化的行数(尺寸/哈希等被刷新)。 */
  updated: number
  /** 已存在且一致、跳过的行数。 */
  unchanged: number
  /**
   * 被跳过的路径(认不出分类,如不在 `<source>/<kind>/` 规则下的文件)。
   * 这些文件仍**不入表** —— 不猜。
   */
  skipped: string[]
}

/**
 * 扫描文件库,按目录规则反推分类,写入 `stored_file`。**幂等**:以 `rel_path` 为键,
 * 重跑不产生重复行,也不改动已有的**分类**(回填只补磁盘事实与首次分类)。
 *
 * 两条不回填的情形:
 *  1. 路径认不出分类(`<source>/<kind>/` 规则之外)→ 跳过并报出;
 *  2. 该 `rel_path` 已被**人工移出库**(`removed_at` 非空)→ 跳过 —— 否则回填会把
 *     用户刚移出的文件又插回来,那就不是幂等了。
 *
 * 已有的行:**只刷新磁盘事实**(filename/ext/bytes/sha256),不覆盖分类 ——
 * 分类一旦被人改过(或由票 12 回写),回填不该把它冲回去。
 */
export function backfillStoredFiles(
  db: Db,
  scanned: ScannedFile[],
): BackfillStats {
  const stats: BackfillStats = { inserted: 0, updated: 0, unchanged: 0, skipped: [] }
  const existing = new Map(
    db
      .select()
      .from(schema.storedFile)
      .all()
      .map((row) => [row.relPath, row]),
  )

  for (const f of scanned) {
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
    if (row.filename === f.filename && row.bytes === f.bytes && row.sha256 === f.sha256) {
      stats.unchanged += 1
      continue
    }
    db.update(schema.storedFile)
      .set({ filename: f.filename, ext: f.ext, bytes: f.bytes, sha256: f.sha256 })
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
    conds.push(like(schema.storedFile.filename, `%${params.q}%`))
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
  return rows.map((row) => ({ ...row, parts: byFile.get(row.id) ?? [] }))
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
      const n = Number(year.value)
      if (!Number.isInteger(n) || n < 1900 || n > 2100) throw new Error('年份必须是四位数字')
      patch.year = n
    } else patch.year = null
  }

  const batch = tri<number>(b.batch)
  if (batch.provided) {
    if (batch.value !== null) {
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
 * 被记录引用时也允许移出(用户可能确实要清理),但把引用数回报出去,让界面能提示。
 */
export async function removeStoredFile(
  db: Db,
  filesRoot: string,
  id: number,
  options: { deleteDisk?: boolean } = {},
): Promise<RemoveResult | null> {
  const current = db.select().from(schema.storedFile).where(eq(schema.storedFile.id, id)).get()
  if (!current) return null

  const refs = getStoredFile(db, id)?.referenceCount ?? 0

  let diskDeleted = false
  if (options.deleteDisk) {
    const abs = resolve(join(resolve(filesRoot), current.relPath))
    const root = resolve(filesRoot)
    // 锁根:路径解析后必须仍在文件库内,不能删到库外。
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error('路径越界')
    }
    try {
      const info = await lstat(abs)
      if (info.isFile()) {
        await rm(abs, { force: true })
        diskDeleted = true
      }
    } catch {
      // 磁盘上已经不在了 —— 移出库照样完成,不因为文件缺失而失败。
    }
  }

  db.update(schema.storedFile)
    .set({ removedAt: new Date().toISOString() })
    .where(eq(schema.storedFile.id, id))
    .run()

  return { row: getStoredFile(db, id)!, diskDeleted, referenceCount: refs }
}
