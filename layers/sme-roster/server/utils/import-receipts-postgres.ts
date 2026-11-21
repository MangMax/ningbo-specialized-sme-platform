import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { importItemsReadSchema, officialReadQuery, type ImportItemsRead } from './official-evidence-read'
import { importPostgresReceiptRedactor, type ReceiptRedactor } from './import-receipt-redaction'
import {
  ImportReceiptError, importReceiptInteger, invalidImportReceiptQuery, mergeReceiptSelection,
  parseImportReceiptSelector, projectImportReceiptMetadata, projectQualificationReceipt, projectMergeReceipt,
  type ImportReceiptAction, type QualificationReceiptRow, type ReceiptRow,
} from './import-receipts'

type Reader = Pick<NodePgDatabase, 'execute'>
const kinds = sql`('announcement','platform_export','platform_archive','alias_evidence')`
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
  const match = batchId !== undefined ? sql`b.id = ${batchId}` : receiptId !== undefined
    ? sql`b.id = (SELECT batch_id FROM import_receipt WHERE id = ${receiptId})` : sql`b.idempotency_key = ${key}`
  const { rows: [row] } = await db.execute<ReceiptRow>(sql`
    SELECT b.id::float8 AS "batchId", left(b.idempotency_key,4096) AS "idempotencyKey",
      (length(b.idempotency_key)>4096)::integer AS "idempotencyKeyTruncated",
      coalesce(r.status,b.status) AS status, b.source_kind AS "sourceKind",
      left(b.source_identity,4096) AS "sourceIdentity", (length(b.source_identity)>4096)::integer AS "sourceIdentityTruncated",
      coalesce(r.created_at,b.created_at) AS "createdAt",
      CASE WHEN r.id IS NULL THEN b.committed_at WHEN r.status='committed' THEN r.completed_at END AS "committedAt",
      r.id::float8 AS "receiptId", r.operation, r.completed_at AS "completedAt",
      json_array_length(${array(sql`j.items`)}) AS "itemCount",
      (j.summary ->> 'written')::float8 AS written, (j.summary ->> 'skipped')::float8 AS skipped,
      (j.summary ->> 'failed')::float8 AS failed, (j.summary ->> 'evidenceRepointed')::float8 AS "evidenceRepointed",
      nullif((j.summary -> 'canonicalProjection')::text, 'null') AS "canonicalProjection"
    FROM import_batch b LEFT JOIN import_receipt r ON r.id = ${receiptId === undefined
      ? sql`(SELECT id FROM import_receipt WHERE batch_id=b.id ORDER BY id DESC LIMIT 1)` : sql`${receiptId}`}
    CROSS JOIN LATERAL (SELECT (CASE WHEN r.id IS NULL THEN b.item_results ELSE r.item_results END)::json AS items,
      (CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END)::json AS summary) j
    WHERE ${match} AND b.source_kind IN ${kinds}`)
  if (!row) throw new ImportReceiptError(404, 'not_found', 'Import batch or receipt not found')
  if (action === 'get') return projectImportReceiptMetadata(row)
  if (action === 'request') {
    const offset = importReceiptInteger(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER - 1, 0)
    const maxBytes = importReceiptInteger(args.maxBytes, 'maxBytes', 16384, 65536)
    if (row.receiptId === null) throw new ImportReceiptError(404, 'not_retained', 'Original request was not retained')
    const { rows: [stored] } = await db.execute<{ totalBytes: number; chunk: Buffer | null }>(sql`
      SELECT octet_length(bytes) AS "totalBytes",
        CASE WHEN ${offset}::bigint <= octet_length(bytes) THEN substring(bytes FROM (${offset}::integer+1) FOR ${maxBytes}) END AS chunk
      FROM (SELECT convert_to(coalesce(owner.request_body,r.request_body),'UTF8') AS bytes
        FROM import_receipt r LEFT JOIN import_receipt owner ON owner.id=r.body_receipt_id WHERE r.id=${row.receiptId}) source`)
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
    const { rows: [count] } = await db.execute<{ total: string }>(sql`SELECT count(*) AS total FROM import_receipt WHERE batch_id = ${row.batchId}`)
    const { rows } = await db.execute(sql`
      SELECT id::float8 AS "receiptId", batch_id::float8 AS "batchId", operation, status,
        created_at AS "createdAt", completed_at AS "completedAt", json_array_length(${array(sql`item_results::json`)}) AS "itemCount"
      FROM import_receipt WHERE batch_id = ${row.batchId} ORDER BY id LIMIT ${pageSize} OFFSET ${offset}`)
    return { batchId: row.batchId, page, pageSize, total: Number(count!.total), rows }
  }
  const items = row.receiptId === null ? sql`(SELECT item_results FROM import_batch WHERE id = ${row.batchId})`
    : sql`(SELECT item_results FROM import_receipt WHERE id = ${row.receiptId})`
  const { rows } = await db.execute(sql`
    SELECT (ordinal-1)::integer AS "index", coalesce(value ->> 'ok' = 'true', false) AS ok,
      left(value ->> 'kind',128) AS kind, left(value ->> 'ref',256) AS ref,
      left(value #>> '{error,code}',128) AS "errorCode", left(value #>> '{error,field}',128) AS "errorField"
    FROM json_array_elements(${array(sql`${items}::json`)}) WITH ORDINALITY item(value,ordinal)
    ORDER BY ordinal LIMIT ${pageSize} OFFSET ${offset}`)
  return { batchId: row.batchId, receiptId: row.receiptId, status: row.status, page, pageSize, total: row.itemCount, rows }
}

