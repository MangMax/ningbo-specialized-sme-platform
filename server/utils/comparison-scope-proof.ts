import { correspondenceTarget } from './record-correspondence-store'
import { correspondenceRelationQueryId } from './record-correspondence-target-sources'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '../../db/schema'
import { ensureBatchRow, findBatchByKey } from './roster-batch-ledger'
import { currentSource, officialSource, fingerprint, ProofSourceError, type CurrentEvidence, type OfficialEvidence, type ProofExecutor } from './comparison-scope-proof-source'

type Db = BetterSQLite3Database<typeof schema>
const positive = z.number().int().positive()
const filled = z.string().trim().min(1)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const coordinate = z.strictObject({ field: z.enum(['source_document.path', 'record_evidence.source_file']), page: positive.optional(), attachment: filled.optional(), listNo: positive.optional() })
const official = z.strictObject({ titleCode: filled, fromYear: z.number().int().min(1900).max(3000), throughYear: z.number().int().min(1900).max(3000), enterpriseIds: z.array(positive).min(1).nullable(), fullRange: z.literal(true), sourceDocuments: z.array(z.strictObject({ id: positive, fileId: positive, sha256, reference: coordinate })).min(1) })
const current = z.strictObject({ queryId: positive, exportBatchId: positive, titleCode: filled, queryReference: z.literal('platform_query.collectionEvidence'), exportReference: z.literal('platform_export_batch.sha256'), scope: z.strictObject({ queryAccount: filled, exportAccount: filled, queryRegion: filled, exportRegion: filled, queryFilters: z.record(z.string(), z.unknown()), exportFilters: z.record(z.string(), z.unknown()), windowStart: z.iso.datetime({ offset: true }), windowEnd: z.iso.datetime({ offset: true }), platformVersion: filled, freezeReference: filled, freezeFileId: positive, freezeSha256: sha256 }) })
export const proofOperation = z.union([
  z.strictObject({ action: z.literal('create'), kind: z.literal('official_coverage'), status: z.enum(['candidate', 'confirmed']), evidence: official }),
  z.strictObject({ action: z.literal('create'), kind: z.literal('current_source_equivalence'), status: z.enum(['candidate', 'confirmed']), evidence: current }),
  z.strictObject({ action: z.literal('decide'), proofId: positive, expectedRevision: positive, status: z.enum(['confirmed', 'revoked']) }),
])
export const proofRequest = z.strictObject({ idempotencyKey: filled, sourceIdentity: filled, actor: z.strictObject({ type: z.enum(['user', 'agent']), id: filled }), basis: filled, ruleId: filled, ruleVersion: filled, operations: z.array(proofOperation).min(1).max(100) })
export type ProofRequest = z.infer<typeof proofRequest>
export type ProofStatus = 'candidate' | 'confirmed' | 'revoked'
export class ProofError extends Error {
  constructor(readonly code: 'plan_mismatch' | 'idempotency_conflict' | 'stale_revision' | 'invalid_transition' | 'not_found', message: string) { super(message) }
  get status() { return ['plan_mismatch', 'idempotency_conflict', 'stale_revision'].includes(this.code) ? 409 : this.code === 'not_found' ? 404 : 422 }
}
function fail(code: ProofError['code'], message: string): never { throw new ProofError(code, message) }
const source = (db: ProofExecutor, kind: 'official_coverage' | 'current_source_equivalence', evidence: OfficialEvidence | CurrentEvidence) => kind === 'official_coverage' ? officialSource(db, evidence as OfficialEvidence) : currentSource(db, evidence as CurrentEvidence)
const requestHash = (request: ProofRequest) => fingerprint(request)

