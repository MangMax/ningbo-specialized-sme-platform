import { appLog, type LogContext } from '../../lib/logging'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { MAX_PAGE_NO } from '../../lib/ocr-markdown'
import {
  compareOcrPageVersion, DEFAULT_OCR_ENGINE, formatOcrMarkdown, ocrHistoricalBinding, ocrVersionExpectations,
  pageRelPathOf, validOcrExpectedVersion, validateOcrPages, type OcrResultRow, type OcrWriteInput, type OcrWriteResult,
} from './ocr-result-contract'
import { reviseOcrProvenance } from './ocr-provenance'
export * from './ocr-result-contract'

type Db = BetterSQLite3Database<typeof schema>

/**
 * 写入(或覆盖)一个文件若干页的 OCR 结果。
 *
 * **幂等点在库上,不在应用层**:`(file_id, page_no)` 有唯一索引,这里用
 * `onConflictDoUpdate` 覆盖 —— 「同页不重复写」由 SQLite 保证。先查后写的写法
 * 在并发下会两个写者都查不到、都插(唯一索引照样炸),或者覆盖顺序反了,
 * 所以不做那一套。
 *
 * 没列出的页**不动**:某页识别坏了就只重跑那一页(通路 a 的逐页重试正是靠这个)。
 *
 * ── `raw` 的保留语义(与其他列不同)────────────────────────────────────
 * raw JSON 内区分不可变采集与文本修订,保留旧载荷和修订历史。
 * 旧 raw 的归属未知,不从可变行上的 channel/engine/model 倒填。
 */
export function writeOcrResult(db: Db, input: OcrWriteInput): OcrWriteResult {
  if (!validOcrExpectedVersion(input.expectedVersion)) return { ok: false, statusCode: 400, message: 'expectedVersion 非法' }
  const checked = validateOcrPages(input.pages)
  if (!checked.ok) return checked
  const expectations = ocrVersionExpectations(input)
  if (!expectations.ok) return expectations

  const engine = input.engine?.trim() || DEFAULT_OCR_ENGINE
  const model = input.model ?? null
  const createdAt = new Date().toISOString()

  return db.transaction((tx) => {
    for (const [page, expected] of expectations.pages) {
      const conflict = checkOcrPageVersion(tx, input.fileId, page, expected)
      if (conflict) return conflict
    }
    // Keep IDs and history of rewritten pages even for legacy replace callers.
    const previous = tx.select().from(schema.ocrResult).where(and(eq(schema.ocrResult.fileId, input.fileId), inArray(schema.ocrResult.pageNo, checked.pages))).all()
    if (input.replaceExistingPages) for (const row of tx.select({ id: schema.ocrResult.id, pageNo: schema.ocrResult.pageNo }).from(schema.ocrResult).where(eq(schema.ocrResult.fileId, input.fileId)).all()) {
      if (!checked.pages.includes(row.pageNo)) tx.delete(schema.ocrResult).where(eq(schema.ocrResult.id, row.id)).run()
    }
    for (const p of input.pages) {
      const values = {
        fileId: input.fileId,
        pageNo: p.page,
        pageRelPath: p.pageRelPath ?? pageRelPathOf(input.sourceRelPath, p.page),
        markdown: p.markdown,
        raw: reviseOcrProvenance(previous.find(row => row.pageNo === p.page), { ...p, channel: input.channel, engine, model, createdAt }),
        engine,
        model,
        channel: input.channel,
        createdAt,
      }
      tx.insert(schema.ocrResult)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.ocrResult.fileId, schema.ocrResult.pageNo],
          set: {
            revision: sql`${schema.ocrResult.revision} + 1`,
            pageRelPath: values.pageRelPath,
            markdown: values.markdown,
            raw: values.raw,
            engine: values.engine,
            model: values.model,
            channel: values.channel,
            createdAt: values.createdAt,
          },
        })
        .run()
    }
    return { ok: true as const, written: input.pages.length, pages: checked.pages }
  }, { behavior: 'immediate' })
}

export function listOcrResults(db: Db, fileId: number, pageNo?: number | null): (OcrResultRow & { version: string })[] {
  const where =
    pageNo === undefined || pageNo === null
      ? eq(schema.ocrResult.fileId, fileId)
      : and(eq(schema.ocrResult.fileId, fileId), eq(schema.ocrResult.pageNo, pageNo))
  return db
    .select({
      provenance: sql<string | null>`case when json_valid(${schema.ocrResult.raw}) and json_extract(${schema.ocrResult.raw}, '$.format') = 'ocr-provenance-v1' then json_object(
        'revision', json_extract(${schema.ocrResult.raw}, '$.revisions[#-1]'),
        'capture', json_object(
          'markdown', json_extract(${schema.ocrResult.raw}, '$.captures[' || json_extract(${schema.ocrResult.raw}, '$.revisions[#-1].capture') || '].markdown'),
          'input', json_extract(${schema.ocrResult.raw}, '$.captures[' || json_extract(${schema.ocrResult.raw}, '$.revisions[#-1].capture') || '].input'))
      ) else null end`,
      version: sql<string>`${schema.ocrResult.id} || ':' || ${schema.ocrResult.revision}`,
      page: schema.ocrResult.pageNo,
      markdown: schema.ocrResult.markdown,
      pageRelPath: schema.ocrResult.pageRelPath,
      engine: schema.ocrResult.engine,
      model: schema.ocrResult.model,
      channel: schema.ocrResult.channel,
      createdAt: schema.ocrResult.createdAt,
    })
    .from(schema.ocrResult)
    .where(where)
    .orderBy(asc(schema.ocrResult.pageNo))
    .all().map(({ provenance, ...row }) => ({ ...row, historicalBinding: ocrHistoricalBinding(provenance ? JSON.parse(provenance) : null, row.markdown) }))
}

