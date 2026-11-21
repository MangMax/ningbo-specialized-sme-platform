import { and, between, count, desc, eq, exists, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { comparisonScopeProof, comparisonScopeProofAudit } from '../../../../db/postgresql/comparison-proof-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { sourceDocument } from '../../../../db/postgresql/official-evidence-tables'
import { platformQueryTitleScope } from '../../../../db/postgresql/platform-archive-tables'
import {
  platformCollectionCondition, platformCollectionPage, platformCollectionUnfinished, platformExportBatch, platformExportRow,
} from '../../../../db/postgresql/platform-tables'
import { rosterFileClassification } from '../../../../db/postgresql/roster-file-tables'
import * as schema from '../../../../db/schema'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import {
  currentProofFingerprint, currentProofInputs, officialProofFingerprint, officialProofReferences,
  ProofSourceError, validateCurrentProofBinding, validateOfficialProofScope, type CurrentEvidence, type OfficialEvidence,
} from './comparison-scope-proof-source'
import { readPostgresFingerprintQuery, readPostgresFingerprintRelations } from './postgres-platform-fingerprint'

type Db = Pick<NodePgDatabase, 'execute' | 'select'>
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
  const f = storedFile, c = rosterFileClassification
  const rows = await db.select({
    file: sql<ProofFile>`json_build_object('id',${f.id},'relPath',${f.relPath},'bytes',${f.bytes},
      'sha256',${f.sha256},'removedAt',${f.removedAt},'source',${c.source})`,
  }).from(f).innerJoin(c, eq(c.fileId, f.id)).where(eq(f.id, sql`ANY(${idArray(ids)})`))
  return rows.map(row => row.file)
}

export async function readPostgresOfficialProofSource(db: Db, evidence: OfficialEvidence) {
  validateOfficialProofScope(evidence)
  const d = alias(sourceDocument, 'd')
  const documents = (await db.select({
    row: sql<typeof schema.sourceDocument.$inferSelect>`${postgresRosterRow(schema.sourceDocument, 'd')}`,
  }).from(d).where(eq(d.id, sql`ANY(${idArray(evidence.sourceDocuments.map(ref => ref.id))})`))
    .orderBy(d.id)).map(({ row }) => row)
  const files = await proofFiles(db, evidence.sourceDocuments.map(ref => ref.fileId))
  const v = alias(recordEvidence, 'p')
  const matchesReference = db.select({ id: v.id }).from(v).where(and(eq(v.sourceFile, d.path),
    sql`(ref#>>'{reference,page}' IS NULL OR ${v.page}=(ref#>>'{reference,page}')::bigint)`,
    sql`(ref#>>'{reference,listNo}' IS NULL OR ${v.listNo}=(ref#>>'{reference,listNo}')::bigint)`,
    sql`(ref#>>'{reference,attachment}' IS NULL OR ${v.attachment}=ref#>>'{reference,attachment}')`))
  const matched = await db.select({ id: d.id })
    .from(sql`json_array_elements(${JSON.stringify(evidence.sourceDocuments)}::json) ref`)
    .innerJoin(d, eq(d.id, sql`(ref->>'id')::bigint`)).where(exists(matchesReference))
  const coordinates = new Set(matched.map(row => row.id))
  const refs = officialProofReferences(evidence, documents, files, ref => coordinates.has(ref.id))
  const r = alias(record, 'r'), e = alias(recordEvent, 'e')
  const recordScope = and(eq(r.source, 'jxj'), eq(r.titleCode, evidence.titleCode),
    evidence.enterpriseIds === null ? undefined : eq(r.enterpriseId, sql`ANY(${idArray(evidence.enterpriseIds)})`))
  const eventScope = or(between(e.year, evidence.fromYear, evidence.throughYear), between(e.decidedYear, evidence.fromYear, evidence.throughYear))
  const records = (await db.select({
    row: sql<typeof schema.record.$inferSelect>`${postgresRosterRow(schema.record, 'r')}`,
  }).from(r).where(recordScope).orderBy(r.id)).map(({ row }) => row)
  const events = (await db.select({
    row: sql<typeof schema.recordEvent.$inferSelect>`${postgresRosterRow(schema.recordEvent, 'e')}`,
  }).from(e).innerJoin(r, eq(r.id, e.recordId)).where(and(recordScope, eventScope)).orderBy(e.id)).map(({ row }) => row)
  const eventEvidence = (await db.select({
    row: sql<typeof schema.recordEvidence.$inferSelect>`${postgresRosterRow(schema.recordEvidence, 'p')}`,
  }).from(v).innerJoin(e, eq(e.id, v.recordEventId)).innerJoin(r, eq(r.id, e.recordId))
    .where(and(recordScope, eventScope)).orderBy(v.id)).map(({ row }) => row)
  return officialProofFingerprint(evidence, refs, records, events, eventEvidence)
}

