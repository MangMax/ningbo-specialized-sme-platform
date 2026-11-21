import { and, asc, count, desc, eq, exists, gt, inArray, isNotNull, isNull, lte, ne, notExists, or, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { importBatch, importReceipt } from '../../../../db/postgresql/import-tables'
import { importItemsReadSchema, officialReadQuery, type ImportItemsRead } from './official-evidence-read'
import { importPostgresReceiptRedactor, type ReceiptRedactor } from './import-receipt-redaction'
import {
  ImportReceiptError, importReceiptInteger, invalidImportReceiptQuery, mergeReceiptSelection,
  parseImportReceiptSelector, projectImportReceiptMetadata, projectQualificationReceipt, projectMergeReceipt,
  type ImportReceiptAction, type QualificationReceiptRow, type ReceiptRow,
} from './import-receipts'

type Reader = Pick<NodePgDatabase, 'select' | '$with' | 'with'>
const kinds = ['announcement', 'platform_export', 'platform_archive', 'alias_evidence']

// Drizzle 0.45 builds SELECTs and joins but has no typed expressions for PostgreSQL JSON operators,
// shape validation and expansion with ordinality, or UTF-8 byte slices. Keep these projections in
// PostgreSQL so the application receives bounded pages instead of the full retained evidence.
const array = (value: SQL) => sql`(CASE WHEN json_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::json END)`
const object = (value: SQL) => sql`(CASE WHEN json_typeof(${value}) = 'object' THEN ${value} ELSE '{}'::json END)`
const parse = (value: SQL, defaultValue = 'null') =>
  sql`(CASE WHEN pg_input_is_valid(${value}, 'json') THEN ${value}::json ELSE ${defaultValue}::json END)`

function integerValue(value: SQL) {
  return sql`(CASE WHEN json_typeof(${value}) = 'number' AND (${value})::text ~ '^[1-9][0-9]{0,15}$'
    THEN CASE WHEN (${value})::text::numeric <= 9007199254740991 THEN (${value})::text::float8 END END)`
}

async function readStandardReceipt(db: Reader, action: ImportReceiptAction, args: Record<string, unknown>) {
  const { receiptId, batchId, key } = parseImportReceiptSelector(action, args)
  if (key?.includes('\0') || key && !key.isWellFormed()) throw new ImportReceiptError(404, 'not_found', 'Import batch or receipt not found')
  const latest = alias(importReceipt, 'latest')
  const selectedReceipt = receiptId ?? db.select({ id: latest.id }).from(latest)
    .where(eq(latest.batchId, importBatch.id)).orderBy(desc(latest.id)).limit(1)
  const match = batchId !== undefined ? eq(importBatch.id, batchId) : receiptId !== undefined
    ? eq(importReceipt.id, receiptId) : eq(importBatch.idempotencyKey, key!)
  const items = sql`(CASE WHEN ${importReceipt.id} IS NULL THEN ${importBatch.itemResults} ELSE ${importReceipt.itemResults} END)::json`
  const summary = sql`(CASE WHEN ${importReceipt.id} IS NULL THEN ${importBatch.summary} ELSE ${importReceipt.summary} END)::json`
  const summaryCount = (field: string) => sql<number | null>`(${summary} ->> ${field}::text)::float8`
  const itemCount = (value: SQL) => sql<number>`json_array_length(${array(value)})`
  const [row]: ReceiptRow[] = await db.select({
    batchId: importBatch.id,
    idempotencyKey: sql<string>`left(${importBatch.idempotencyKey},4096)`,
    idempotencyKeyTruncated: sql<number>`(length(${importBatch.idempotencyKey})>4096)::integer`,
    status: sql<string>`coalesce(${importReceipt.status},${importBatch.status})`,
    sourceKind: importBatch.sourceKind,
    sourceIdentity: sql<string>`left(${importBatch.sourceIdentity},4096)`,
    sourceIdentityTruncated: sql<number>`(length(${importBatch.sourceIdentity})>4096)::integer`,
    createdAt: sql<string>`coalesce(${importReceipt.createdAt},${importBatch.createdAt})`,
    committedAt: sql<string | null>`CASE WHEN ${importReceipt.id} IS NULL THEN ${importBatch.committedAt}
      WHEN ${importReceipt.status}='committed' THEN ${importReceipt.completedAt} END`,
    receiptId: importReceipt.id,
    operation: importReceipt.operation,
    completedAt: importReceipt.completedAt,
    itemCount: itemCount(items),
    written: summaryCount('written'),
    skipped: summaryCount('skipped'),
    failed: summaryCount('failed'),
    evidenceRepointed: summaryCount('evidenceRepointed'),
    canonicalProjection: sql<string | null>`nullif((${summary} -> 'canonicalProjection')::text,'null')`,
  }).from(importBatch).leftJoin(importReceipt, and(eq(importReceipt.batchId, importBatch.id), eq(importReceipt.id, selectedReceipt)))
    .where(and(match, inArray(importBatch.sourceKind, kinds)))
  if (!row) throw new ImportReceiptError(404, 'not_found', 'Import batch or receipt not found')
  if (action === 'get') return projectImportReceiptMetadata(row)
  if (action === 'request') {
    const offset = importReceiptInteger(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER - 1, 0)
    const maxBytes = importReceiptInteger(args.maxBytes, 'maxBytes', 16384, 65536)
    if (row.receiptId === null) throw new ImportReceiptError(404, 'not_retained', 'Original request was not retained')
    const owner = alias(importReceipt, 'owner')
    const source = db.select({
      bytes: sql<Buffer>`convert_to(coalesce(${owner.requestBody},${importReceipt.requestBody}),'UTF8')`.as('bytes'),
    }).from(importReceipt).leftJoin(owner, eq(owner.id, importReceipt.bodyReceiptId))
      .where(eq(importReceipt.id, row.receiptId)).as('source')
    const [stored] = await db.select({
      totalBytes: sql<number>`octet_length(${source.bytes})`,
      chunk: sql<Buffer | null>`CASE WHEN ${offset}::bigint <= octet_length(${source.bytes})
        THEN substring(${source.bytes} FROM (${offset}::integer+1) FOR ${maxBytes}) END`,
    }).from(source)
    if (!stored?.chunk) return invalidImportReceiptQuery('offset exceeds request bytes')
    const { totalBytes, chunk } = stored
    return { batchId: row.batchId, receiptId: row.receiptId, redacted: true, encoding: 'base64',
      contentType: 'application/json; charset=utf-8', offset, totalBytes, data: chunk.toString('base64'),
      nextOffset: offset + chunk.length < totalBytes ? offset + chunk.length : null }
  }
  const page = importReceiptInteger(args.page, 'page', 1, 1_000_000)
  const pageSize = importReceiptInteger(args.pageSize, 'pageSize', 20, 50)
  const offset = (page - 1) * pageSize
  if (action === 'history') {
    const history = eq(importReceipt.batchId, row.batchId)
    const [totals] = await db.select({ total: count() }).from(importReceipt).where(history)
    const rows = await db.select({
      receiptId: importReceipt.id, batchId: importReceipt.batchId, operation: importReceipt.operation,
      status: importReceipt.status, createdAt: importReceipt.createdAt, completedAt: importReceipt.completedAt,
      itemCount: itemCount(sql`${importReceipt.itemResults}::json`),
    }).from(importReceipt).where(history).orderBy(asc(importReceipt.id)).limit(pageSize).offset(offset)
    return { batchId: row.batchId, page, pageSize, total: totals!.total, rows }
  }
  const selectedItems = row.receiptId === null
    ? db.select({ items: importBatch.itemResults }).from(importBatch).where(eq(importBatch.id, row.batchId))
    : db.select({ items: importReceipt.itemResults }).from(importReceipt).where(eq(importReceipt.id, row.receiptId))
  const rows = await db.select({
    index: sql<number>`(ordinal-1)::integer`,
    ok: sql<boolean>`coalesce(value ->> 'ok' = 'true', false)`,
    kind: sql<string | null>`left(value ->> 'kind',128)`,
    ref: sql<string | null>`left(value ->> 'ref',256)`,
    errorCode: sql<string | null>`left(value #>> '{error,code}',128)`,
    errorField: sql<string | null>`left(value #>> '{error,field}',128)`,
  }).from(sql`json_array_elements(${array(sql`(${selectedItems})::json`)}) WITH ORDINALITY item(value,ordinal)`)
    .orderBy(sql`ordinal`).limit(pageSize).offset(offset)
  return { batchId: row.batchId, receiptId: row.receiptId, status: row.status, page, pageSize, total: row.itemCount, rows }
}

function exactSource(db: Reader, args: ImportItemsRead) {
  return args.source === 'private_batch'
    ? db.select({
      batchId: sql`${importBatch.id}`.as('batch_id'), receiptId: sql`NULL::bigint`.as('receipt_id'),
      status: importBatch.status, batchStatus: sql`${importBatch.status}`.as('batch_status'), sourceKind: importBatch.sourceKind,
      operation: sql<string>`'commit'::text`.as('operation'), itemResults: importBatch.itemResults, summary: importBatch.summary,
    }).from(importBatch).where(eq(importBatch.id, args.batchId!))
    : db.select({
      batchId: sql`${importBatch.id}`.as('batch_id'), receiptId: sql`${importReceipt.id}`.as('receipt_id'),
      status: importReceipt.status, batchStatus: sql`${importBatch.status}`.as('batch_status'), sourceKind: importBatch.sourceKind,
      operation: sql<string>`${importReceipt.operation}`.as('operation'),
      itemResults: importReceipt.itemResults, summary: importReceipt.summary,
    }).from(importReceipt).innerJoin(importBatch, eq(importBatch.id, importReceipt.batchId))
      .where(eq(importReceipt.id, args.receiptId!))
}

function exactItem(db: Reader, args: ImportItemsRead) {
  const index = args.itemIndex!
  const source = exactSource(db, args).as('source_row')
  return db.select({
    batchId: source.batchId, receiptId: source.receiptId, status: source.status, batchStatus: source.batchStatus,
    sourceKind: source.sourceKind, operation: source.operation, summary: source.summary,
    item: (index > 2147483647 ? sql`NULL::json` : sql`${parse(sql`${source.itemResults}`)} -> ${index}::integer`).as('item'),
    savedSummary: parse(sql`${source.summary}`, 'false').as('saved_summary'),
  }).from(source).as('selected')
}

async function readQualificationItem(db: Reader, args: ImportItemsRead, redact: ReceiptRedactor) {
  const selected = exactItem(db, args)
  const item = selected.item
  const enterpriseId = integerValue(sql`${item} #> '{detail,enterpriseId}'`)
  const recordId = integerValue(sql`${item} #> '{detail,recordId}'`)
  const capture = sql`${selected.savedSummary} -> 'qualificationReadback'`
  const diagnostics = sql`${selected.savedSummary} -> 'qualificationDiagnosticsByItem'`
  const diag = object(sql`(${diagnostics}) -> ${String(args.itemIndex)}::text`)
  const summaryType = sql`json_typeof(${selected.savedSummary})`
  const absentSummary = or(isNull(selected.summary), eq(summaryType, 'null'))
  const validSummary = eq(summaryType, 'object')
  const validSource = and(eq(selected.status, 'committed'), eq(selected.batchStatus, 'committed'),
    eq(selected.operation, 'commit'), eq(selected.sourceKind, 'announcement'))
  const fieldCount = db.select({ total: count() }).from(sql`json_object_keys(${diag})`)
  const [row]: QualificationReceiptRow[] = await db.select({
    batchId: sql<number>`${selected.batchId}::float8`,
    receiptId: sql<number | null>`${selected.receiptId}::float8`,
    itemType: sql<string | null>`json_typeof(${item})`,
    validSource: sql<boolean>`${validSource}`,
    validItem: sql<boolean>`json_typeof(${item})='object' AND (${item} -> 'ok')::text='true'
      AND ${item} ->> 'kind'='record_event' AND ${enterpriseId} IS NOT NULL`,
    enterpriseId: sql<number | null>`${enterpriseId}`,
    recordId: sql<number | null>`${recordId}`,
    recordBound: sql<boolean>`${recordId} IS NOT NULL AND ${item} ->> 'ref' = 'record:' || ${recordId}::bigint`,
    captureMissing: sql<boolean>`${absentSummary} OR ${validSummary} AND ((${capture}) IS NULL OR json_typeof(${capture})='null')`,
    payload: sql<string | null>`CASE WHEN json_typeof(${capture})='object' AND octet_length((${capture})::text)<=65536
      THEN (${capture})::text END`,
    diagnosticsMissing: sql<boolean>`${absentSummary} OR ${validSummary} AND (${diagnostics}) IS NULL`,
    diagnosticsBound: sql<boolean>`json_typeof(${diagnostics})='object' AND (${fieldCount})=7
      AND json_typeof(${diag} -> 'itemIndex')='number' AND (${diag} -> 'itemIndex')::text=${String(args.itemIndex)}
      AND ${diag} ->> 'ref'=${item} ->> 'ref' AND ${integerValue(sql`${diag} -> 'enterpriseId'`)}=${enterpriseId}
      AND ${integerValue(sql`${diag} -> 'recordId'`)}=${recordId}`,
    candidateRef: sql<string | null>`CASE WHEN json_typeof(${diag} -> 'candidateRef')='string'
      AND octet_length(${diag} ->> 'candidateRef')<=32 THEN ${diag} ->> 'candidateRef' END`,
    diagnosticsDigest: sql<string | null>`CASE WHEN json_typeof(${diag} -> 'digest')='string'
      AND octet_length(${diag} ->> 'digest')=64 THEN ${diag} ->> 'digest' END`,
    diagnosticsPayload: sql<string | null>`CASE WHEN json_typeof(${diag} -> 'diagnostics')='object'
      AND octet_length((${diag} -> 'diagnostics')::text)<=65536 THEN (${diag} -> 'diagnostics')::text END`,
  }).from(selected)
  return projectQualificationReceipt(row, args, redact)
}

function jsonFields(fields: Array<[key: string, value: SQL]>) {
  return sql.join(fields.map(([key, value]) => sql`${(JSON.stringify(key) + ':')} || coalesce(${value}::text,'null')`), sql` || ',' || `)
}

async function readMergeItem(db: Reader, args: ImportItemsRead, redact: ReceiptRedactor) {
  const { binding, maxBytes, afterIndex, pageSize, nextCursor } = mergeReceiptSelection(args)
  const { oldRecordId, itemIndex, source } = binding
  const projectEvents = args.projection === 'eventIds'
  const selected = exactItem(db, args)
  const lineage = db.$with('lineage_row').as(db.select({
    batchId: selected.batchId, receiptId: selected.receiptId, status: selected.status, batchStatus: selected.batchStatus,
    sourceKind: selected.sourceKind, item: selected.item,
    lineage: sql`${selected.item} #> '{detail,lineage}'`.as('lineage'),
  }).from(selected))
  const matches = db.$with('folds').as(db.select({
    fold: sql`candidate.value`.as('fold'),
  }).from(lineage).crossJoin(sql`json_array_elements(${array(sql`${lineage.lineage} -> 'recordsFolded'`)}) candidate(value)`)
    .where(eq(integerValue(sql`candidate.value -> 'fromRecordId'`), oldRecordId)).limit(2))
  const foldCount = db.select({ total: count() }).from(matches)
  const fold = db.select({ fold: matches.fold }).from(matches).limit(1).as('chosen_fold')
  const evidence = db.select({
    batchId: lineage.batchId, receiptId: lineage.receiptId, status: lineage.status, batchStatus: lineage.batchStatus,
    sourceKind: lineage.sourceKind, item: lineage.item, lineage: lineage.lineage, fold: fold.fold,
    snapshot: sql`${fold.fold} -> 'fromRecordSnapshot'`.as('snapshot'),
  }).from(lineage).leftJoin(fold, isNotNull(fold.fold)).as('selected_fold')
  function mergeExpressions(evidence: Pick<typeof lineage, 'lineage'> & { fold: typeof fold.fold; snapshot: typeof selected.item }) {
    const fromId = integerValue(sql`${evidence.lineage} -> 'fromEnterpriseId'`)
    const intoId = integerValue(sql`${evidence.lineage} -> 'intoEnterpriseId'`)
    const foldedInto = integerValue(sql`${evidence.fold} -> 'intoRecordId'`)
    const snapshotId = integerValue(sql`${evidence.snapshot} -> 'id'`)
    const snapshotEnterprise = integerValue(sql`${evidence.snapshot} -> 'enterpriseId'`)
    const snapshotColumns = ['titleCode','source','nameRaw','usccRaw','district']
    const types = and(...snapshotColumns.map((field, index) => inArray(
      sql`json_typeof(${evidence.snapshot} -> ${field}::text)`, index >= 2 ? ['string', 'null'] : ['string'],
    )))
    const sizes = and(...snapshotColumns.map(field =>
      lte(sql`coalesce(length(${evidence.snapshot} ->> ${field}::text),0)`, 4000)))
    const flagRows = sql`json_array_elements(${array(sql`${evidence.snapshot} -> 'qualityFlags'`)}) WITH ORDINALITY flag(value, ordinal)`
    const eventRows = sql`json_array_elements(${array(sql`${evidence.fold} -> 'eventIds'`)}) WITH ORDINALITY e(value, ordinal)`
    const eventCount = sql`json_array_length(${array(sql`${evidence.fold} -> 'eventIds'`)})`
    const events = db.select({
      value: sql`value`.as('value'), ordinal: sql`ordinal`.as('ordinal'),
    }).from(eventRows).where(gt(sql`ordinal`, sql`${afterIndex + 1}::bigint`))
      .orderBy(asc(sql`ordinal`)).limit(pageSize).as('page')
    const eventPage = db.select({
      content: sql`'[' || coalesce(string_agg(${events.value}::text, ',' ORDER BY ${events.ordinal}),'') || ']'`,
    }).from(events)
    const flags = db.select({
      content: sql`'[' || coalesce(string_agg(to_json(value #>> '{}')::text, ',' ORDER BY ordinal),'') || ']'`,
    }).from(flagRows)
    const flagList = sql`CASE WHEN json_typeof(${evidence.snapshot} -> 'qualityFlags')='array' THEN (${flags}) ELSE 'null' END`
    const literal = (value: unknown) => sql`${JSON.stringify(value)}::text`
    const snapshot = jsonFields([
      ['id', sql`${snapshotId}::bigint`], ['enterpriseId', sql`${snapshotEnterprise}::bigint`],
      ...snapshotColumns.map(field => [field, sql`to_json(${evidence.snapshot} ->> ${field}::text)`] as [string, SQL]),
      ['qualityFlags', sql`(${flagList})`],
    ])
    const origin = jsonFields([
      ['fromEnterpriseId', sql`${fromId}::bigint`], ['intoEnterpriseId', sql`${intoId}::bigint`],
      ['intoRecordId', sql`${foldedInto}::bigint`],
    ])
    return { fromId, intoId, foldedInto, snapshotId, snapshotEnterprise, types, sizes, flagRows, eventRows,
      eventCount, eventPage, literal, snapshot, origin }
  }
  const { fromId, intoId, foldedInto, snapshotId, snapshotEnterprise, types, sizes, flagRows, eventRows, eventCount } =
    mergeExpressions(evidence)
  const invalidEvents = db.select({ value: sql`value` }).from(eventRows)
    .where(isNull(integerValue(sql`value`)))
  const invalidFlags = db.select({ value: sql`value` }).from(flagRows)
    .where(ne(sql`json_typeof(value)`, 'string'))
  const oversizedFlags = db.select({ value: sql`value` }).from(flagRows)
    .where(gt(sql`length(value #>> '{}')`, 4000))
  const committedSource = and(eq(evidence.status, 'committed'), eq(evidence.batchStatus, 'committed'),
    inArray(evidence.sourceKind, kinds))
  const checked = db.select({
    batchId: evidence.batchId, receiptId: evidence.receiptId, fold: evidence.fold,
    snapshot: evidence.snapshot, lineage: evidence.lineage,
    availability: sql<string>`CASE
      WHEN NOT coalesce(${committedSource}
        AND json_typeof(${evidence.item})='object' AND (${evidence.item} -> 'ok')::text='true' AND ${evidence.item} ->> 'kind'='merge'
        AND ${fromId} IS NOT NULL AND ${intoId} IS NOT NULL, false) THEN 'selector_mismatch'
      WHEN ${evidence.lineage} -> 'recordsFolded' IS NULL OR json_typeof(${evidence.lineage} -> 'recordsFolded')='null' THEN 'not_retained'
      WHEN json_typeof(${evidence.lineage} -> 'recordsFolded')<>'array' THEN 'selector_mismatch'
      WHEN (${foldCount})>1 THEN 'ambiguity'
      WHEN ${evidence.fold} IS NULL OR ${foldedInto} IS NULL THEN 'selector_mismatch'
      WHEN ${evidence.snapshot} IS NULL OR json_typeof(${evidence.snapshot})='null' THEN 'not_retained'
      WHEN json_typeof(${evidence.snapshot})<>'object' OR ${snapshotId} IS DISTINCT FROM ${oldRecordId}
        OR ${snapshotEnterprise} IS DISTINCT FROM ${fromId}
        OR NOT coalesce(${types} AND (json_typeof(${evidence.snapshot} -> 'qualityFlags')='null' OR
          json_typeof(${evidence.snapshot} -> 'qualityFlags')='array' AND ${notExists(invalidFlags)}),false)
        OR ${evidence.snapshot} ->> 'source' NOT IN ('jxj','miit') THEN 'selector_mismatch'
      ${projectEvents ? sql`
        WHEN ${evidence.fold} -> 'eventIds' IS NULL OR json_typeof(${evidence.fold} -> 'eventIds')='null' THEN 'not_retained'
        WHEN json_typeof(${evidence.fold} -> 'eventIds')<>'array' OR ${exists(invalidEvents)} THEN 'selector_mismatch'
        WHEN ${afterIndex}::bigint >= ${eventCount} THEN 'invalid_cursor'` : sql`
        WHEN NOT (${sizes} AND ${notExists(oversizedFlags)}) THEN 'field_limit'`}
      ELSE 'available' END`.as('availability'),
  }).from(evidence).as('checked')
  const render = mergeExpressions(checked)
  const base = jsonFields([
    ['formatVersion', render.literal(1)], ['source', render.literal(source)],
    ['batchId', sql`${checked.batchId}`], ['receiptId', sql`${checked.receiptId}`], ['itemIndex', render.literal(itemIndex)],
    ['oldRecordId', render.literal(oldRecordId)], ['storedRedacted', render.literal(source === 'redacted_receipt')],
    ['responseRedacted', render.literal(true)], ['availability', sql`to_json(${checked.availability})`],
  ])
  const extended = projectEvents ? jsonFields([
    ['eventIds', sql`(${render.eventPage})`],
    ['nextCursor', sql`CASE WHEN ${render.eventCount} > ${afterIndex + pageSize + 1}::bigint THEN ${render.literal(nextCursor)} END`],
  ]) : jsonFields([
    ['origin', sql`('{' || ${render.origin} || '}')`],
    ['snapshot', sql`('{' || ${render.snapshot} || '}')`],
  ])
  const rendered = db.select({
    availability: checked.availability,
    body: sql`'{' || ${base} || CASE WHEN ${checked.availability}='available' THEN ',' || ${extended} ELSE '' END || '}'`.as('body'),
  }).from(checked).as('rendered')
  const [result] = await db.with(lineage, matches).select({
    availability: rendered.availability,
    requiredBytes: sql<number>`octet_length(${rendered.body})`,
    projection: sql<string | null>`CASE WHEN ${rendered.availability} IN ('available','not_retained')
      AND octet_length(${rendered.body})<=${maxBytes} THEN ${rendered.body} END`,
  }).from(rendered)
  return projectMergeReceipt(result, maxBytes, () => redact)
}

export async function readPostgresImportReceipt(db: NodePgDatabase, action: ImportReceiptAction, args: Record<string, unknown>) {
  return db.transaction(async tx => {
    const redact = await importPostgresReceiptRedactor(tx)
    if (action === 'items' && args.projection !== undefined) {
      const parsed = importItemsReadSchema.safeParse(officialReadQuery(args))
      if (!parsed.success) return invalidImportReceiptQuery('Invalid exact merge snapshot selector')
      const qualification = parsed.data.projection === 'qualification'
      try {
        return qualification ? await readQualificationItem(tx, parsed.data, redact) : await readMergeItem(tx, parsed.data, redact)
      } catch (error) {
        if (error instanceof ImportReceiptError) throw error
        throw new ImportReceiptError(500, 'internal_error', qualification ? 'Exact qualification read failed' : 'Exact snapshot read failed')
      }
    }
    const result = redact(await readStandardReceipt(tx, action, args))
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ImportReceiptError(500, 'internal_error', 'Receipt object unavailable')
    return result as Record<string, unknown>
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
