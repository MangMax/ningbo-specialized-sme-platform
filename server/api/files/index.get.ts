import { useDb } from '@db'
import {
  backfillFromDisk,
  CATEGORY_STATES,
  listStoredFiles,
  PARSE_STATES,
  type BackfillStats,
} from '../../utils/stored-files'
import { backfillFileParts, type PartsBackfillStats } from '../../utils/file-parts'
import type { CategoryState, FileSource, ParseState } from '~~/lib/stored-file'
import { SOURCE_ORDER } from '~~/lib/labels'

/** 两趟回填的合并回报(文件行 + 段),便于验收时一次核对。 */
interface BackfillReport extends BackfillStats {
  parts: PartsBackfillStats
}

/**
 * 文件库列表。`GET /api/files?source=&categoryState=&parseState=&q=&page=&pageSize=`
 *
 * **首次请求懒回填**,两趟:
 *  1. 扫 `files/` 反推分类写 `stored_file`(票 09)—— 要算 23 个文件的 SHA-256;
 *  2. 从 `record_evidence` 聚合出**段**写 `stored_file_part`(票 17,必须先有第 1 趟,
 *     段要挂到 `stored_file.id` 上)。
 * 之后每请求只查表。`?rescan=1` 强制两趟都重跑(验收与排查用;**幂等**)。
 */
let backfilled = false

export default defineEventHandler(async (event) => {
  const db = useDb()
  const q = getQuery(event)

  const force = q.rescan === '1' || q.rescan === 'true'
  let backfill: BackfillReport | undefined
  if (!backfilled || force) {
    const files = await backfillFromDisk(db, useRuntimeConfig().filesDir)
    backfill = { ...files, parts: backfillFileParts(db) }
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
