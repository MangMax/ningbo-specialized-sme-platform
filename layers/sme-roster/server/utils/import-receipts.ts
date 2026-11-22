import { type ImportReceiptAction, invalidImportReceiptQuery, ImportReceiptError, qualificationObject, type QualificationReceiptRow, projectQualificationReceipt, parseImportReceiptSelector, type ReceiptRow, projectImportReceiptMetadata, importReceiptInteger, mergeReceiptSelection, projectMergeReceipt } from './import-receipt-model'
import { sql, type SQL } from 'drizzle-orm'
import { importItemsReadSchema, officialReadQuery, type ImportItemsRead } from './official-evidence-read'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { importReceiptRedactor } from './import-receipt-redaction-sqlite'
type Db = BetterSQLite3Database<typeof schema>
/** Exact SQL projections: neither default reads nor pagination load whole raw blobs into JS. */
export function readImportReceipt(db: Db, action: ImportReceiptAction, args: Record<string, unknown>) {
  if(action==='items' && args.projection!==undefined) {
    const parsed=importItemsReadSchema.safeParse(officialReadQuery(args))
    if(!parsed.success) return invalidImportReceiptQuery('Invalid exact merge snapshot selector')
    const selector = parsed.data
    if(selector.projection==='qualification') {
      try { return db.transaction(()=>readQualificationProjection(db,selector)) }
      catch(error) {if(error instanceof ImportReceiptError) throw error; throw new ImportReceiptError(500,'internal_error','Exact qualification read failed')}
    }
    try { return db.transaction(()=>readMergeSnapshotProjection(db,selector)) }
    catch(error) {if(error instanceof ImportReceiptError) throw error; throw new ImportReceiptError(500,'internal_error','Exact snapshot read failed')}
  }
  const redact = importReceiptRedactor(db)
  return db.transaction(() => {
    const result = redact(readImportReceiptSnapshot(db, action, args))
    if (!qualificationObject(result)) throw new ImportReceiptError(500, 'internal_error', 'Receipt object unavailable')
    return result
  })
}
/** One exact source/item; all raw JSON and length/type gates stay inside SQLite. */
function readQualificationProjection(db: Db, args: ImportItemsRead) {
  const source = args.source!, sourceId = (source === 'private_batch' ? args.batchId : args.receiptId)!, itemIndex = args.itemIndex!
  const sourceQuery = source === 'private_batch'
    ? sql`SELECT b.id AS batch_id,NULL AS receipt_id,b.status,b.status AS batch_status,b.source_kind,'commit' AS operation,b.item_results,b.summary FROM import_batch b WHERE b.id=${sourceId}`
    : sql`SELECT b.id AS batch_id,r.id AS receipt_id,r.status,b.status AS batch_status,b.source_kind,r.operation,r.item_results,r.summary FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id WHERE r.id=${sourceId}`
  const itemPath = `$[${itemIndex}]`
  const diagnosticPath = `$.qualificationDiagnosticsByItem."${itemIndex}"`
  const row = db.get<QualificationReceiptRow>(sql`
    WITH source_row AS (${sourceQuery}), normalized AS (
      SELECT *,CASE WHEN json_valid(item_results) THEN item_results ELSE 'null' END AS items,
        CASE WHEN json_valid(summary) THEN summary ELSE 'false' END AS saved_summary FROM source_row
    ), selected AS (
      SELECT *,json_type(items,${itemPath}) AS item_type,
        CASE WHEN json_type(items,${itemPath})='object' THEN json_extract(items,${itemPath}) ELSE '{}' END AS item,
        json_type(saved_summary,'$.qualificationReadback') AS capture_type,
        CASE WHEN json_type(saved_summary,'$.qualificationReadback')='object' THEN json_extract(saved_summary,'$.qualificationReadback') ELSE NULL END AS capture,
        json_type(saved_summary,'$.qualificationDiagnosticsByItem') AS diagnostics_type,
        CASE WHEN json_type(saved_summary,${diagnosticPath})='object' THEN json_extract(saved_summary,${diagnosticPath}) ELSE '{}' END AS diagnostic_entry FROM normalized
    ) SELECT batch_id AS batchId,receipt_id AS receiptId,item_type AS itemType,
      coalesce(status='committed' AND batch_status='committed' AND operation='commit' AND source_kind='announcement',0) AS validSource,
      coalesce(item_type='object' AND json_type(item,'$.ok')='true' AND json_type(item,'$.kind')='text' AND json_extract(item,'$.kind')='record_event'
        AND json_type(item,'$.detail.enterpriseId')='integer' AND json_extract(item,'$.detail.enterpriseId') BETWEEN 1 AND 9007199254740991,0) AS validItem,
      CASE WHEN json_type(item,'$.detail.enterpriseId')='integer' AND json_extract(item,'$.detail.enterpriseId') BETWEEN 1 AND 9007199254740991 THEN json_extract(item,'$.detail.enterpriseId') ELSE NULL END AS enterpriseId,
      CASE WHEN json_type(item,'$.detail.recordId')='integer' AND json_extract(item,'$.detail.recordId') BETWEEN 1 AND 9007199254740991 THEN json_extract(item,'$.detail.recordId') ELSE NULL END AS recordId,
      coalesce(json_type(item,'$.detail.recordId')='integer' AND json_extract(item,'$.detail.recordId') BETWEEN 1 AND 9007199254740991
        AND json_type(item,'$.ref')='text' AND json_extract(item,'$.ref')='record:'||json_extract(item,'$.detail.recordId'),0) AS recordBound,
      coalesce((summary IS NULL OR json_type(saved_summary)='null' OR json_type(saved_summary)='object' AND (capture_type IS NULL OR capture_type='null')),0) AS captureMissing,
      CASE WHEN capture_type='object' AND length(CAST(capture AS BLOB))<=65536 THEN capture ELSE NULL END AS payload,
      coalesce(summary IS NULL OR json_type(saved_summary)='null' OR json_type(saved_summary)='object' AND diagnostics_type IS NULL,0) AS diagnosticsMissing,
      coalesce(diagnostics_type='object' AND (SELECT count(*) FROM json_each(diagnostic_entry))=7
        AND json_type(diagnostic_entry,'$.itemIndex')='integer' AND json_extract(diagnostic_entry,'$.itemIndex')=${itemIndex}
        AND json_type(diagnostic_entry,'$.ref')='text' AND json_extract(diagnostic_entry,'$.ref')=json_extract(item,'$.ref')
        AND json_type(diagnostic_entry,'$.enterpriseId')='integer' AND json_extract(diagnostic_entry,'$.enterpriseId')=json_extract(item,'$.detail.enterpriseId')
        AND json_type(diagnostic_entry,'$.recordId')='integer' AND json_extract(diagnostic_entry,'$.recordId')=json_extract(item,'$.detail.recordId'),0) AS diagnosticsBound,
      CASE WHEN json_type(diagnostic_entry,'$.candidateRef')='text' AND length(CAST(json_extract(diagnostic_entry,'$.candidateRef') AS BLOB))<=32 THEN json_extract(diagnostic_entry,'$.candidateRef') ELSE NULL END AS candidateRef,
      CASE WHEN json_type(diagnostic_entry,'$.digest')='text' AND length(CAST(json_extract(diagnostic_entry,'$.digest') AS BLOB))=64 THEN json_extract(diagnostic_entry,'$.digest') ELSE NULL END AS diagnosticsDigest,
      CASE WHEN json_type(diagnostic_entry,'$.diagnostics')='object' AND length(CAST(json_extract(diagnostic_entry,'$.diagnostics') AS BLOB))<=65536 THEN json_extract(diagnostic_entry,'$.diagnostics') ELSE NULL END AS diagnosticsPayload FROM selected`)
  return projectQualificationReceipt(row, args, importReceiptRedactor(db))
}
function readImportReceiptSnapshot(db: Db, action: ImportReceiptAction, args: Record<string, unknown>) {
  const { receiptId, batchId, key } = parseImportReceiptSelector(action, args)
  const condition = batchId !== undefined ? sql`b.id = ${batchId}` : receiptId !== undefined
    ? sql`b.id = (SELECT batch_id FROM import_receipt WHERE id = ${receiptId})` : sql`b.idempotency_key = ${key}`
  const row = db.get<ReceiptRow>(sql`
    SELECT b.id AS batchId, substr(b.idempotency_key, 1, 4096) AS idempotencyKey, length(b.idempotency_key) > 4096 AS idempotencyKeyTruncated,
      coalesce(r.status, b.status) AS status, b.source_kind AS sourceKind,
      substr(b.source_identity, 1, 4096) AS sourceIdentity, length(b.source_identity) > 4096 AS sourceIdentityTruncated,
      coalesce(r.created_at, b.created_at) AS createdAt, CASE WHEN r.id IS NULL THEN b.committed_at WHEN r.status = 'committed' THEN r.completed_at ELSE NULL END AS committedAt,
      r.id AS receiptId, r.operation, r.completed_at AS completedAt,
      coalesce(json_array_length(CASE WHEN r.id IS NULL THEN b.item_results ELSE r.item_results END), 0) AS itemCount,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.written') AS written,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.skipped') AS skipped,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.failed') AS failed,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.evidenceRepointed') AS evidenceRepointed,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.canonicalProjection') AS canonicalProjection
    FROM import_batch b LEFT JOIN import_receipt r ON r.id = ${receiptId === undefined ? sql`(SELECT id FROM import_receipt WHERE batch_id = b.id ORDER BY id DESC LIMIT 1)` : sql`${receiptId}`}
    WHERE ${condition} AND b.source_kind IN ('announcement', 'platform_export', 'platform_archive', 'alias_evidence')`)
  if (!row) throw new ImportReceiptError(404, 'not_found', 'Import batch or receipt not found')
  if (action === 'get') return projectImportReceiptMetadata(row)
  if (action === 'request') {
    const offset = importReceiptInteger(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER - 1, 0)
    const maxBytes = importReceiptInteger(args.maxBytes, 'maxBytes', 16384, 65536)
    if (row.receiptId === null) throw new ImportReceiptError(404, 'not_retained', 'Original request was not retained')
    const body = db.get<{ totalBytes: number; chunk: Buffer }>(sql`SELECT length(CAST(COALESCE((SELECT owner.request_body FROM import_receipt owner WHERE owner.id=import_receipt.body_receipt_id), request_body) AS BLOB)) AS totalBytes, substr(CAST(COALESCE((SELECT owner.request_body FROM import_receipt owner WHERE owner.id=import_receipt.body_receipt_id), request_body) AS BLOB), ${offset + 1}, ${maxBytes}) AS chunk FROM import_receipt WHERE id = ${row.receiptId}`)!
    if (offset > body.totalBytes) invalidImportReceiptQuery('offset exceeds request bytes')
    return { batchId: row.batchId, receiptId: row.receiptId, redacted: true, encoding: 'base64', contentType: 'application/json; charset=utf-8', offset, totalBytes: body.totalBytes, nextOffset: offset + body.chunk.length < body.totalBytes ? offset + body.chunk.length : null, data: body.chunk.toString('base64') }
  }
  const page = importReceiptInteger(args.page, 'page', 1, 1000000)
  const pageSize = importReceiptInteger(args.pageSize, 'pageSize', 20, 50)
  const offset = (page - 1) * pageSize
  if (action === 'history') {
    const { total } = db.get<{ total: number }>(sql`SELECT count(*) AS total FROM import_receipt WHERE batch_id = ${row.batchId}`)!
    const rows = db.all(sql`SELECT id AS receiptId, batch_id AS batchId, operation, status, created_at AS createdAt, completed_at AS completedAt, coalesce(json_array_length(item_results), 0) AS itemCount FROM import_receipt WHERE batch_id = ${row.batchId} ORDER BY id LIMIT ${pageSize} OFFSET ${offset}`)
    return { batchId: row.batchId, page, pageSize, total, rows }
  }
  const items = row.receiptId === null ? sql`(SELECT item_results FROM import_batch WHERE id = ${row.batchId})` : sql`(SELECT item_results FROM import_receipt WHERE id = ${row.receiptId})`
  const rows = db.all<{ index: number; ok: number; kind: string; ref: string; errorCode: string | null; errorField: string | null }>(sql`SELECT CAST(key AS INTEGER) AS "index", json_extract(value, '$.ok') AS ok, substr(json_extract(value, '$.kind'), 1, 128) AS kind, substr(json_extract(value, '$.ref'), 1, 256) AS ref, substr(json_extract(value, '$.error.code'), 1, 128) AS errorCode, substr(json_extract(value, '$.error.field'), 1, 128) AS errorField FROM json_each(${items}) ORDER BY CAST(key AS INTEGER) LIMIT ${pageSize} OFFSET ${offset}`)
  return { batchId: row.batchId, receiptId: row.receiptId, status: row.status, page, pageSize, total: row.itemCount, rows: rows.map(item => ({ ...item, ok: !!item.ok })) }
}
/** C owns only this exact historical selector. JSON source/item/fold CTEs never leave SQLite. */
function readMergeSnapshotProjection(db:Db,args:ImportItemsRead) {
  const { binding, maxBytes, pageSize, afterIndex, nextCursor } = mergeReceiptSelection(args)
  const { source, sourceId, itemIndex, oldRecordId } = binding
  const sourceQuery=source==='private_batch'
    ? sql`SELECT b.id AS batch_id,NULL AS receipt_id,b.status,b.status AS batch_status,b.source_kind,CASE WHEN json_valid(b.item_results) THEN b.item_results ELSE 'null' END AS items FROM import_batch b WHERE b.id=${sourceId}`
    : sql`SELECT b.id AS batch_id,r.id AS receipt_id,r.status,b.status AS batch_status,b.source_kind,CASE WHEN json_valid(r.item_results) THEN r.item_results ELSE 'null' END AS items FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id WHERE r.id=${sourceId}`
  const itemPath=`$[${itemIndex}]`
  const cte=sql`WITH source_row AS (${sourceQuery}),selected_json AS (
    SELECT *,json_type(items,${itemPath}) AS item_type,CASE WHEN json_type(items,${itemPath})='object' THEN json_extract(items,${itemPath}) ELSE '{}' END AS item FROM source_row
  ), selected_lineage AS (
    SELECT *,CASE WHEN json_type(item,'$.detail.lineage')='object' THEN json_extract(item,'$.detail.lineage') ELSE '{}' END AS lineage FROM selected_json
  ), folds AS (
    SELECT CASE WHEN f.type='object' THEN f.value ELSE '{}' END AS fold FROM selected_lineage s,
      json_each(CASE WHEN json_type(s.lineage,'$.recordsFolded')='array' THEN json_extract(s.lineage,'$.recordsFolded') ELSE '[]' END) f
    WHERE json_extract(CASE WHEN f.type='object' THEN f.value ELSE '{}' END,'$.fromRecordId')=${oldRecordId} LIMIT 2
  ), selected_fold AS (
    SELECT s.*,f.fold,CASE WHEN json_type(f.fold,'$.fromRecordSnapshot')='object' THEN json_extract(f.fold,'$.fromRecordSnapshot') ELSE '{}' END AS snapshot FROM selected_lineage s LEFT JOIN folds f ON 1
  )`
  const positive=(json:SQL,path:string)=>sql`(json_type(${json},${path})='integer' AND json_extract(${json},${path}) BETWEEN 1 AND 9007199254740991)`
  const fold=sql`fold`,lineage=sql`lineage`,snapshot=sql`snapshot`
  const snapshotTexts=['titleCode','source','nameRaw','usccRaw','district']
  const nullableTexts=['nameRaw','usccRaw','district']
  const fieldTypes=sql.join(snapshotTexts.map(name=>sql`json_type(snapshot,${'$.'+name}) ${sql.raw(nullableTexts.includes(name)?"IN ('text','null')":"='text'")}`),sql` AND `)
  const fieldLengths=sql.join(snapshotTexts.map(name=>sql`(json_type(snapshot,${'$.'+name})='null' OR (length(json_extract(snapshot,${'$.'+name}))<=4000 AND length(CAST(json_extract(snapshot,${'$.'+name}) AS BLOB))<=16000))`),sql` AND `)
  const qualityValid=sql`(json_type(snapshot,'$.qualityFlags')='null' OR (json_type(snapshot,'$.qualityFlags')='array' AND NOT EXISTS(SELECT 1 FROM json_each(snapshot,'$.qualityFlags') WHERE type<>'text')))`
  const qualityLengths=sql`NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(snapshot,'$.qualityFlags')='array' THEN json_extract(snapshot,'$.qualityFlags') ELSE '[]' END) WHERE length(value)>4000 OR length(CAST(value AS BLOB))>16000)`
  const status=sql`CASE
    WHEN NOT coalesce(status='committed' AND batch_status='committed' AND source_kind IN ('announcement','platform_export','platform_archive','alias_evidence') AND item_type='object' AND json_type(item,'$.ok')='true' AND json_type(item,'$.kind')='text' AND json_extract(item,'$.kind')='merge'
      AND ${positive(lineage,'$.fromEnterpriseId')} AND ${positive(lineage,'$.intoEnterpriseId')},0) THEN 'selector_mismatch'
    WHEN json_type(lineage,'$.recordsFolded') IS NULL OR json_type(lineage,'$.recordsFolded')='null' THEN 'not_retained'
    WHEN json_type(lineage,'$.recordsFolded')<>'array' THEN 'selector_mismatch'
    WHEN (SELECT count(*) FROM folds)>1 THEN 'ambiguity'
    WHEN fold IS NULL OR NOT coalesce(${positive(fold,'$.fromRecordId')} AND ${positive(fold,'$.intoRecordId')},0) THEN 'selector_mismatch'
    WHEN json_type(fold,'$.fromRecordSnapshot') IS NULL OR json_type(fold,'$.fromRecordSnapshot')='null' THEN 'not_retained'
    WHEN json_type(fold,'$.fromRecordSnapshot')<>'object' OR NOT coalesce(${positive(snapshot,'$.id')} AND ${positive(snapshot,'$.enterpriseId')},0)
      OR json_extract(snapshot,'$.id')<>${oldRecordId} OR json_extract(snapshot,'$.enterpriseId')<>json_extract(lineage,'$.fromEnterpriseId')
      OR NOT coalesce(${fieldTypes} AND ${qualityValid},0) OR json_extract(snapshot,'$.source') NOT IN ('jxj','miit') THEN 'selector_mismatch'
    WHEN ${Number(args.projection==='snapshot')} AND NOT (${fieldLengths} AND ${qualityLengths}) THEN 'field_limit'
    ELSE 'available' END`
  const base=sql`'formatVersion',1,'source',${source},'batchId',batch_id,'receiptId',receipt_id,'itemIndex',CAST(${itemIndex} AS INTEGER),'oldRecordId',CAST(${oldRecordId} AS INTEGER),'storedRedacted',json(${source==='redacted_receipt'?'true':'false'}),'responseRedacted',json('true')`
  const fixedSnapshot=sql`json_object('id',json_extract(snapshot,'$.id'),'enterpriseId',json_extract(snapshot,'$.enterpriseId'),'titleCode',json_extract(snapshot,'$.titleCode'),'source',json_extract(snapshot,'$.source'),'nameRaw',json_extract(snapshot,'$.nameRaw'),'usccRaw',json_extract(snapshot,'$.usccRaw'),'district',json_extract(snapshot,'$.district'),'qualityFlags',json(json_extract(snapshot,'$.qualityFlags')))`
  const events=sql`CASE WHEN json_type(fold,'$.eventIds')='array' THEN json_extract(fold,'$.eventIds') ELSE '[]' END`
  const eventStatus=sql`CASE WHEN availability<>'available' THEN availability
    WHEN json_type(fold,'$.eventIds') IS NULL OR json_type(fold,'$.eventIds')='null' THEN 'not_retained'
    WHEN json_type(fold,'$.eventIds')<>'array' OR EXISTS(SELECT 1 FROM json_each(${events}) WHERE type<>'integer' OR value<1 OR value>9007199254740991) THEN 'selector_mismatch'
    WHEN ${afterIndex}>=json_array_length(${events}) THEN 'invalid_cursor'
    ELSE 'available' END`
  const eventPage=sql`(SELECT json_group_array(value) FROM (SELECT value FROM json_each(${events}) WHERE CAST(key AS INTEGER)>${afterIndex} ORDER BY CAST(key AS INTEGER) LIMIT ${pageSize}))`
  const hasMore=sql`(SELECT count(*) FROM (SELECT key FROM json_each(${events}) WHERE CAST(key AS INTEGER)>${afterIndex} ORDER BY CAST(key AS INTEGER) LIMIT ${pageSize+1}))>${pageSize}`
  const body=args.projection==='snapshot'
    ? sql`CASE WHEN availability='available' THEN json_object(${base},'availability','available','origin',json_object('fromEnterpriseId',json_extract(lineage,'$.fromEnterpriseId'),'intoEnterpriseId',json_extract(lineage,'$.intoEnterpriseId'),'intoRecordId',json_extract(fold,'$.intoRecordId')),'snapshot',json(${fixedSnapshot})) ELSE json_object(${base},'availability',availability) END`
    : sql`CASE WHEN availability='available' THEN json_object(${base},'availability','available','eventIds',json(${eventPage}),'nextCursor',CASE WHEN ${hasMore} THEN ${nextCursor} ELSE NULL END) ELSE json_object(${base},'availability',availability) END`
  const result=db.get<{availability:string;requiredBytes:number;projection:string|null}>(sql`${cte}, checked AS (SELECT *,${status} AS availability FROM selected_fold LIMIT 1), ready AS (SELECT *,${args.projection==='eventIds'?eventStatus:sql`availability`} AS final_availability FROM checked), rendered AS (
    SELECT availability,${body} AS body FROM (SELECT batch_id,receipt_id,lineage,fold,snapshot,final_availability AS availability FROM ready)
  ) SELECT availability,length(CAST(body AS BLOB)) AS requiredBytes,
    CASE WHEN availability IN ('available','not_retained') AND length(CAST(body AS BLOB))<=${maxBytes} THEN body ELSE NULL END AS projection FROM rendered`)
  return projectMergeReceipt(result, maxBytes, () => importReceiptRedactor(db))
}
export { type ImportReceiptAction, ImportReceiptError, asyncImportReceiptMcpResult, invalidImportReceiptQuery, importReceiptInteger, type ReceiptRow, type QualificationReceiptRow, projectQualificationReceipt, parseImportReceiptSelector, projectImportReceiptMetadata, mergeReceiptSelection, projectMergeReceipt } from './import-receipt-model'
