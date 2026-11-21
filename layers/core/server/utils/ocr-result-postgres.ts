import { sql } from 'drizzle-orm'
import { MAX_PAGE_NO } from '../../lib/ocr-markdown'
import { appLog, type LogContext } from '../../lib/logging'
import { activePostgresPhysicalIntent, requirePostgresFileWrite, type PostgresFileDb } from './file-store-postgres'
import {
  compareOcrPageVersion, DEFAULT_OCR_ENGINE, ocrHistoricalBinding, ocrVersionExpectations,
  pageRelPathOf, validOcrExpectedVersion, validateOcrPages, type OcrWriteInput, type OcrWriteResult, type OcrResultRow,
} from './ocr-result'
import { reviseOcrProvenance } from './ocr-provenance'

type Provenance = NonNullable<Parameters<typeof ocrHistoricalBinding>[0]>
export async function listPostgresOcrResults(db: PostgresFileDb, fileId: number, page?: number | null) {
  const { rows } = await db.execute<Omit<OcrResultRow,'page' | 'version'> & {
    page: string; version: string; revision: Provenance['revision'] | null; capture: Provenance['capture'] | null;
  }>(sql`
    SELECT page_no AS page, id || ':' || revision AS version, markdown, page_rel_path AS "pageRelPath",
      engine, model, channel, created_at AS "createdAt", v.latest AS revision,
      CASE WHEN json_typeof(v.latest->'capture') = 'number' THEN json_build_object(
        'markdown', (j.doc->'captures'->(v.latest->>'capture')::int)->'markdown',
        'input', (j.doc->'captures'->(v.latest->>'capture')::int)->'input'
      ) END AS capture
    FROM ocr_result r
    CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(r.raw,'json') THEN r.raw::json END AS doc) j
    CROSS JOIN LATERAL (SELECT CASE WHEN j.doc->>'format' = 'ocr-provenance-v1' THEN j.doc->'revisions'->-1 END AS latest) v
    WHERE file_id = ${fileId} ${page == null ? sql.empty() : sql`AND page_no = ${page}`} ORDER BY page_no`)
  return rows.map(({ page, revision, capture, ...row }) => ({
    ...row, page: Number(page), historicalBinding: ocrHistoricalBinding({ revision: revision ?? undefined, capture: capture ?? undefined }, row.markdown),
  }))
}

async function checkWritableFile(db: PostgresFileDb, fileId: number) {
  const { rows: [file] } = await db.execute<{ removedAt: string | null }>(sql`
    SELECT removed_at AS "removedAt" FROM stored_file WHERE id = ${fileId} FOR UPDATE`)
  if (!file || file.removedAt) return { ok: false as const, statusCode: 404, message: '文件不存在或已移出库' }
  if (await activePostgresPhysicalIntent(db, fileId)) return { ok: false as const, statusCode: 409, message: '文件正在隔离或恢复' }
}

export async function writePostgresOcrResult(db: PostgresFileDb, input: OcrWriteInput): Promise<OcrWriteResult> {
  requirePostgresFileWrite()
  if (!validOcrExpectedVersion(input.expectedVersion)) return { ok: false, statusCode: 400, message: 'expectedVersion 非法' }
  const checked = validateOcrPages(input.pages)
  if (!checked.ok) return checked
  const expectations = ocrVersionExpectations(input)
  if (!expectations.ok) return expectations
  const engine = input.engine?.trim() || DEFAULT_OCR_ENGINE
  const model = input.model ?? null
  const createdAt = new Date().toISOString()
  const pageNumbers = sql`${sql.param(checked.pages)}::bigint[]`
  return db.transaction(async tx => {
    const file = await checkWritableFile(tx, input.fileId)
    if (file) return file
    const { rows } = await tx.execute<NonNullable<Parameters<typeof reviseOcrProvenance>[0]> & { page: string; version: string }>(sql`
      SELECT page_no AS page, markdown, raw::json, engine, model, channel, created_at AS "createdAt",
        id || ':' || revision AS version
      FROM ocr_result WHERE file_id = ${input.fileId} AND page_no = ANY(${pageNumbers})`)
    const previous = new Map(rows.map(row => [Number(row.page), row]))
    for (const [page, expected] of expectations.pages) {
      const conflict = compareOcrPageVersion(page, previous.get(page)?.version ?? null, expected)
      if (conflict) return conflict
    }
    if (input.replaceExistingPages) await tx.execute(sql`
      DELETE FROM ocr_result WHERE file_id = ${input.fileId} AND page_no <> ALL(${pageNumbers})`)
    for (const page of input.pages) {
      const relPath = page.pageRelPath ?? pageRelPathOf(input.sourceRelPath, page.page)
      const raw = reviseOcrProvenance(previous.get(page.page), { ...page, engine, model, channel: input.channel, createdAt })
      await tx.execute(sql`
        INSERT INTO ocr_result (file_id,page_no,page_rel_path,markdown,raw,engine,model,channel,created_at)
        VALUES (${input.fileId},${page.page},${relPath},${page.markdown},${JSON.stringify(raw)},${engine},${model},${input.channel},${createdAt})
        ON CONFLICT (file_id,page_no) DO UPDATE SET revision = ocr_result.revision + 1,
          page_rel_path = excluded.page_rel_path, markdown = excluded.markdown, raw = excluded.raw,
          engine = excluded.engine, model = excluded.model, channel = excluded.channel, created_at = excluded.created_at`)
    }
    return { ok: true, written: input.pages.length, pages: checked.pages }
  })
}

export async function deletePostgresOcrPage(db: PostgresFileDb, fileId: number, page: number, expectedVersion?: string | null, context: LogContext = {}) {
  requirePostgresFileWrite()
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE_NO || !validOcrExpectedVersion(expectedVersion)) {
    return { ok: false as const, statusCode: 400, message: 'page 或 expectedVersion 非法' }
  }
  try {
    const result = await db.transaction(async tx => {
      const file = await checkWritableFile(tx, fileId)
      if (file) return file
      const key = sql`WHERE file_id = ${fileId} AND page_no = ${page}`
      if (expectedVersion !== undefined) {
        const { rows: [row] } = await tx.execute<{ version: string }>(sql`SELECT id || ':' || revision AS version FROM ocr_result ${key}`)
        const conflict = compareOcrPageVersion(page, row?.version ?? null, expectedVersion)
        if (conflict) return conflict
      }
      const deleted = await tx.execute(sql`DELETE FROM ocr_result ${key}`)
      const { rows: [count] } = await tx.execute<{ remaining: string }>(sql`SELECT count(*) AS remaining FROM ocr_result WHERE file_id = ${fileId}`)
      return { ok: true as const, page, deleted: deleted.rowCount ?? 0, remaining: Number(count!.remaining) }
    })
    appLog({ module: 'core', source: 'ocr', operation: 'ocr.page.delete', fileId, page,
      outcome: result.ok ? (result.deleted ? 'success' : 'skipped') : 'denied',
      ...(!result.ok ? { level: 'error' as const, errorCode: result.statusCode === 409 ? 'ocr_page_conflict' : 'ocr_page_delete_rejected' } : {}),
    }, context)
    return result
  } catch (error) {
    appLog({ module: 'core', source: 'ocr', operation: 'ocr.page.delete', fileId, page, outcome: 'failure', level: 'error', errorCode: 'ocr_page_delete_failed' }, context)
    throw error
  }
}