export async function readPostgresCurrentProofSource(db: Db, evidence: CurrentEvidence) {
  const target = await readPostgresFingerprintQuery(db, evidence.queryId)
  const b = alias(platformExportBatch, 'p')
  const [entry] = await db.select({
    row: sql<typeof schema.platformExportBatch.$inferSelect>`${postgresRosterRow(schema.platformExportBatch, 'p')}`,
  }).from(b).where(eq(b.id, evidence.exportBatchId))
  const batch = entry?.row
  const id = target?.collection.id
  let context: Parameters<typeof currentProofInputs>[1]
  if (target && id !== undefined) {
    type Context = NonNullable<typeof context>
    const c = platformCollectionCondition, scope = platformQueryTitleScope
    const page = platformCollectionPage, u = platformCollectionUnfinished
    const conditions = await db.select({ name: c.name, valueKind: c.valueKind, textValue: c.textValue, integerValue: c.integerValue })
      .from(c).where(eq(c.collectionId, id))
    const scopes = await db.select({ rdjb: scope.rdjb }).from(scope).where(eq(scope.collectionId, id))
    const pages = await db.select({ rdjb: page.rdjb, pageNo: page.pageNo, status: page.status,
      maxPage: page.maxPage, declaredTotal: page.declaredTotal, fetchedCount: page.fetchedCount,
    }).from(page).where(eq(page.collectionId, id)).orderBy(page.ordinal)
    const unfinished = await db.select({ ordinal: u.ordinal }).from(u).where(eq(u.collectionId, id))
    context = { ...target, conditions, scopes, pages, unfinished } as Context
  }
  const inputs = currentProofInputs(evidence, context, batch)
  const [file] = await proofFiles(db, [evidence.scope.freezeFileId])
  const freeze = validateCurrentProofBinding(evidence, inputs, file)
  const queryRows = await readPostgresFingerprintRelations(db, evidence.queryId)
  const r = alias(platformExportRow, 'p')
  const exportRows = (await db.select({
    row: sql<typeof schema.platformExportRow.$inferSelect>`${postgresRosterRow(schema.platformExportRow, 'p')}`,
  }).from(r).where(eq(r.batchId, inputs.batch.id)).orderBy(r.id)).map(({ row }) => row)
  return currentProofFingerprint(evidence, inputs.target.query, inputs.batch, freeze, queryRows, exportRows)
}

const p = alias(comparisonScopeProof, 'p')
const proofSelection = {
  proof: sql<Proof>`${postgresRosterRow(schema.comparisonScopeProof, 'p')}`,
}
function latestProofAudit(db: Db) {
  const a = comparisonScopeProofAudit
  return db.select({ id: a.id, status: a.toStatus, revision: a.resultingRevision, decidedAt: a.decidedAt })
    .from(a).where(eq(a.proofId, p.id)).orderBy(desc(a.id)).limit(1).as('a')
}

function proofState(a: ReturnType<typeof latestProofAudit>) {
  return sql<State | null>`CASE WHEN ${a.id} IS NOT NULL THEN json_build_object(
    'status',${a.status},'revision',${a.revision},'decidedAt',${a.decidedAt}) END`
}

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
  const a = latestProofAudit(db)
  const [row] = await db.select({ ...proofSelection, state: proofState(a) })
    .from(p).leftJoinLateral(a, sql`true`).where(eq(p.id, id))
  return row ?? null
}

export async function readPostgresComparisonProof(db: Db, id: number) {
  const row = await readPostgresComparisonProofHead(db, id)
  return row ? observeProof(db, row) : null
}

export async function pagePostgresComparisonProofs(db: Db, args: { kind?: Proof['kind']; status?: State['status']; page: number; pageSize: number }) {
  const a = latestProofAudit(db)
  const where = and(args.kind === undefined ? undefined : eq(p.kind, args.kind),
    args.status === undefined ? undefined : eq(sql<string>`coalesce(${a.status},'candidate')`, args.status))
  const [total] = await db.select({ n: count() }).from(p).leftJoinLateral(a, sql`true`).where(where)
  const rows = await db.select({ ...proofSelection, state: proofState(a) }).from(p).leftJoinLateral(a, sql`true`)
    .where(where).orderBy(p.id).limit(args.pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER, (args.page - 1) * args.pageSize))
  const results = []
  for (const row of rows) results.push(await observeProof(db, row))
  return { rows: results, total: total!.n, page: args.page, pageSize: args.pageSize }
}

export async function readPostgresCurrentProofCoverage(db: Db, references: readonly { ids: number[]; queryId: number; batchId: number }[]) {
  const keys = new Set(references.flatMap(reference => reference.ids.map(id => `${id}:${reference.queryId}:${reference.batchId}`)))
  const ids = [...new Set(references.flatMap(reference => reference.ids))]
  const valid = new Set<string>()
  if (ids.length) {
    const a = latestProofAudit(db)
    const rows = await db.select({ ...proofSelection, state: proofState(a) }).from(p).leftJoinLateral(a, sql`true`)
      .where(and(eq(p.id, sql`ANY(${idArray(ids)})`), eq(p.kind, 'current_source_equivalence'), eq(a.status, 'confirmed')))
    for (const row of rows) {
      const evidence = row.proof.evidence as CurrentEvidence
      const key = `${row.proof.id}:${evidence.queryId}:${evidence.exportBatchId}`
      if (keys.has(key) && (await observeProof(db, row)).valid) valid.add(key)
    }
  }
  return (reference: typeof references[number]) =>
    reference.ids.some(id => valid.has(`${id}:${reference.queryId}:${reference.batchId}`))
}