function auditRows(db: ProofExecutor, proofId: number) {
  return db.select().from(schema.comparisonScopeProofAudit).where(eq(schema.comparisonScopeProofAudit.proofId, proofId)).orderBy(schema.comparisonScopeProofAudit.id).all()
}
function state(db: ProofExecutor, proofId: number) {
  const latest = auditRows(db, proofId).at(-1)
  return latest ? { status: latest.toStatus, revision: latest.resultingRevision, decidedAt: latest.decidedAt } : null
}
function plan(db: ProofExecutor, request: ProofRequest) {
  const touched = new Set<number>()
  const targets: unknown[] = []
  let audit = 0
  for (const op of request.operations) {
    if (op.action === 'create') {
      const observed = source(db, op.kind, op.evidence)
      targets.push({ kind: op.kind, evidenceHash: fingerprint(op.evidence), sourceFingerprint: observed.sourceFingerprint, status: op.status })
      audit += op.status === 'confirmed' ? 2 : 1
    } else {
      if (touched.has(op.proofId)) fail('invalid_transition', 'One request may decide each proof only once')
      touched.add(op.proofId)
      const row = db.select().from(schema.comparisonScopeProof).where(eq(schema.comparisonScopeProof.id, op.proofId)).get()
      if (!row) fail('not_found', 'Proof not found')
      const old = state(db, op.proofId)
      if (!old || old.revision !== op.expectedRevision) fail('stale_revision', 'Proof revision changed')
      if (!(old.status === 'candidate' && ['confirmed', 'revoked'].includes(op.status)) && !(old.status === 'confirmed' && op.status === 'revoked')) fail('invalid_transition', 'Invalid proof transition')
      let observedFingerprint: string | null = null
      try { observedFingerprint = source(db, row.kind, row.evidence as OfficialEvidence | CurrentEvidence).sourceFingerprint }
      catch (error) { if (!(error instanceof ProofSourceError) || op.status !== 'revoked') throw error }
      if (op.status === 'confirmed' && observedFingerprint !== row.sourceFingerprint) fail('plan_mismatch', 'Archived source drifted before confirmation')
      targets.push({ proofId: row.id, revision: old.revision, fromStatus: old.status, sourceFingerprint: row.sourceFingerprint, observedFingerprint, status: op.status })
      audit++
    }
  }
  const impact = { created: request.operations.filter(op => op.action === 'create').length, audit }
  return { requestHash: requestHash(request), targets, impact, planHash: fingerprint({ requestHash: requestHash(request), targets, impact }) }
}

export function preflightComparisonScopeProofs(db: Db, request: ProofRequest) {
  const parsed = proofRequest.parse(request)
  const old = findBatchByKey(db, parsed.idempotencyKey)
  if (old && (old.sourceKind !== 'comparison_scope_proof' || old.sourceIdentity !== parsed.sourceIdentity)) fail('idempotency_conflict', 'Idempotency key belongs to another source')
  const prior = old?.preflightResult as ReturnType<typeof plan> | null
  if (prior && prior.requestHash !== requestHash(parsed)) fail('idempotency_conflict', 'Idempotency key belongs to a different request')
  if (old?.status === 'committed' && prior) return { batchId: old.id, batchStatus: 'committed' as const, ...prior }
  const next = plan(db, parsed)
  const batch = ensureBatchRow(db, { idempotencyKey: parsed.idempotencyKey, sourceKind: 'comparison_scope_proof', sourceIdentity: parsed.sourceIdentity })
  db.update(schema.importBatch).set({ preflightResult: next, error: null }).where(and(eq(schema.importBatch.id, batch.id), eq(schema.importBatch.status, 'preflight'))).run()
  return { batchId: batch.id, batchStatus: 'preflight' as const, ...next }
}

function appendAudit(db: ProofExecutor, proofId: number, batchId: number, request: ProofRequest, fromStatus: ProofStatus | null, toStatus: ProofStatus, expectedRevision: number, at: string) {
  db.insert(schema.comparisonScopeProofAudit).values({ proofId, batchId, idempotencyKey: request.idempotencyKey, fromStatus, toStatus, expectedRevision, resultingRevision: expectedRevision + 1, actorType: request.actor.type, actorId: request.actor.id, basis: request.basis, ruleId: request.ruleId, ruleVersion: request.ruleVersion, decidedAt: at }).run()
}

