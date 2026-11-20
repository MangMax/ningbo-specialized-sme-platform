import { setImmediate } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { fileNameOf } from '../../../core/lib/preview'
import type { StoredFileContentIdentity } from '../../../core/server/utils/file-content-identity'
import type { RecordComparisonInput } from '../../lib/roster/record-comparison'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { officialSourceDirectory, type OfficialSourceDocument } from './official-source-directory'
import { readPostgresComparisonIdentities } from './record-comparison-catalog-postgres'
import { readPostgresObservationComparisonFacts } from './record-correspondence-target-postgres'
import { readPostgresCorrespondenceSelection } from './record-correspondence-postgres'
import { readPostgresFingerprintQueries } from './postgres-platform-fingerprint'
import { compareRecordInputs, comparisonBefore, projectLegacyComparisonImpact, validatedComparisonInput, type ComparisonRead, type SelectedRecordComparison, type VerifiedComparisonEvidence } from './record-comparison'
import { readPostgresComparisonProofHead, readPostgresCurrentProofSource, readPostgresOfficialProofSource } from './comparison-scope-proof-postgres'
import { ProofSourceError, type CurrentEvidence, type OfficialEvidence } from './comparison-scope-proof-source'

type Reader = Pick<NodePgDatabase, 'execute'>
type QueryFacts = SelectedRecordComparison['queries'][number]['comparisonFacts']
type BusinessMetadata = SelectedRecordComparison['businessMetadata'] extends Map<number, infer T> ? T : never
const numbers = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

async function readDocuments(db: Reader, ids: number[]): Promise<SelectedRecordComparison['documents']> {
  const { rows } = await db.execute<{ row: OfficialSourceDocument; registered: StoredFileContentIdentity | null }>(sql`
    WITH selected AS (
      SELECT id,source,title,doc_number AS "docNumber",issue_date AS "issueDate",path FROM source_document
        WHERE source='jxj' AND id=ANY(${numbers(ids)})
      UNION ALL SELECT * FROM ${officialSourceDirectory} d WHERE d.id<0 AND d.id=ANY(${numbers(ids)})
    ) SELECT row_to_json(d) AS row,
      CASE WHEN f.id IS NOT NULL THEN json_build_object('fileId',f.id,'relPath',f.rel_path,'sha256',f.sha256,'bytes',f.bytes) END AS registered
    FROM selected d LEFT JOIN stored_file f ON f.rel_path=d.path ORDER BY d.id`)
  return rows.map(({ row, registered }) => ({ ...row, title: row.title ?? fileNameOf(row.path),
    contentIdentity: { registered, status: 'unknown', historical: 'unknown' } }))
}

