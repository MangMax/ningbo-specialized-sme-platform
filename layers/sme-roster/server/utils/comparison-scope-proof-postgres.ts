import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import {
  currentProofFingerprint, currentProofInputs, officialProofFingerprint, officialProofReferences,
  ProofSourceError, validateCurrentProofBinding, validateOfficialProofScope, type CurrentEvidence, type OfficialEvidence,
} from './comparison-scope-proof-source'
import { readPostgresFingerprintQuery, readPostgresFingerprintRelations } from './postgres-platform-fingerprint'

type Db = Pick<NodePgDatabase, 'execute'>
type Proof = typeof schema.comparisonScopeProof.$inferSelect
type ProofFile = Parameters<typeof officialProofReferences>[2][number]
type State = {
  status: typeof schema.comparisonScopeProofAudit.$inferSelect.toStatus
  revision: number
  decidedAt: string
}
type Stored = { proof: Proof; state: State | null }
const idArray = (ids: readonly number[]) => sql`${sql.param(ids)}::bigint[]`

async function proofFiles(db: Db, ids: number[]) {
  const { rows } = await db.execute<{ file: ProofFile }>(sql`
    SELECT json_build_object('id',f.id,'relPath',f.rel_path,'bytes',f.bytes,
      'sha256',f.sha256,'removedAt',f.removed_at,'source',c.source) AS file
    FROM stored_file f JOIN roster_file_classification c ON c.file_id=f.id
    WHERE f.id=ANY(${idArray(ids)})`)
  return rows.map(row => row.file)
}

export async function readPostgresOfficialProofSource(db: Db, evidence: OfficialEvidence) {
  validateOfficialProofScope(evidence)
  const documents = await readPostgresRosterRowsById(db, schema.sourceDocument,
    sql`FROM source_document p WHERE p.id=ANY(${idArray(evidence.sourceDocuments.map(ref => ref.id))})`)
  const files = await proofFiles(db, evidence.sourceDocuments.map(ref => ref.fileId))
  const { rows: matched } = await db.execute<{ id: number }>(sql`
    SELECT d.id::float8 AS id FROM json_array_elements(${JSON.stringify(evidence.sourceDocuments)}::json) ref
    JOIN source_document d ON d.id=(ref->>'id')::bigint
    WHERE EXISTS (
      SELECT 1 FROM record_evidence v WHERE v.source_file=d.path
        AND (ref#>>'{reference,page}' IS NULL OR v.page=(ref#>>'{reference,page}')::bigint)
        AND (ref#>>'{reference,listNo}' IS NULL OR v.list_no=(ref#>>'{reference,listNo}')::bigint)
        AND (ref#>>'{reference,attachment}' IS NULL OR v.attachment=ref#>>'{reference,attachment}'))`)
  const coordinates = new Set(matched.map(row => row.id))
  const refs = officialProofReferences(evidence, documents, files, ref => coordinates.has(ref.id))
  const recordScope = sql`r.source='jxj' AND r.title_code=${evidence.titleCode}
    ${evidence.enterpriseIds === null ? sql.empty() : sql`AND r.enterprise_id=ANY(${idArray(evidence.enterpriseIds)})`}`
  const eventScope = sql`(e.year BETWEEN ${evidence.fromYear} AND ${evidence.throughYear}
    OR e.decided_year BETWEEN ${evidence.fromYear} AND ${evidence.throughYear})`
  const records = await readPostgresRosterRowsById(db, schema.record, sql`FROM (SELECT r.* FROM record r WHERE ${recordScope}) p`)
  const events = await readPostgresRosterRowsById(db, schema.recordEvent, sql`
    FROM (SELECT e.* FROM record_event e JOIN record r ON r.id=e.record_id WHERE ${recordScope} AND ${eventScope}) p`)
  const eventEvidence = await readPostgresRosterRowsById(db, schema.recordEvidence, sql`
    FROM record_evidence p JOIN record_event e ON e.id=p.record_event_id JOIN record r ON r.id=e.record_id
    WHERE ${recordScope} AND ${eventScope}`)
  return officialProofFingerprint(evidence, refs, records, events, eventEvidence)
}

