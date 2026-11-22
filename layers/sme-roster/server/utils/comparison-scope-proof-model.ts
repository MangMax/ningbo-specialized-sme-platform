import { z } from 'zod'
import type * as schema from '../../../../db/schema'
import { type CurrentEvidence, type OfficialEvidence } from './comparison-scope-proof-source-projection'
import { fingerprint } from './comparison-scope-proof-source-model'
import type { state } from './comparison-scope-proof'

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

export function fail(code: ProofError['code'], message: string): never { throw new ProofError(code, message) }

export const requestHash = (request: ProofRequest) => fingerprint(request)

type ProofRow = typeof schema.comparisonScopeProof.$inferSelect

type ProofHead = { proof: ProofRow; state: ReturnType<typeof state> }

export type ProofSourceRead = { type: 'source'; kind: ProofRow['kind']; evidence: OfficialEvidence | CurrentEvidence; canBeMissing: boolean }

type ProofPlanRead = { type: 'head'; proofId: number } | ProofSourceRead

type ProofPlanTarget = { kind: ProofRow['kind']; evidenceHash: string; sourceFingerprint: string; status: 'candidate' | 'confirmed' }
  | { proofId: number; revision: number; fromStatus: ProofStatus; sourceFingerprint: string; observedFingerprint: string | null; status: 'confirmed' | 'revoked' }

export type ComparisonProofPlan = {
  requestHash: string
  targets: ProofPlanTarget[]
  impact: { created: number; audit: number }
  planHash: string
}

export function* comparisonProofPlanSteps(request: ProofRequest): Generator<ProofPlanRead, ComparisonProofPlan, ProofHead | string | null> {
  const touched = new Set<number>()
  const targets: ProofPlanTarget[] = []
  let audit = 0
  for (const op of request.operations) {
    if (op.action === 'create') {
      const sourceFingerprint = (yield { type: 'source', kind: op.kind, evidence: op.evidence, canBeMissing: false }) as string
      targets.push({ kind: op.kind, evidenceHash: fingerprint(op.evidence), sourceFingerprint, status: op.status })
      audit += op.status === 'confirmed' ? 2 : 1
    } else {
      if (touched.has(op.proofId)) fail('invalid_transition', 'One request may decide each proof only once')
      touched.add(op.proofId)
      const head = (yield { type: 'head', proofId: op.proofId }) as ProofHead | null
      if (!head) fail('not_found', 'Proof not found')
      const { proof: row, state: old } = head
      if (!old || old.revision !== op.expectedRevision) fail('stale_revision', 'Proof revision changed')
      if (!(old.status === 'candidate' && ['confirmed', 'revoked'].includes(op.status)) && !(old.status === 'confirmed' && op.status === 'revoked')) fail('invalid_transition', 'Invalid proof transition')
      const observedFingerprint = (yield { type: 'source', kind: row.kind, evidence: row.evidence as OfficialEvidence | CurrentEvidence, canBeMissing: op.status === 'revoked' }) as string | null
      if (op.status === 'confirmed' && observedFingerprint !== row.sourceFingerprint) fail('plan_mismatch', 'Archived source drifted before confirmation')
      targets.push({ proofId: row.id, revision: old.revision, fromStatus: old.status, sourceFingerprint: row.sourceFingerprint, observedFingerprint, status: op.status })
      audit++
    }
  }
  const impact = { created: request.operations.filter(op => op.action === 'create').length, audit }
  const hash = requestHash(request)
  return { requestHash: hash, targets, impact, planHash: fingerprint({ requestHash: hash, targets, impact }) }
}