async function readQueryFacts(db: Reader, ids: number[]): Promise<QueryFacts[]> {
  const { rows } = await db.execute<{ id: number; collection: QueryFacts['collection'] }>(sql`
    SELECT q.old_id::float8 AS id, ${postgresRosterRow(schema.platformCollection,'c')} AS collection
    FROM platform_legacy_query_alias q JOIN platform_collection c ON c.id=q.collection_id
    WHERE q.old_id=ANY(${numbers(ids)}) ORDER BY q.old_id`)
  const coordinates = numbers(rows.map(row => row.collection.id))
  const projected = async <T extends typeof schema.platformCollectionPage | typeof schema.platformCollectionUnfinished>(table: T) => {
    const { rows } = await db.execute<{ row: T['$inferSelect'] }>(sql`
      SELECT ${postgresRosterRow(table,'p')} AS row FROM ${table} p
      WHERE p.collection_id=ANY(${coordinates}) ORDER BY p.collection_id,p.ordinal`)
    return Map.groupBy(rows.map(value => value.row), row => row.collectionId)
  }
  const pages = await projected(schema.platformCollectionPage)
  const unfinished = await projected(schema.platformCollectionUnfinished)
  const conditions = await db.execute<{ collectionId: number; name: string; valueKind: string; textValue: string | null; integerValue: number | null }>(sql`
    SELECT collection_id::float8 AS "collectionId",name,value_kind AS "valueKind",text_value AS "textValue",integer_value::float8 AS "integerValue"
    FROM platform_collection_condition WHERE collection_id=ANY(${coordinates})`)
  const titleScopes = await db.execute<{ collectionId: number; rdjb: string }>(sql`
    SELECT collection_id::float8 AS "collectionId",rdjb FROM platform_query_title_scope WHERE collection_id=ANY(${coordinates})`)
  const byCondition = Map.groupBy(conditions.rows, row => row.collectionId)
  const byTitle = Map.groupBy(titleScopes.rows, row => row.collectionId)
  return rows.map(({ id, collection }) => {
    const coordinate = collection.id, evidencePresent = ['captured', 'conflict'].includes(collection.provenanceState)
    const values = byCondition.get(coordinate)
    const scopeOrder = collection.rdjb.split(',')
    return { id, collection, evidencePresent, pages: pages.get(coordinate) ?? [], unfinished: unfinished.get(coordinate) ?? [],
      conditions: evidencePresent && values ? Object.fromEntries(values.filter(r => r.valueKind !== 'absent').map(r => [r.name, r.valueKind === 'text' ? r.textValue : r.valueKind === 'boolean' ? Boolean(r.integerValue) : r.integerValue])) : null,
      scopes: (byTitle.get(coordinate) ?? []).map(row => row.rdjb).sort((a,b) => scopeOrder.indexOf(a) - scopeOrder.indexOf(b)), }
  })
}

async function verifiedProofs(db: Reader, input: RecordComparisonInput, signal?: AbortSignal): Promise<VerifiedComparisonEvidence> {
  const evidence: VerifiedComparisonEvidence = { officialScopes: [], currentScopes: [] }
  for (const id of new Set(input.proofIds ?? [])) {
    signal?.throwIfAborted()
    const head = await readPostgresComparisonProofHead(db, id)
    if (!head || head.state?.status !== 'confirmed' || !comparisonBefore(head.state.decidedAt, input.asOf)) continue
    const { proof, state } = head
    try {
      if (proof.kind === 'official_coverage') {
        const value = proof.evidence as OfficialEvidence
        const sourceDocumentIds = value.sourceDocuments.map(ref => ref.id)
        if (!sourceDocumentIds.every(ref => input.officialSourceDocumentIds.includes(ref))) continue
        const observed = await readPostgresOfficialProofSource(db, value)
        if (observed.sourceFingerprint !== proof.sourceFingerprint) continue
        evidence.officialScopes.push({ proofId: String(id), sourceDocumentIds, titleCode: value.titleCode, fromYear: value.fromYear,
          throughYear: value.throughYear, enterpriseIds: value.enterpriseIds, verifiedAt: state.decidedAt })
      } else {
        const value = proof.evidence as CurrentEvidence
        if (!input.queryIds.includes(value.queryId) || !input.exportBatchIds.includes(value.exportBatchId)) continue
        const observed = await readPostgresCurrentProofSource(db, value)
        if (observed.sourceFingerprint !== proof.sourceFingerprint) continue
        evidence.currentScopes.push({ proofId: String(id), queryId: value.queryId, exportBatchId: value.exportBatchId, titleCode: value.titleCode,
          querySourceFingerprint: observed.querySourceFingerprint, exportSha256: observed.exportSha256, scopeEquivalent: true,
          versionEquivalent: true, verifiedAt: state.decidedAt })
      }
    } catch (error) { if (!(error instanceof ProofSourceError)) throw error }
  }
  return evidence
}