function exactSource(args: ImportItemsRead) {
  return args.source === 'private_batch'
    ? sql`SELECT b.id AS batch_id,NULL::bigint AS receipt_id,b.status,b.status AS batch_status,b.source_kind,
        'commit' AS operation,b.item_results,b.summary FROM import_batch b WHERE b.id=${args.batchId}`
    : sql`SELECT b.id AS batch_id,r.id AS receipt_id,r.status,b.status AS batch_status,b.source_kind,
        r.operation,r.item_results,r.summary FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id WHERE r.id=${args.receiptId}`
}

function exactItem(args: ImportItemsRead) {
  const index = args.itemIndex!
  return sql`WITH source_row AS (${exactSource(args)}), selected AS (
    SELECT *, ${index > 2147483647 ? sql`NULL::json` : sql`${parse(sql`item_results`)} -> ${index}::integer`} AS item,
      ${parse(sql`summary`, 'false')} AS saved_summary FROM source_row
  )`
}

async function readQualificationItem(db: Reader, args: ImportItemsRead, redact: ReceiptRedactor) {
  const entId = integerValue(sql`item #> '{detail,enterpriseId}'`)
  const recId = integerValue(sql`item #> '{detail,recordId}'`)
  const diag = object(sql`saved_summary -> 'qualificationDiagnosticsByItem' -> ${String(args.itemIndex)}::text`)
  const { rows: [row] } = await db.execute<QualificationReceiptRow>(sql`${exactItem(args)}, facts AS (
    SELECT *, ${entId} AS enterprise_id, ${recId} AS record_id, saved_summary -> 'qualificationReadback' AS capture,
      saved_summary -> 'qualificationDiagnosticsByItem' AS diagnostics, ${diag} AS diag FROM selected
  )
  SELECT batch_id::float8 AS "batchId", receipt_id::float8 AS "receiptId", json_typeof(item) AS "itemType",
    (status='committed' AND batch_status='committed' AND operation='commit' AND source_kind='announcement') AS "validSource",
    (json_typeof(item)='object' AND (item -> 'ok')::text='true' AND item ->> 'kind'='record_event' AND enterprise_id IS NOT NULL) AS "validItem",
    enterprise_id AS "enterpriseId", record_id AS "recordId",
    (record_id IS NOT NULL AND item ->> 'ref' = 'record:' || record_id::bigint) AS "recordBound",
    (summary IS NULL OR json_typeof(saved_summary)='null' OR json_typeof(saved_summary)='object'
      AND (capture IS NULL OR json_typeof(capture)='null')) AS "captureMissing",
    CASE WHEN json_typeof(capture)='object' AND octet_length(capture::text)<=65536 THEN capture::text END AS payload,
    (summary IS NULL OR json_typeof(saved_summary)='null' OR json_typeof(saved_summary)='object' AND diagnostics IS NULL) AS "diagnosticsMissing",
    (json_typeof(diagnostics)='object' AND (SELECT count(*) FROM json_object_keys(diag))=7
      AND json_typeof(diag -> 'itemIndex')='number' AND (diag -> 'itemIndex')::text=${String(args.itemIndex)}
      AND diag ->> 'ref'=item ->> 'ref' AND ${integerValue(sql`diag -> 'enterpriseId'`)}=enterprise_id
      AND ${integerValue(sql`diag -> 'recordId'`)}=record_id) AS "diagnosticsBound",
    CASE WHEN json_typeof(diag -> 'candidateRef')='string' AND octet_length(diag ->> 'candidateRef')<=32 THEN diag ->> 'candidateRef' END AS "candidateRef",
    CASE WHEN json_typeof(diag -> 'digest')='string' AND octet_length(diag ->> 'digest')=64 THEN diag ->> 'digest' END AS "diagnosticsDigest",
    CASE WHEN json_typeof(diag -> 'diagnostics')='object' AND octet_length((diag -> 'diagnostics')::text)<=65536
      THEN (diag -> 'diagnostics')::text END AS "diagnosticsPayload"
  FROM facts`)
  return projectQualificationReceipt(row, args, redact)
}

