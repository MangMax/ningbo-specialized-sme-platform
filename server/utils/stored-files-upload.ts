import { stat } from 'node:fs/promises'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import * as schema from '../../db/schema'
import {
  categoryStateOf,
  extensionOf,
  type FileKind,
  type FileSource,
} from '../../lib/stored-file'
import { getStoredFile, resolveInsideRoot, sha256Of, type StoredFileRow } from './stored-files'
import { landingSegments } from './tus'

/**
 * 上传完成后的**登记**(票 10):把 tus 已经落位的文件写进 `stored_file`(票 09 的表)。
 *
 * 为什么不在 `server/utils/tus.ts` 的 `onUploadFinish` 里直接写库:
 *  - 那里只该管**落位**(纯规则 + 磁盘动作),写入库是另一个关注点,混在一起后
 *    「落位规则」就没法单独测了(现在 `landingSegments` 是纯函数,值得保住);
 *  - tus 的完成响应在写库失败时无法回滚(文件已经落到磁盘了),不如让客户端拿到
 *    `X-Upload-Path` 后再显式登记一次 —— 失败可见、可重试,且登记是**幂等**的。
 *
 * 客户端**只传落位路径与用户填的声明**,磁盘事实(大小 / SHA-256)一律由服务端从盘上读:
 * 客户端说的不算数。声明本身借 `tus.ts` 的 `landingSegments` 裁决(白名单与格式的**唯一来源**),
 * 非法一律 400 且**不落库**。
 */

/** 登记被拒时抛的错。`statusCode` 由路由翻成 HTTP 码(默认 400)。 */
export class UploadRegistrationError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'UploadRegistrationError'
    this.statusCode = statusCode
  }
}

/** 客户端提交的登记声明:落位路径 + 用户填的分类(可空)。 */
export interface UploadDeclaration {
  /** 库内相对路径,来自 tus 响应头 `X-Upload-Path`(客户端解码后原样回传)。 */
  relPath: string
  source?: string | null
  kind?: string | null
  year?: string | null
  batch?: string | null
}

/** 一个可空文本字段:缺省 / 空串一律当「没填」。 */
function text(raw: unknown): string | null {
  if (raw == null) return null
  const value = String(raw).trim()
  return value === '' ? null : value
}

/**
 * 解析登记请求体。只接受上面那五个键 —— 出现 `bytes` / `sha256` / `filename` 之类的
 * 磁盘事实键一律 400:那些必须由服务端从盘上读,不接受客户端自称。
 */
export function parseUploadDeclaration(body: unknown): UploadDeclaration {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new UploadRegistrationError('请求体必须是对象')
  }
  const b = body as Record<string, unknown>
  const ALLOWED = new Set(['relPath', 'source', 'kind', 'year', 'batch'])
  for (const key of Object.keys(b)) {
    if (!ALLOWED.has(key)) throw new UploadRegistrationError(`不可提交的字段:${key}`)
  }
  const relPath = text(b.relPath)
  if (!relPath) throw new UploadRegistrationError('缺少 relPath')
  return {
    relPath,
    source: text(b.source),
    kind: text(b.kind),
    year: text(b.year),
    batch: text(b.batch),
  }
}

/**
 * 相对路径 → 段序列。逐段拒掉空段、`.`、`..`、反斜杠与 NUL —— 单靠后面的
 * 「resolve 后仍在根内」也能挡住穿越,但在这里就挡掉,错误信息才对得上问题。
 */
function splitRelPath(relPath: string): string[] {
  const segments = relPath.split('/')
  const bad = segments.some(
    (s) => !s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'),
  )
  if (bad) throw new UploadRegistrationError(`落位路径非法:${relPath}`)
  return segments
}

/**
 * 把一次已完成的上传登记进 `stored_file`。**幂等**:以 `rel_path` 为键,
 * 重复登记只刷新磁盘事实与分类,不产生第二行。
 *
 * 校验链(任何一步不过都**不落库**):
 *  1. `source` / `kind` **要么都给、要么都不给** —— 只给一个是不表达语义的状态;
 *  2. 给了分类就过 `tus.ts` 的 `landingSegments` 裁决 —— 来源/类别必须在白名单,
 *     年份四位,批次正整数;且**声明算出的目录段必须与实际落位路径逐段相同**
 *     (路径是服务端算的、声明是客户端发的,不一致说明有人改了声明);
 *  3. 路径解析后必须仍在文件库根内,且磁盘上真的有这个文件(磁盘事实一律从盘上读)。
 *
 * 都不给分类时不硬填:写 `null` + `category_state='unset'`,交票 12 回写
 * (与 `lib/stored-file.ts` 的 `categoryStateOf` 同一条规则 —— 公布文件没年份就是未定)。
 */