async function selectComparison(db: Reader, input: RecordComparisonInput, verified: VerifiedComparisonEvidence): Promise<SelectedRecordComparison> {
  const facts = await readQueryFacts(db, input.queryIds)
  const batches = (await readPostgresRosterRowsById(db, schema.platformExportBatch, sql`FROM platform_export_batch p WHERE p.id=ANY(${numbers(input.exportBatchIds)})`))
    .filter(row => row.importStatus === 'imported' && comparisonBefore(row.collectedOn, input.asOf))
  const documents = (await readDocuments(db, input.officialSourceDocumentIds)).filter(row => comparisonBefore(row.issueDate, input.asOf))
  if (facts.length !== input.queryIds.length || facts.some(row => !comparisonBefore(row.collection.queriedAt, input.asOf)) ||
      batches.length !== input.exportBatchIds.length || documents.length !== input.officialSourceDocumentIds.length) throw new Error('source_set_missing_or_out_of_scope')
  const originals = await readPostgresFingerprintQueries(db, [...new Set(verified.currentScopes.map(proof => proof.queryId))])
  const queries = facts.map(item => ({ ...item.collection, id: item.id, comparisonFacts: item, collectionEvidence: null, rawResponse: null,
    proofSource: () => originals.get(item.id)!.query }))
  const byQuery = new Map(queries.map(query => [query.id, query]))
  const observationIds = await readPostgresComparisonIdentities(db, input.queryIds)
  const normalized = await readPostgresObservationComparisonFacts(db, observationIds.map(row => ({ observationId: row.observationId,
    interface: byQuery.get(row.queryId)!.interface })))
  const relations = observationIds.map(({ enterpriseName: _name, relationId: _id, ...row }) => {
    const projection = normalized.get(row.observationId)
    if (!projection) throw new Error('comparison_observation_fact_missing')
    return { relation: { ...row, ...projection }, query: byQuery.get(row.queryId)! }
  })
  const batchById = new Map(batches.map(row => [row.id, row]))
  const exports = (await readPostgresRosterRowsById(db, schema.platformExportRow, sql`
    FROM platform_export_row p WHERE p.batch_id=ANY(${numbers(input.exportBatchIds)})`))
    .map(row => ({ row: { ...row, rawFields: null }, batch: batchById.get(row.batchId)! }))
  const edgeScope = sql`FROM record_correspondence p LEFT JOIN platform_legacy_relation_alias a ON a.observation_id=p.observation_id
    WHERE (p.observation_id IS NULL OR p.observation_id=ANY(${numbers(observationIds.map(row => row.observationId))}))
      AND (p.export_row_id IS NULL OR p.export_row_id=ANY(${numbers(exports.map(row => row.row.id))}))`
  const allEdges = (await readPostgresCorrespondenceSelection(db, edgeScope)).filter(edge => comparisonBefore(edge.createdAt, input.asOf))
  const audit = input.asOf ? (await db.execute<{ id: number; decidedAt: string }>(sql`
    SELECT correspondence_id::float8 AS id,decided_at AS "decidedAt" FROM record_correspondence_audit
    WHERE correspondence_id=ANY(${numbers(allEdges.map(edge => edge.id))})`)).rows : []
  const revised = new Set(audit.filter(row => !comparisonBefore(row.decidedAt, input.asOf)).map(row => row.id))
  const unavailableEdges = allEdges.filter(edge => input.asOf && (revised.has(edge.id) || edge.decidedAt !== null && !comparisonBefore(edge.decidedAt, input.asOf)))
  const unavailable = new Set(unavailableEdges.map(edge => edge.id))
  const edges = allEdges.filter(edge => !unavailable.has(edge.id))
  const { rows: metadata } = await db.execute<BusinessMetadata>(sql`
    SELECT a.old_id::float8 AS "relationId",o.record_id::float8 AS "recordId",o.version_id::float8 AS "versionId",
      b.interface,b.platform_key AS "platformKey",o.identity_state AS "identityState",o.content_state AS "contentState",
      o.key_source AS "keySource",o.projection_rule_version AS "projectionRuleVersion",v.hash_algorithm AS "hashAlgorithm",v.content_hash AS "contentHash"
    FROM platform_legacy_relation_alias a JOIN platform_business_observation o ON o.id=a.observation_id
    LEFT JOIN platform_business_record b ON b.id=o.record_id LEFT JOIN platform_business_record_version v ON v.id=o.version_id
    WHERE a.old_id=ANY(${numbers(relations.map(row => row.relation.id))})`)
  return { input, queries, batches, documents, relations, exports, edges, unavailableEdges, businessMetadata: new Map(metadata.map(row => [row.relationId,row])) }
}

