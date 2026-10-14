import { useDb } from '@db'
import {
  backfillFromDisk,
  CATEGORY_STATES,
  listStoredFiles,
  PARSE_STATES,
  type BackfillStats,
} from '../../utils/stored-files'
import type { CategoryState, FileSource, ParseState } from '~~/lib/stored-file'
import { SOURCE_ORDER } from '~~/lib/labels'

/**
 * 文件库列表。`GET /api/files?source=&categoryState=&parseState=&q=&page=&pageSize=`
 *
 * **首次请求懒回填**:文件库是磁盘上的既有事实,而 `stored_file` 是新立的表 ——
 * 不扫一次,页面上就是空的。这里在第一次取列表时扫一遍 `files/` 并写表;
 * 之后每请求只查表(扫描要算 23 个文件的 SHA-256,不能每次请求都做)。
 *
 * `?rescan=1` 强制重新扫描(验收与排查用)。
 */
let backfilled = false

export default defineEventHandler(async (event) => {
  const db = useDb()
  const q = getQuery(event)

  const force = q.rescan === '1' || q.rescan === 'true'
  let backfill: BackfillStats | undefined
  if (!backfilled || force) {
    backfill = await backfillFromDisk(db, useRuntimeConfig().filesDir)
    backfilled = true
  }

  const csv = (v: unknown): string[] | undefined => {
    if (v == null) return undefined
    const raw = Array.isArray(v) ? v.flatMap((x) => String(x).split(',')) : String(v).split(',')
    const list = raw.map((s) => s.trim()).filter(Boolean)
    return list.length ? list : undefined
  }
  const num = (v: unknown, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }

  const result = listStoredFiles(db, {
    source: csv(q.source)?.filter((s) => SOURCE_ORDER.includes(s)) as FileSource[] | undefined,
    categoryState: csv(q.categoryState)?.filter((s) =>
      CATEGORY_STATES.includes(s as CategoryState),
    ) as CategoryState[] | undefined,
    parseState: csv(q.parseState)?.filter((s) =>
      PARSE_STATES.includes(s as ParseState),
    ) as ParseState[] | undefined,
    q: typeof q.q === 'string' && q.q ? q.q : undefined,
    page: num(q.page, 1),
    pageSize: num(q.pageSize, 50),
  })

  return {
    rows: result.rows,
    total: result.total,
    /** 回填统计只在真的跑过回填时出现,便于验收时核对「23 个」。 */
    ...(backfill ? { backfill } : {}),
  }
})