export function commitComparisonScopeProofs(db: Db, request: ProofRequest, planHash: string) {
  const parsed = proofRequest.parse(request)
  const batch = findBatchByKey(db, parsed.idempotencyKey)
  if (!batch) fail('plan_mismatch', 'Preflight batch not found')
  if (batch.sourceKind !== 'comparison_scope_proof' || batch.sourceIdentity !== parsed.sourceIdentity) fail('idempotency_conflict', 'Idempotency key belongs to another source')
  const previous = batch.preflightResult as ReturnType<typeof plan> | null
  if (!previous || previous.requestHash !== requestHash(parsed)) fail('idempotency_conflict', 'Request differs from preflight')
  if (previous.planHash !== planHash) fail('plan_mismatch', 'Submitted plan hash differs')
  if (batch.status === 'committed') return batch.summary as { batchId: number; planHash: string; impact: { created: number; audit: number }; proofIds: number[] }
  return db.transaction(tx => {
    const next = plan(tx, parsed)
    if (next.planHash !== planHash) fail('plan_mismatch', 'Archived sources or proof revisions changed')
    const at = new Date().toISOString()
    const proofIds: number[] = []
    for (const op of parsed.operations) {
      if (op.action === 'create') {
        const observed = source(tx, op.kind, op.evidence)
        const row = tx.insert(schema.comparisonScopeProof).values({ kind: op.kind, evidence: op.evidence, sourceFingerprint: observed.sourceFingerprint, createdAt: at }).returning().get()
        appendAudit(tx, row.id, batch.id, parsed, null, 'candidate', 0, at)
        if (op.status === 'confirmed') appendAudit(tx, row.id, batch.id, parsed, 'candidate', 'confirmed', 1, at)
        proofIds.push(row.id)
      } else {
        const old = state(tx, op.proofId)!
        appendAudit(tx, op.proofId, batch.id, parsed, old.status, op.status, old.revision, at)
        proofIds.push(op.proofId)
      }
    }
    const receipt = { batchId: batch.id, planHash, impact: next.impact, proofIds }
    tx.update(schema.importBatch).set({ status: 'committed', summary: receipt, itemResults: proofIds, committedAt: at, error: null }).where(eq(schema.importBatch.id, batch.id)).run()
    return receipt
  })
}

function observeComparisonScopeProof(db: ProofExecutor, proofId: number, selected?: { queryIds: number[]; exportBatchIds: number[]; officialSourceDocumentIds: number[]; asOf?: string }) {
  const row = db.select().from(schema.comparisonScopeProof).where(eq(schema.comparisonScopeProof.id, proofId)).get()
  if (!row) return null
  const last = state(db, proofId)
  // A non-qualifying or unselected proof must not cause another archive to load.
  if (selected) {
    if (last?.status !== 'confirmed' || selected.asOf && last.decidedAt && Date.parse(last.decidedAt) > Date.parse(selected.asOf)) return null
    if (row.kind === 'official_coverage') {
      if (!(row.evidence as OfficialEvidence).sourceDocuments.every(ref => selected.officialSourceDocumentIds.includes(ref.id))) return null
    } else {
      const evidence = row.evidence as CurrentEvidence
      if (!selected.queryIds.includes(evidence.queryId) || !selected.exportBatchIds.includes(evidence.exportBatchId)) return null
    }
  }
  let observed: ReturnType<typeof source> | null = null
  try { observed = source(db, row.kind, row.evidence as OfficialEvidence | CurrentEvidence) } catch (error) { if (!(error instanceof ProofSourceError)) throw error }
  const valid = last?.status === 'confirmed' && observed?.sourceFingerprint === row.sourceFingerprint
  return { observed, row: { id: row.id, kind: row.kind, evidence: row.evidence, sourceFingerprint: row.sourceFingerprint, sourceSummary: observed?.sourceSummary ?? null, createdAt: row.createdAt, status: last?.status ?? 'candidate', revision: last?.revision ?? 0, decidedAt: last?.decidedAt ?? null, valid: Boolean(valid), invalidReason: !observed || observed.sourceFingerprint !== row.sourceFingerprint ? 'source_drift_or_missing' : null } }
}
export function readComparisonScopeProof(db: ProofExecutor, proofId: number) {
  return observeComparisonScopeProof(db, proofId)?.row ?? null
}
export function listComparisonScopeProofs(db: ProofExecutor, filter: { kind?: 'official_coverage' | 'current_source_equivalence'; status?: ProofStatus } = {}) {
  return db.select().from(schema.comparisonScopeProof).all().filter(row => !filter.kind || row.kind === filter.kind).map(row => readComparisonScopeProof(db, row.id)!).filter(row => !filter.status || row.status === filter.status)
}
export const readComparisonScopeProofAudit = (db: ProofExecutor, proofId: number) => auditRows(db, proofId)
export function readComparisonScopeProofBatch(db: Db, key: string) {
  const batch = findBatchByKey(db, key)
  return batch?.sourceKind === 'comparison_scope_proof' && batch.status === 'committed' ? batch.summary : null
}