type FormalStep = Extract<ComparisonRead, { type: 'events' }>
type FormalEvent = ReturnType<typeof import('./record-comparison-formal').iterateComparisonFormalEvents> extends Generator<infer T> ? T : never

async function readFormalEvents(db: Reader, input: RecordComparisonInput, request: FormalStep) {
  const { rows } = await db.execute<FormalEvent>(sql`
    WITH selected_events AS (
      SELECT DISTINCT record_event_id AS id FROM record_evidence WHERE source_file=ANY(${sql.param(request.paths)}::text[])
    ), relevant_records AS (
      SELECT r.id FROM record r WHERE true
        ${input.enterpriseId === undefined ? sql.empty() : sql`AND r.enterprise_id=${input.enterpriseId}`}
        ${input.titleCode === undefined ? sql.empty() : sql`AND r.title_code=${input.titleCode}`}
      UNION SELECT r.id FROM json_array_elements(${JSON.stringify(request.laterOwners)}::json) AS l(target)
      JOIN record r ON r.enterprise_id=(target->>'enterpriseId')::bigint AND r.title_code=target->>'titleCode'
    ) SELECT json_build_object('id',e.id,'recordId',e.record_id,'eventType',e.event_type,'year',e.year,
          'batchSeq',e.batch_seq,'sortKey',e.sort_key,'reviewOutcome',e.review_outcome,'decidedYear',e.decided_year,'revision',e.revision) AS event,
        json_build_object('id',r.id,'enterpriseId',r.enterprise_id,'titleCode',r.title_code,'source',r.source,'usccRaw',r.uscc_raw,'nameRaw',r.name_raw) AS record,
        owner.uscc_norm AS uscc, chosen.id IS NOT NULL AS "inSelectedSource"
    FROM record_event e JOIN record r ON r.id=e.record_id LEFT JOIN enterprise owner ON owner.id=r.enterprise_id
    LEFT JOIN selected_events chosen ON chosen.id=e.id
    WHERE (chosen.id IS NOT NULL OR r.id IN (SELECT id FROM relevant_records)) AND r.source='jxj' AND e.event_type IN ('award','review')
    ORDER BY e.id`)
  return rows
}

async function runComparison(tx: Reader, source: SelectedRecordComparison, verified: VerifiedComparisonEvidence, signal?: AbortSignal, paginate = true) {
  const steps = compareRecordInputs(source, verified, paginate)
  let step = steps.next()
  try {
    while (!step.done) {
      signal?.throwIfAborted()
      const request = step.value
      if (request === undefined) { await setImmediate(); step = steps.next(); continue }
      if (request.type === 'count') {
        const { rows: [counts] } = await tx.execute<{ events: number; enterpriseTitles: number }>(sql`
          SELECT count(*)::float8 AS events,count(DISTINCT r.id)::float8 AS "enterpriseTitles"
          FROM record r JOIN record_event e ON e.record_id=r.id WHERE r.source='jxj' AND e.event_type IN ('award','review')`)
        step = steps.next(counts)
      } else if (request.type === 'events') step = steps.next(await readFormalEvents(tx, source.input, request))
      else {
        const { rows } = await tx.execute<{ evidence: typeof schema.recordEvidence.$inferSelect; registered: StoredFileContentIdentity | null }>(sql`
          SELECT ${postgresRosterRow(schema.recordEvidence,'p')} AS evidence,
            CASE WHEN f.id IS NOT NULL THEN json_build_object('fileId',f.id,'relPath',f.rel_path,'bytes',f.bytes,'sha256',f.sha256) END AS registered
          FROM record_evidence p LEFT JOIN stored_file f ON f.rel_path=p.source_file
          WHERE p.record_event_id=ANY(${numbers(request.ids)}) ORDER BY p.id`)
        step = steps.next(rows)
      }
    }
    signal?.throwIfAborted()
    return step.value
  } finally { steps.return(undefined as never) }
}