function jsonFields(fields: Array<[key: string, value: SQL]>) {
  return sql.join(fields.map(([key, value]) => sql`${(JSON.stringify(key) + ':')} || coalesce(${value}::text,'null')`), sql` || ',' || `)
}

async function readMergeItem(db: Reader, args: ImportItemsRead, redact: ReceiptRedactor) {
  const { binding, maxBytes, afterIndex, pageSize, nextCursor } = mergeReceiptSelection(args)
  const { oldRecordId, itemIndex, source } = binding
  const projectEvents = args.projection === 'eventIds'
  const fromId = integerValue(sql`lineage -> 'fromEnterpriseId'`)
  const intoId = integerValue(sql`lineage -> 'intoEnterpriseId'`)
  const foldedInto = integerValue(sql`fold -> 'intoRecordId'`)
  const snapshotId = integerValue(sql`snapshot -> 'id'`)
  const snapshotEnterprise = integerValue(sql`snapshot -> 'enterpriseId'`)
  const snapshotColumns = ['titleCode','source','nameRaw','usccRaw','district']
  const types = sql.join(snapshotColumns.map((field, index) => sql`json_typeof(snapshot -> ${field}::text) IN ('string'${index >= 2 ? sql`,'null'` : sql.empty()})`), sql` AND `)
  const sizes = sql.join(snapshotColumns.map(field => sql`coalesce(length(snapshot ->> ${field}::text),0)<=4000`), sql` AND `)
  const flagRows = sql`json_array_elements(${array(sql`snapshot -> 'qualityFlags'`)}) WITH ORDINALITY flag(value, ordinal)`
  const eventRows = sql`json_array_elements(${array(sql`fold -> 'eventIds'`)}) WITH ORDINALITY e(value, ordinal)`
  const eventCount = sql`json_array_length(${array(sql`fold -> 'eventIds'`)})`
  const eventPage = sql`'[' || coalesce((SELECT string_agg(value::text, ',' ORDER BY ordinal)
      FROM (SELECT value, ordinal FROM ${eventRows} WHERE ordinal > ${afterIndex + 1}::bigint ORDER BY ordinal LIMIT ${pageSize}) page),'') || ']'`
  const flagList = sql`CASE WHEN json_typeof(snapshot -> 'qualityFlags')='array' THEN
      '[' || coalesce((SELECT string_agg(to_json(value #>> '{}')::text, ',' ORDER BY ordinal) FROM ${flagRows}),'') || ']'
      ELSE 'null' END`
  const literal = (value: unknown) => sql`${JSON.stringify(value)}::text`
  const snapshot = jsonFields([
    ['id', sql`${snapshotId}::bigint`], ['enterpriseId', sql`${snapshotEnterprise}::bigint`],
    ...snapshotColumns.map(field => [field, sql`to_json(snapshot ->> ${field}::text)`] as [string, SQL]),
    ['qualityFlags', sql`(${flagList})`],
  ])
  const origin = jsonFields([
    ['fromEnterpriseId', sql`${fromId}::bigint`], ['intoEnterpriseId', sql`${intoId}::bigint`],
    ['intoRecordId', sql`${foldedInto}::bigint`],
  ])
  const base = jsonFields([
    ['formatVersion', literal(1)], ['source', literal(source)],
    ['batchId', sql`batch_id`], ['receiptId', sql`receipt_id`], ['itemIndex', literal(itemIndex)],
    ['oldRecordId', literal(oldRecordId)], ['storedRedacted', literal(source === 'redacted_receipt')],
    ['responseRedacted', literal(true)], ['availability', sql`to_json(availability)`],
  ])
  const extended = projectEvents ? jsonFields([
    ['eventIds', sql`(${eventPage})`],
    ['nextCursor', sql`CASE WHEN ${eventCount} > ${afterIndex + pageSize + 1}::bigint THEN ${literal(nextCursor)} END`],
  ]) : jsonFields([
    ['origin', sql`('{' || ${origin} || '}')`],
    ['snapshot', sql`('{' || ${snapshot} || '}')`],
  ])
  const { rows: [result] } = await db.execute<{ availability: string; requiredBytes: number; projection: string | null }>(sql`
    ${exactItem(args)}, lineage AS (
      SELECT *, item #> '{detail,lineage}' AS lineage FROM selected
    ), folds AS (
      SELECT fold.value AS fold FROM lineage l, json_array_elements(${array(sql`l.lineage -> 'recordsFolded'`)}) fold(value)
      WHERE ${integerValue(sql`fold.value -> 'fromRecordId'`)}=${oldRecordId} LIMIT 2
    ), selected_fold AS (
      SELECT s.*, f.fold, f.fold -> 'fromRecordSnapshot' AS snapshot FROM lineage s
      LEFT JOIN (SELECT fold FROM folds LIMIT 1) f ON true
    ), checked AS (
      SELECT *, CASE
        WHEN NOT coalesce(status='committed' AND batch_status='committed' AND source_kind IN ${kinds}
          AND json_typeof(item)='object' AND (item -> 'ok')::text='true' AND item ->> 'kind'='merge'
          AND ${fromId} IS NOT NULL AND ${intoId} IS NOT NULL, false) THEN 'selector_mismatch'
        WHEN lineage -> 'recordsFolded' IS NULL OR json_typeof(lineage -> 'recordsFolded')='null' THEN 'not_retained'
        WHEN json_typeof(lineage -> 'recordsFolded')<>'array' THEN 'selector_mismatch'
        WHEN (SELECT count(*) FROM folds)>1 THEN 'ambiguity'
        WHEN fold IS NULL OR ${foldedInto} IS NULL THEN 'selector_mismatch'
        WHEN snapshot IS NULL OR json_typeof(snapshot)='null' THEN 'not_retained'
        WHEN json_typeof(snapshot)<>'object' OR ${snapshotId} IS DISTINCT FROM ${oldRecordId} OR ${snapshotEnterprise} IS DISTINCT FROM ${fromId}
          OR NOT coalesce(${types} AND (json_typeof(snapshot -> 'qualityFlags')='null' OR
            json_typeof(snapshot -> 'qualityFlags')='array' AND NOT EXISTS (SELECT 1 FROM ${flagRows} WHERE json_typeof(value)<>'string')),false)
          OR snapshot ->> 'source' NOT IN ('jxj','miit') THEN 'selector_mismatch'
        ${projectEvents ? sql`
          WHEN fold -> 'eventIds' IS NULL OR json_typeof(fold -> 'eventIds')='null' THEN 'not_retained'
          WHEN json_typeof(fold -> 'eventIds')<>'array' OR EXISTS (SELECT 1 FROM ${eventRows} WHERE ${integerValue(sql`value`)} IS NULL) THEN 'selector_mismatch'
          WHEN ${afterIndex}::bigint >= ${eventCount} THEN 'invalid_cursor'` : sql`
          WHEN NOT (${sizes} AND NOT EXISTS (SELECT 1 FROM ${flagRows} WHERE length(value #>> '{}')>4000)) THEN 'field_limit'`}
        ELSE 'available' END AS availability FROM selected_fold
    ), rendered AS (
      SELECT availability, '{' || ${base} ||
        CASE WHEN availability='available' THEN ',' || ${extended} ELSE '' END || '}' AS body FROM checked
    )
    SELECT availability, octet_length(body) AS "requiredBytes",
      CASE WHEN availability IN ('available','not_retained') AND octet_length(body)<=${maxBytes} THEN body END AS projection FROM rendered`)
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