/** 某文件 OCR 结果覆盖了哪些页(升序)。页数一致性的核对点。 */
export function ocrPageNumbers(db: Db, fileId: number): number[] {
  return db
    .select({ page: schema.ocrResult.pageNo })
    .from(schema.ocrResult)
    .where(eq(schema.ocrResult.fileId, fileId))
    .orderBy(asc(schema.ocrResult.pageNo))
    .all()
    .map((r) => r.page)
}

/**
 * 删掉某文件的全部 OCR 结果。
 *
 * 用途很具体:任务里「识别出的页数 ≠ 源 PDF 页数」时**回滚**刚写进去的那批 ——
 * 那时行里的 `page_no` 是错的,留着比没有更坏(它看起来像真的)。
 * 不对外开接口:「删结果」不是调用方要的能力,是编排面在**发现自己写错**时的自清。
 */
export function removeOcrResults(db: Db, fileId: number): number {
  return db.delete(schema.ocrResult).where(eq(schema.ocrResult.fileId, fileId)).run().changes
}

/**
 * 删掉**某一页**的 OCR 结果,返回删掉的行数(0 或 1)。
 *
 * 与上面那个「整份清空」是**两件事**,分开是为了让调用方**只能删一页**:
 * 整份清空是编排面在发现自己写错页码时的自清(内部用,不对外),而人是逐页校对的
 * —— 他只该能删掉自己正在看的那一页。给这条路径一个 fileId 就清空的能力,
 * 一次误点就是一份 12 页的识别结果没了(而重做要花 API 额度)。
 *
 * **幂等**:那一页本来就没有结果时删 0 行,不报错 —— 「删一个已经不在的东西」不该失败。
 */
export function removeOcrPage(db: Db, fileId: number, pageNo: number): number {
  return db
    .delete(schema.ocrResult)
    .where(and(eq(schema.ocrResult.fileId, fileId), eq(schema.ocrResult.pageNo, pageNo)))
    .run().changes
}

/**
 * 导出 markdown。整份(不带 `pageNo`)或单页(带)。
 *
 * 整份的形式由 `lib/ocr-markdown.ts` 的 `assembleMarkdown` 定死(页标记 + 按页升序)——
 * **导出的文件再传回来,`splitMarkdown` 必须切出同样的页**,通路 b 才闭环。
 * 不是自己在这里拼,就是为了让这两件事共用一份规则。
 */
export function ocrMarkdown(
  db: Db,
  fileId: number,
  pageNo?: number | null,
): { ok: true; markdown: string; pages: number[] } | { ok: false; message: string } {
  return formatOcrMarkdown(listOcrResults(db, fileId, pageNo), fileId, pageNo)
}

/** 版本核对仅取两列,不加载 markdown/raw;调用者必须在写事务内核对。 */
function checkOcrPageVersion(db: Db, fileId: number, page: number, expected: string | null) {
  const row = db.select({ id: schema.ocrResult.id, revision: schema.ocrResult.revision }).from(schema.ocrResult)
    .where(and(eq(schema.ocrResult.fileId, fileId), eq(schema.ocrResult.pageNo, page))).get()
  const current = row ? `${row.id}:${row.revision}` : null
  return compareOcrPageVersion(page, current, expected)
}

/** 外部单页删除与覆盖使用同一版本规则;只变更 OCR,不触碰任何来源/正式事实。 */
function deleteOcrPageUnlogged(db: Db, fileId: number, page: number, expectedVersion?: string | null) {
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE_NO || !validOcrExpectedVersion(expectedVersion)) {
    return { ok: false as const, statusCode: 400, message: 'page 或 expectedVersion 非法' }
  }
  return db.transaction(tx => {
    if (expectedVersion !== undefined) {
      const conflict = checkOcrPageVersion(tx, fileId, page, expectedVersion)
      if (conflict) return conflict
    }
    const deleted = removeOcrPage(tx, fileId, page)
    const remaining = tx.select({ n: sql<number>`count(*)` }).from(schema.ocrResult).where(eq(schema.ocrResult.fileId, fileId)).get()!.n
    return { ok: true as const, page, deleted, remaining }
  }, { behavior: 'immediate' })
}

export function deleteOcrPage(db: Db, fileId: number, page: number, expectedVersion?: string | null, context: LogContext = {}) {
  try {
    const result = deleteOcrPageUnlogged(db, fileId, page, expectedVersion)
    appLog({ module: 'core', source: 'ocr', operation: 'ocr.page.delete', fileId, page, outcome: result.ok ? (result.deleted ? 'success' : 'skipped') : 'denied', ...(!result.ok ? { level: 'error' as const, errorCode: result.statusCode === 409 ? 'ocr_page_conflict' : 'ocr_page_delete_rejected' } : {}) }, context)
    return result
  } catch (error) {
    appLog({ module: 'core', source: 'ocr', operation: 'ocr.page.delete', fileId, page, outcome: 'failure', level: 'error', errorCode: 'ocr_page_delete_failed' }, context)
    throw error
  }
}