export async function registerStoredFile(
  db: BetterSQLite3Database<typeof schema>,
  filesRoot: string,
  input: UploadDeclaration,
): Promise<{ row: StoredFileRow; created: boolean }> {
  const segments = splitRelPath(input.relPath)
  const filename = segments[segments.length - 1]!
  const actualDirs = segments.slice(0, -1)

  const hasSource = input.source !== null
  const hasKind = input.kind !== null
  if (hasSource !== hasKind) {
    throw new UploadRegistrationError('来源与类别要么都给,要么都不给')
  }
  // 年份/批次是分类的一部分,没有来源类别就无从谈起。
  if (!hasSource && (input.year !== null || input.batch !== null)) {
    throw new UploadRegistrationError('未定来源与类别时不能单独给年份或批次')
  }

  if (hasSource) {
    // 1. 白名单与格式:借 tus 的裁决函数,不在这里另写一份规则。
    let declaredDirs: string[]
    try {
      declaredDirs = landingSegments({
        source: input.source,
        kind: input.kind,
        year: input.year,
        batch: input.batch,
        filename,
      }).slice(0, -1)
    } catch (error) {
      const body = (error as { body?: string }).body
      throw new UploadRegistrationError(body ? body.trim() : '落位声明非法')
    }
    // 批次是**正整数**:`landingSegments` 的 `isBatch` 只要求是数字,0 也放行(那是落位规则
    // 的事,不改它);登记要写进库,按票 09 `PATCH` 的口径收紧一道。
    if (input.batch !== null && Number(input.batch) <= 0) {
      throw new UploadRegistrationError(`批次必须是正整数:${input.batch}`)
    }
    if (
      declaredDirs.length !== actualDirs.length ||
      declaredDirs.some((s, i) => s !== actualDirs[i])
    ) {
      throw new UploadRegistrationError(
        `声明与实际落位不符:声明 ${declaredDirs.join('/')},实际 ${actualDirs.join('/')}`,
      )
    }
  }

  // 2. 锁根 + 存在性(与预览路由、删除共用 `resolveInsideRoot` 一处判据)。
  const abs = resolveInsideRoot(filesRoot, segments.join('/'))
  if (!abs) {
    throw new UploadRegistrationError(`落位路径越界:${input.relPath}`)
  }
  let info
  try {
    info = await stat(abs)
  } catch {
    throw new UploadRegistrationError(`落位文件不存在:${input.relPath}`)
  }
  if (!info.isFile()) throw new UploadRegistrationError(`落位路径不是一个文件:${input.relPath}`)

  const facts = {
    relPath: segments.join('/'),
    filename,
    ext: extensionOf(filename),
    bytes: info.size,
    sha256: await sha256Of(abs),
  }

  const source = hasSource ? (input.source as FileSource) : null
  const kind = hasKind ? (input.kind as FileKind) : null
  const year = input.year !== null ? Number(input.year) : null
  const batch = input.batch !== null ? Number(input.batch) : null
  // 分类状态由「分类是否补齐」推出 —— 与票 09 同一套规则,不在这里另定一套。
  const categoryState =
    source && kind ? categoryStateOf({ source, kind, year, batch }) : 'unset'

  const existing = db
    .select()
    .from(schema.storedFile)
    .where(eq(schema.storedFile.relPath, facts.relPath))
    .get()

  if (existing) {
    // 已有的行(同一路径重新登记,或回填先插过):刷新磁盘事实与分类。
    // `parse_state` 不重置 —— 已解析的文件不该因为重传一次变回未解析。
    // `removed_at` 清空:用户主动把这份文件重新传了进来,就该在列表里。
    db.update(schema.storedFile)
      .set({ ...facts, source, kind, year, batch, categoryState, removedAt: null })
      .where(eq(schema.storedFile.id, existing.id))
      .run()
    return { row: getStoredFile(db, existing.id)!, created: false }
  }

  const inserted = db
    .insert(schema.storedFile)
    .values({ ...facts, source, kind, year, batch, categoryState })
    .returning({ id: schema.storedFile.id })
    .get()

  return { row: getStoredFile(db, inserted.id)!, created: true }
}
