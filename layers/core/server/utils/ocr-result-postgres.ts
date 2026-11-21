import { and, asc, count, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { ocrResult, storedFile } from '../../../../db/postgresql/file-tables'
import { MAX_PAGE_NO } from '../../lib/ocr-markdown'
import { appLog, type LogContext } from '../../lib/logging'
import { activePostgresPhysicalIntent, requirePostgresFileWrite, type PostgresFileDb } from './file-store-postgres'
import {
  compareOcrPageVersion, DEFAULT_OCR_ENGINE, ocrHistoricalBinding, ocrVersionExpectations,
  pageRelPathOf, validOcrExpectedVersion, validateOcrPages, type OcrWriteInput, type OcrWriteResult, type OcrResultRow,
} from './ocr-result'
import { reviseOcrProvenance } from './ocr-provenance'

type Provenance = NonNullable<Parameters<typeof ocrHistoricalBinding>[0]>

export async function listPostgresOcrResults(db: PostgresFileDb, fileId: number, page?: number | null): Promise<(OcrResultRow & { version: string })[]> {
  // Drizzle has no API for validating or navigating nested JSON stored as text.
  // Project the binding in PostgreSQL without fetching the full provider payload.
  const results = db.select({
    id: ocrResult.id, versionRevision: ocrResult.revision, page: ocrResult.page, markdown: ocrResult.markdown,
    pageRelPath: ocrResult.pageRelPath, engine: ocrResult.engine, model: ocrResult.model,
    channel: ocrResult.channel, createdAt: ocrResult.createdAt,
    doc: sql`CASE WHEN pg_input_is_valid(${ocrResult.raw}, 'json') THEN ${ocrResult.raw}::json END`.as('provenance_doc'),
  }).from(ocrResult).where(and(eq(ocrResult.fileId, fileId), page == null ? undefined : eq(ocrResult.page, page))).as('results')
  const revisions = db.select({
    id: results.id, versionRevision: results.versionRevision, page: results.page, markdown: results.markdown,
    pageRelPath: results.pageRelPath, engine: results.engine, model: results.model,
    channel: results.channel, createdAt: results.createdAt, doc: results.doc,
    latest: sql<Provenance['revision'] | null>`CASE WHEN ${results.doc}->>'format' = 'ocr-provenance-v1' THEN ${results.doc}->'revisions'->-1 END`.as('latest_revision'),
  }).from(results).as('revisions')
  const capture = sql`(${revisions.doc}->'captures'->(${revisions.latest}->>'capture')::int)`
  const rows = await db.select({
    id: revisions.id, versionRevision: revisions.versionRevision, page: revisions.page, markdown: revisions.markdown,
    pageRelPath: revisions.pageRelPath, engine: revisions.engine, model: revisions.model,
    channel: revisions.channel, createdAt: revisions.createdAt, latest: revisions.latest,
    capture: sql<Provenance['capture'] | null>`CASE WHEN json_typeof(${revisions.latest}->'capture') = 'number'
      THEN json_build_object('markdown', ${capture}->'markdown', 'input', ${capture}->'input') END`,
  }).from(revisions).orderBy(asc(revisions.page))
  return rows.map(({ id, versionRevision, latest, capture, ...row }) => ({
    ...row, version: `${id}:${versionRevision}`,
    historicalBinding: ocrHistoricalBinding({ revision: latest ?? undefined, capture: capture ?? undefined }, row.markdown),
  }))
}

async function checkWritableFile(db: PostgresFileDb, fileId: number) {
  const [file] = await db.select({ removedAt: storedFile.removedAt }).from(storedFile)
    .where(eq(storedFile.id, fileId)).for('update')
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
  const fileScope = eq(ocrResult.fileId, input.fileId)
  return db.transaction(async tx => {
    const file = await checkWritableFile(tx, input.fileId)
    if (file) return file
    const rows = await tx.select().from(ocrResult).where(and(fileScope, inArray(ocrResult.page, checked.pages)))
    const previous = new Map(rows.map(row => [row.page, { ...row, raw: row.raw === null ? null : JSON.parse(row.raw) }]))
    for (const [page, expected] of expectations.pages) {
      const row = previous.get(page)
      const conflict = compareOcrPageVersion(page, row ? `${row.id}:${row.revision}` : null, expected)
      if (conflict) return conflict
    }
    if (input.replaceExistingPages) {
      await tx.delete(ocrResult).where(and(fileScope, notInArray(ocrResult.page, checked.pages)))
    }
    for (const page of input.pages) {
      const row = previous.get(page.page)
      const raw = reviseOcrProvenance(row,
        { ...page, engine, model, channel: input.channel, createdAt })
      const values = {
        pageRelPath: page.pageRelPath ?? pageRelPathOf(input.sourceRelPath, page.page),
        markdown: page.markdown, raw: JSON.stringify(raw), engine, model, channel: input.channel, createdAt,
      }
      await tx.insert(ocrResult).values({ ...values, fileId: input.fileId, page: page.page })
        .onConflictDoUpdate({
          target: [ocrResult.fileId, ocrResult.page],
          // Drizzle has no builder for column arithmetic in the conflict update.
          set: { ...values, revision: sql`${ocrResult.revision} + 1` },
        })
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
      const fileScope = eq(ocrResult.fileId, fileId)
      const key = and(fileScope, eq(ocrResult.page, page))
      if (expectedVersion !== undefined) {
        const [row] = await tx.select({ id: ocrResult.id, revision: ocrResult.revision }).from(ocrResult).where(key)
        const conflict = compareOcrPageVersion(page, row ? `${row.id}:${row.revision}` : null, expectedVersion)
        if (conflict) return conflict
      }
      const deleted = await tx.delete(ocrResult).where(key)
      const [counted] = await tx.select({ remaining: count() }).from(ocrResult).where(fileScope)
      return { ok: true as const, page, deleted: deleted.rowCount ?? 0, remaining: counted!.remaining }
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