export async function readPostgresCurrentProofSource(db: Db, evidence: CurrentEvidence) {
  const target = await readPostgresFingerprintQuery(db, evidence.queryId)
  const [batch] = await readPostgresRosterRowsById(db, schema.platformExportBatch, sql`
    FROM platform_export_batch p WHERE p.id=${evidence.exportBatchId}`)
  const id = target?.collection.id
  let context: Parameters<typeof currentProofInputs>[1]
  if (target && id !== undefined) {
    type Context = NonNullable<typeof context>
    const conditions = await db.execute<Context['conditions'][number]>(sql`
      SELECT name,value_kind AS "valueKind",text_value AS "textValue",integer_value::float8 AS "integerValue"
      FROM platform_collection_condition WHERE collection_id=${id}`)
    const scopes = await db.execute<Context['scopes'][number]>(sql`
      SELECT rdjb FROM platform_query_title_scope WHERE collection_id=${id}`)
    const pages = await db.execute<Context['pages'][number]>(sql`
      SELECT rdjb,page_no::float8 AS "pageNo",status,max_page::float8 AS "maxPage",
        declared_total::float8 AS "declaredTotal",fetched_count::float8 AS "fetchedCount"
      FROM platform_collection_page WHERE collection_id=${id} ORDER BY ordinal`)
    const unfinished = await db.execute<Context['unfinished'][number]>(sql`
      SELECT ordinal::float8 AS ordinal FROM platform_collection_unfinished WHERE collection_id=${id}`)
    context = { ...target, conditions: conditions.rows, scopes: scopes.rows, pages: pages.rows, unfinished: unfinished.rows }
  }
  const inputs = currentProofInputs(evidence, context, batch)
  const [file] = await proofFiles(db, [evidence.scope.freezeFileId])
  const freeze = validateCurrentProofBinding(evidence, inputs, file)
  const queryRows = await readPostgresFingerprintRelations(db, evidence.queryId)
  const exportRows = await readPostgresRosterRowsById(db, schema.platformExportRow,
    sql`FROM platform_export_row p WHERE p.batch_id=${inputs.batch.id}`)
  return currentProofFingerprint(evidence, inputs.target.query, inputs.batch, freeze, queryRows, exportRows)
}

const proofStateJoin = sql`
  FROM comparison_scope_proof p
  LEFT JOIN LATERAL (
    SELECT id,to_status,resulting_revision,decided_at FROM comparison_scope_proof_audit
    WHERE proof_id=p.id ORDER BY id DESC LIMIT 1
  ) a ON true`
const proofSelection = sql`SELECT ${postgresRosterRow(schema.comparisonScopeProof, 'p')} AS proof,
  CASE WHEN a.id IS NOT NULL THEN json_build_object('status',a.to_status,'revision',a.resulting_revision,'decidedAt',a.decided_at) END AS state`

async function observeProof(db: Db, { proof, state }: Stored) {
  let observed: Awaited<ReturnType<typeof readPostgresOfficialProofSource | typeof readPostgresCurrentProofSource>> | undefined
  try {
    observed = proof.kind === 'official_coverage'
      ? await readPostgresOfficialProofSource(db, proof.evidence as OfficialEvidence)
      : await readPostgresCurrentProofSource(db, proof.evidence as CurrentEvidence)
  } catch (error) {
    if (!(error instanceof ProofSourceError)) throw error
  }
  const current = observed?.sourceFingerprint === proof.sourceFingerprint
  return {
    ...proof, sourceSummary: observed?.sourceSummary ?? null, status: state?.status ?? 'candidate',
    revision: state?.revision ?? 0, decidedAt: state?.decidedAt ?? null,
    valid: state?.status === 'confirmed' && current,
    invalidReason: current ? null : 'source_drift_or_missing',
  }
}

export async function readPostgresComparisonProofHead(db: Db, id: number) {
  const { rows: [row] } = await db.execute<Stored>(sql`${proofSelection} ${proofStateJoin} WHERE p.id=${id}`)
  return row ?? null
}

export async function readPostgresComparisonProof(db: Db, id: number) {
  const row = await readPostgresComparisonProofHead(db, id)
  return row ? observeProof(db, row) : null
}

export async function pagePostgresComparisonProofs(db: Db, args: { kind?: Proof['kind']; status?: State['status']; page: number; pageSize: number }) {
  const where = sql`WHERE true
    ${args.kind === undefined ? sql.empty() : sql`AND p.kind=${args.kind}`}
    ${args.status === undefined ? sql.empty() : sql`AND coalesce(a.to_status, 'candidate')=${args.status}`}`
  const { rows: [total] } = await db.execute<{ n: string }>(sql`SELECT count(*) AS n ${proofStateJoin} ${where}`)
  const { rows } = await db.execute<Stored>(sql`
    ${proofSelection} ${proofStateJoin} ${where} ORDER BY p.id LIMIT ${args.pageSize}
    OFFSET ${Math.min(Number.MAX_SAFE_INTEGER, (args.page - 1) * args.pageSize)}`)
  const results = []
  for (const row of rows) results.push(await observeProof(db, row))
  return { rows: results, total: Number(total!.n), page: args.page, pageSize: args.pageSize }
}

export async function readPostgresCurrentProofCoverage(db: Db, references: readonly { ids: number[]; queryId: number; batchId: number }[]) {
  const keys = new Set(references.flatMap(reference => reference.ids.map(id => `${id}:${reference.queryId}:${reference.batchId}`)))
  const ids = [...new Set(references.flatMap(reference => reference.ids))]
  const valid = new Set<string>()
  if (ids.length) {
    const { rows } = await db.execute<Stored>(sql`
      ${proofSelection} ${proofStateJoin}
      WHERE p.id=ANY(${idArray(ids)}) AND p.kind='current_source_equivalence' AND a.to_status='confirmed'`)
    for (const row of rows) {
      const evidence = row.proof.evidence as CurrentEvidence
      const key = `${row.proof.id}:${evidence.queryId}:${evidence.exportBatchId}`
      if (keys.has(key) && (await observeProof(db, row)).valid) valid.add(key)
    }
  }
  return (reference: typeof references[number]) =>
    reference.ids.some(id => valid.has(`${id}:${reference.queryId}:${reference.batchId}`))
}