/** Only stored, confirmed and source-current rows may reach VerifiedComparisonEvidence. */
export function resolveVerifiedComparisonEvidence(db: ProofExecutor, proofIds: number[], selected?: { queryIds: number[]; exportBatchIds: number[]; officialSourceDocumentIds: number[]; asOf?: string }) {
  const officialScopes: Array<{ proofId: string; sourceDocumentIds: number[]; titleCode: string; fromYear: number; throughYear: number; enterpriseIds: number[] | null; verifiedAt: string }> = []
  const currentScopes: Array<{ proofId: string; queryId: number; exportBatchId: number; titleCode: string; querySourceFingerprint: string; exportSha256: string; scopeEquivalent: true; versionEquivalent: true; verifiedAt: string }> = []
  for (const id of [...new Set(proofIds)]) {
    const observation = observeComparisonScopeProof(db, id, selected)
    const row = observation?.row
    if (!row || !row.valid || row.status !== 'confirmed' || selected?.asOf && row.decidedAt && Date.parse(row.decidedAt) > Date.parse(selected.asOf)) continue
    if (row.kind === 'official_coverage') {
      const evidence = row.evidence as OfficialEvidence
      if (selected && !evidence.sourceDocuments.every(ref => selected.officialSourceDocumentIds.includes(ref.id))) continue
      officialScopes.push({ proofId: String(id), sourceDocumentIds: evidence.sourceDocuments.map(ref => ref.id), titleCode: evidence.titleCode, fromYear: evidence.fromYear, throughYear: evidence.throughYear, enterpriseIds: evidence.enterpriseIds, verifiedAt: row.decidedAt! })
    } else {
      const evidence = row.evidence as CurrentEvidence
      if (selected && (!selected.queryIds.includes(evidence.queryId) || !selected.exportBatchIds.includes(evidence.exportBatchId))) continue
      const observed = observation?.observed
      if (!observed || !('querySourceFingerprint' in observed)) continue
      currentScopes.push({ proofId: String(id), queryId: evidence.queryId, exportBatchId: evidence.exportBatchId, titleCode: evidence.titleCode, querySourceFingerprint: observed.querySourceFingerprint, exportSha256: observed.exportSha256, scopeEquivalent: true, versionEquivalent: true, verifiedAt: row.decidedAt! })
    }
  }
  return { officialScopes, currentScopes }
}

/** Only these proofs can establish equivalence for the two endpoints. Selecting
 * IDs first keeps unrelated official archives out of current-row validation. */
export function currentRowProofIds(db: ProofExecutor, proofIds: number[], relationId: number, exportRowId: number): number[] {
  if (!proofIds.length) return []
  const p = schema.comparisonScopeProof
  return db.select({ id:p.id }).from(p).where(and(
    inArray(p.id,proofIds), eq(p.kind,'current_source_equivalence'),
    correspondenceTarget(db) ? sql`json_extract(${p.evidence}, '$.queryId') = ${correspondenceRelationQueryId(db, relationId) ?? null}` : sql`json_extract(${p.evidence}, '$.queryId') = (select ${schema.platformRelation.queryId} from ${schema.platformRelation} where ${schema.platformRelation.id} = ${relationId})`,
    sql`json_extract(${p.evidence}, '$.exportBatchId') = (select ${schema.platformExportRow.batchId} from ${schema.platformExportRow} where ${schema.platformExportRow.id} = ${exportRowId})`,
  )).all().map(row => row.id)
}

export function currentProofCoversRows(db: ProofExecutor, proofIds: number[], relationId: number, exportRowId: number) {
  const relation = correspondenceTarget(db) ? (() => { const queryId = correspondenceRelationQueryId(db, relationId); return queryId === undefined ? undefined : { queryId } })() : db.select().from(schema.platformRelation).where(eq(schema.platformRelation.id, relationId)).get()
  const exportRow = db.select().from(schema.platformExportRow).where(eq(schema.platformExportRow.id, exportRowId)).get()
  if (!relation || !exportRow) return false
  return resolveVerifiedComparisonEvidence(db, currentRowProofIds(db,proofIds,relationId,exportRowId)).currentScopes.some(proof => proof.queryId === relation.queryId && proof.exportBatchId === exportRow.batchId)
}
