import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const comparisonScopeProof = businessSchema.table('comparison_scope_proof', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  kind: text('kind', { enum: ['official_coverage', 'current_source_equivalence'] }).notNull(),
  evidence: text('evidence').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  createdAt: text('created_at').notNull(),
})

export const comparisonScopeProofAudit = businessSchema.table('comparison_scope_proof_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  proofId: bigint('proof_id', { mode: 'number' }).notNull(),
  batchId: bigint('batch_id', { mode: 'number' }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  fromStatus: text('from_status', { enum: ['candidate', 'confirmed', 'revoked'] }),
  toStatus: text('to_status', { enum: ['candidate', 'confirmed', 'revoked'] }).notNull(),
  expectedRevision: bigint('expected_revision', { mode: 'number' }).notNull(),
  resultingRevision: bigint('resulting_revision', { mode: 'number' }).notNull(),
  actorType: text('actor_type', { enum: ['user', 'agent'] }).notNull(),
  actorId: text('actor_id').notNull(),
  basis: text('basis').notNull(),
  ruleId: text('rule_id').notNull(),
  ruleVersion: text('rule_version').notNull(),
  decidedAt: text('decided_at').notNull(),
})