export function readPostgresRecordComparison(db: NodePgDatabase, raw: RecordComparisonInput, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const input = validatedComparisonInput(raw)
  return db.transaction(async tx => {
    const verified = await verifiedProofs(tx, input, signal)
    const source = await selectComparison(tx, input, verified)
    return runComparison(tx, source, verified, signal)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function previewPostgresRecordCorrespondenceImpact(db: NodePgDatabase, raw: RecordComparisonInput, signal?: AbortSignal) {
  const input = validatedComparisonInput(raw)
  return db.transaction(async tx => {
    const evidence: VerifiedComparisonEvidence = { officialScopes: [], currentScopes: [] }
    const source = await selectComparison(tx, input, evidence)
    const comparison = await runComparison(tx, source, evidence, signal, false)
    const reasonIds = input.asOf ? (await tx.execute<{ id: number; recordedAt: string }>(sql`
      SELECT id::float8 AS id,recorded_at AS "recordedAt" FROM difference_reason`)).rows
      .filter(row => comparisonBefore(row.recordedAt, input.asOf)).map(row => row.id) : null
    const cutoff = reasonIds ? sql`d.id=ANY(${numbers(reasonIds)})` : sql`true`
    const where = sql`${cutoff}
      ${input.enterpriseId === undefined ? sql.empty() : sql`AND d.enterprise_id=${input.enterpriseId}`}
      ${input.titleCode === undefined ? sql.empty() : sql`AND d.title_code=${input.titleCode}`}`
    const { rows: [counts] } = await tx.execute<{ legacyRows: number; total: number }>(sql`
      SELECT count(*) FILTER (WHERE ${cutoff})::float8 AS "legacyRows",
        count(*) FILTER (WHERE ${where})::float8 AS total FROM difference_reason d`)
    const { rows: pageReasons } = await tx.execute<Parameters<typeof projectLegacyComparisonImpact>[3]['pageReasons'][number]>(sql`
      SELECT d.id::float8 AS id,d.enterprise_id::float8 AS "enterpriseId",d.title_code AS "titleCode",d.direction,
        d.status,d.reason_code AS "reasonCode",d.measure_code AS "measureCode",q.old_id::float8 AS "evidenceQueryId",
        a.old_id::float8 AS "evidenceRelationId",d.verification_status AS "verificationStatus",d.recorded_at AS "recordedAt"
      FROM difference_reason d LEFT JOIN platform_legacy_query_alias q ON q.collection_id=d.evidence_query_id
      LEFT JOIN platform_legacy_relation_alias a ON a.observation_id=d.evidence_relation_id
      WHERE ${where} ORDER BY d.id LIMIT ${input.pageSize} OFFSET ${Math.min(Number.MAX_SAFE_INTEGER, (input.page-1)*input.pageSize)}`)
    const { rows: owners } = await tx.execute<{ id: number; uscc: string | null }>(sql`
      SELECT DISTINCT e.id::float8 AS id,e.uscc_norm AS uscc FROM enterprise e JOIN record r ON r.enterprise_id=e.id
      WHERE r.source='jxj'
      ${input.enterpriseId === undefined ? sql.empty() : sql`AND e.id=${input.enterpriseId}`}
      ${input.titleCode === undefined ? sql.empty() : sql`AND r.title_code=${input.titleCode}`}`)
    return projectLegacyComparisonImpact(source, comparison, new Map(owners.map(row => [row.id, row.uscc])), { ...counts!, pageReasons })
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
