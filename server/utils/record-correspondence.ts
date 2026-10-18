import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { RDJB_TITLE_CODES, sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { ensureBatchRow, findBatchByKey } from './roster-batch-ledger'
import { currentProofCoversRows } from './comparison-scope-proof'

type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx
export type CorrespondenceEdge =
  | { type: 'event_process'; eventId: number; relationId: number; role: 'supports_award' | 'supports_review' | 'context_only' }
  | { type: 'event_recognized'; eventId: number; relationId: number; role: 'recognized_corrob' | 'current_context' }
  | { type: 'later_process'; enterpriseId: number; titleCode: string; predecessorEventId?: number | null; relationId: number; role: 'followup_apply' | 'followup_update' | 'followup_review' }
  | { type: 'event_export_context'; eventId: number; exportRowId: number; role: 'current_snapshot_context' }
  | { type: 'process_export_context'; relationId: number; exportRowId: number; role: 'current_snapshot_context' }
  | { type: 'recognized_export'; relationId: number; exportRowId: number; role: 'same_current_row' | 'candidate_same_current_row' }
export type CorrespondenceOperation =
  | { action: 'create'; edge: CorrespondenceEdge; status: 'candidate' | 'confirmed' }
  | { action: 'decide'; correspondenceId: number; expectedRevision: number; status: 'confirmed' | 'rejected' | 'unlinked' }
  | { action: 'correct'; correspondenceId: number; expectedRevision: number; edge: CorrespondenceEdge }
export interface CorrespondenceRequest {
  idempotencyKey: string
  sourceIdentity: string
  actor: { type: 'user' | 'agent'; id: string }
  basis: string
  ruleId: string
  ruleVersion: string
  proofIds?: number[]
  operations: CorrespondenceOperation[]
}
export interface CorrespondenceImpact { created: number; unlinked: number; audit: number }
export interface CorrespondencePlan { batchId: number; batchStatus: 'preflight' | 'committed'; planHash: string; impact: CorrespondenceImpact; targets: Record<string, unknown>[] }
export interface CorrespondenceReceipt { batchId: number; planHash: string; impact: CorrespondenceImpact; correspondenceIds: number[] }
type StoredCorrespondence = typeof schema.recordCorrespondence.$inferSelect
export type CorrespondenceRead = StoredCorrespondence & { requiresRevalidation: boolean }
export type CorrespondenceAudit = typeof schema.recordCorrespondenceAudit.$inferSelect
export type CorrespondenceFilter = Partial<Pick<CorrespondenceRead, 'eventId' | 'relationId' | 'exportRowId' | 'enterpriseId' | 'titleCode' | 'status' | 'type'>>

export class CorrespondenceError extends Error {
  constructor(readonly code: 'invalid_endpoint_type' | 'identity_conflict' | 'title_conflict' | 'ambiguous_candidate' | 'incomplete_coverage' | 'stale_revision' | 'plan_mismatch' | 'idempotency_conflict', message: string) {
    super(message)
    this.name = 'CorrespondenceError'
  }
  get status() { return ['stale_revision', 'plan_mismatch', 'idempotency_conflict'].includes(this.code) ? 409 : 422 }
}
function fail(code: CorrespondenceError['code'], message: string): never { throw new CorrespondenceError(code, message) }
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function positive(id: number | null | undefined) { return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 }
function filled(s: unknown) { return typeof s === 'string' && s.trim().length > 0 }
function edgeKey(edge: CorrespondenceEdge) {
  switch (edge.type) {
    case 'event_process':
    case 'event_recognized': return hash([edge.type, edge.eventId, edge.relationId, edge.role])
    case 'later_process': return hash([edge.type, edge.enterpriseId, edge.titleCode, edge.predecessorEventId ?? null, edge.relationId, edge.role])
    case 'event_export_context': return hash([edge.type, edge.eventId, edge.exportRowId, edge.role])
    case 'process_export_context':
    case 'recognized_export': return hash([edge.type, edge.relationId, edge.exportRowId, edge.role])
  }
}

function eventSource(db: Executor, id: number) {
  if (!positive(id)) fail('invalid_endpoint_type', 'eventId must be a positive integer')
  const row = db.select({ event: schema.recordEvent, record: schema.record, enterprise: schema.enterprise })
    .from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id))
    .innerJoin(schema.enterprise, eq(schema.record.enterpriseId, schema.enterprise.id))
    .where(eq(schema.recordEvent.id, id)).get()
  if (!row || row.record.source !== 'jxj') fail('invalid_endpoint_type', 'Official jxj event not found')
  return row
}
function relationSource(db: Executor, id: number) {
  if (!positive(id)) fail('invalid_endpoint_type', 'relationId must be a positive integer')
  const row = db.select({ relation: schema.platformRelation, query: schema.platformQuery })
    .from(schema.platformRelation).innerJoin(schema.platformQuery, eq(schema.platformRelation.queryId, schema.platformQuery.id))
    .where(eq(schema.platformRelation.id, id)).get()
  if (!row || !['success', 'partial'].includes(row.query.status)) fail('invalid_endpoint_type', 'Persisted positive interface row not found')
  return row
}
function exportSource(db: Executor, id: number) {
  if (!positive(id)) fail('invalid_endpoint_type', 'exportRowId must be a positive integer')
  const row = db.select({ exportRow: schema.platformExportRow, exportBatch: schema.platformExportBatch })
    .from(schema.platformExportRow).innerJoin(schema.platformExportBatch, eq(schema.platformExportRow.batchId, schema.platformExportBatch.id))
    .where(eq(schema.platformExportRow.id, id)).get()
  if (!row || row.exportBatch.importStatus !== 'imported') fail('invalid_endpoint_type', 'Persisted imported export row not found')
  return row
}
function officialEvidence(db: Executor, eventId: number) {
  const rows = db.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, eventId)).all()
    .sort((a, b) => a.id - b.id)
  return rows.map((evidence) => ({
    evidence,
    storedFile: db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, bytes: schema.storedFile.bytes, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt })
      .from(schema.storedFile).where(eq(schema.storedFile.relPath, evidence.sourceFile)).get() ?? null,
  }))
}
/** Observe persisted source rows without asserting that a retired decision is still valid. */
function sourceProvenance(db: Executor, edge: CorrespondenceEdge) {
  const event = 'eventId' in edge ? db.select({ event: schema.recordEvent, record: schema.record, enterprise: schema.enterprise })
    .from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id))
    .innerJoin(schema.enterprise, eq(schema.record.enterpriseId, schema.enterprise.id))
    .where(eq(schema.recordEvent.id, edge.eventId)).get() : null
  const relation = 'relationId' in edge ? db.select({ relation: schema.platformRelation, query: schema.platformQuery })
    .from(schema.platformRelation).innerJoin(schema.platformQuery, eq(schema.platformRelation.queryId, schema.platformQuery.id))
    .where(eq(schema.platformRelation.id, edge.relationId)).get() : null
  const exported = 'exportRowId' in edge ? db.select({ exportRow: schema.platformExportRow, exportBatch: schema.platformExportBatch })
    .from(schema.platformExportRow).innerJoin(schema.platformExportBatch, eq(schema.platformExportRow.batchId, schema.platformExportBatch.id))
    .where(eq(schema.platformExportRow.id, edge.exportRowId)).get() : null
  const predecessor = edge.type === 'later_process' && edge.predecessorEventId != null
    ? db.select({ event: schema.recordEvent, record: schema.record, enterprise: schema.enterprise })
      .from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id))
      .innerJoin(schema.enterprise, eq(schema.record.enterpriseId, schema.enterprise.id))
      .where(eq(schema.recordEvent.id, edge.predecessorEventId)).get() : null
  return {
    event: event?.event ?? null, record: event?.record ?? null, officialEnterprise: event?.enterprise ?? null,
    officialEvidence: event ? officialEvidence(db, event.event.id) : [],
    predecessor: predecessor ? { ...predecessor, officialEvidence: officialEvidence(db, predecessor.event.id) } : null,
    relation: relation?.relation ?? null, query: relation?.query ?? null,
    exportRow: exported?.exportRow ?? null, exportBatch: exported?.exportBatch ?? null,
  }
}
function relationTitle(source: ReturnType<typeof relationSource>): string | null {
  const { query, relation } = source
  const fromPosition = query.interface === 'recognized_list'
    ? RDJB_TITLE_CODES[sourcePositionForSequence(query.collectionEvidence, relation.sequenceNo).sourceRdjb ?? '']
    : undefined
  const scopes = query.rdjb.split(',').filter(Boolean)
  const fromScope = scopes.length === 1 ? RDJB_TITLE_CODES[scopes[0]!] : undefined
  if (query.titleCode && fromPosition && query.titleCode !== fromPosition) fail('title_conflict', 'Query and row title differ')
  if (query.titleCode && fromScope && query.titleCode !== fromScope) fail('title_conflict', 'Query title and rdjb differ')
  return fromPosition ?? query.titleCode ?? fromScope ?? null
}
function sameIdentity(left: { enterpriseId?: number | null; uscc: string | null }, right: { enterpriseId?: number | null; uscc: string | null }, confirmed: boolean) {
  const a = normalizeUscc(left.uscc)
  const b = normalizeUscc(right.uscc)
  if (a && b && a !== b) fail('identity_conflict', 'Source USCC values conflict')
  if (left.enterpriseId && right.enterpriseId && left.enterpriseId !== right.enterpriseId) fail('identity_conflict', 'Source enterprise IDs conflict')
  if (confirmed && (!a || !b) && !(left.enterpriseId && right.enterpriseId && left.enterpriseId === right.enterpriseId)) {
    fail('ambiguous_candidate', 'No verified row-level enterprise identity')
  }
  if (!a && !b && !(left.enterpriseId && right.enterpriseId && left.enterpriseId === right.enterpriseId)) {
    fail('ambiguous_candidate', 'Candidate has no enterprise identity anchor')
  }
}
function sameTitle(a: string | null, b: string | null, confirmed: boolean) {
  if (a && b && a !== b) fail('title_conflict', 'Source title codes conflict')
  if (confirmed && (!a || !b)) fail('incomplete_coverage', 'Row title is not explicit')
}
function sourceForEdge(db: Executor, edge: CorrespondenceEdge, confirmed: boolean, proofIds: number[] = []) {
  if (!edge || typeof edge !== 'object') fail('invalid_endpoint_type', 'Typed edge required')
  const shapes: Record<CorrespondenceEdge['type'], readonly string[]> = {
    event_process: ['type', 'eventId', 'relationId', 'role'],
    event_recognized: ['type', 'eventId', 'relationId', 'role'],
    later_process: ['type', 'enterpriseId', 'titleCode', 'predecessorEventId', 'relationId', 'role'],
    event_export_context: ['type', 'eventId', 'exportRowId', 'role'],
    process_export_context: ['type', 'relationId', 'exportRowId', 'role'],
    recognized_export: ['type', 'relationId', 'exportRowId', 'role'],
  }
  if (!Object.hasOwn(shapes, edge.type) || Object.keys(edge).some((key) => !shapes[edge.type].includes(key))) fail('invalid_endpoint_type', 'Edge shape does not match its discriminator')
  const event = 'eventId' in edge ? eventSource(db, edge.eventId) : null
  const relation = 'relationId' in edge ? relationSource(db, edge.relationId) : null
  const exported = 'exportRowId' in edge ? exportSource(db, edge.exportRowId) : null
  if (event && event.record.usccRaw && event.enterprise.usccNorm && normalizeUscc(event.record.usccRaw) !== normalizeUscc(event.enterprise.usccNorm)) fail('identity_conflict', 'Official record USCC differs from its enterprise')
  if (relation?.relation.enterpriseId && relation.relation.usccRaw) {
    const owner = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, relation.relation.enterpriseId)).get()
    if (!owner || (owner.usccNorm && normalizeUscc(owner.usccNorm) !== normalizeUscc(relation.relation.usccRaw))) fail('identity_conflict', 'Interface row USCC differs from its assigned enterprise')
  }
  if (!['event_process', 'event_recognized', 'later_process', 'event_export_context', 'process_export_context', 'recognized_export'].includes(edge.type)) fail('invalid_endpoint_type', 'Unknown edge type')
  const process = relation && ['business_list', 'apply_list'].includes(relation.query.interface)
  const recognized = relation?.query.interface === 'recognized_list'
  if ((['event_process', 'later_process', 'process_export_context'].includes(edge.type) && !process) ||
      (['event_recognized', 'recognized_export'].includes(edge.type) && !recognized) ||
      (['event_process', 'event_recognized', 'event_export_context'].includes(edge.type) && !event) ||
      (['event_export_context', 'process_export_context', 'recognized_export'].includes(edge.type) && !exported)) {
    fail('invalid_endpoint_type', 'Edge endpoint interface/type mismatch')
  }
  const roles: Record<CorrespondenceEdge['type'], readonly string[]> = {
    event_process: ['supports_award', 'supports_review', 'context_only'],
    event_recognized: ['recognized_corrob', 'current_context'],
    later_process: ['followup_apply', 'followup_update', 'followup_review'],
    event_export_context: ['current_snapshot_context'],
    process_export_context: ['current_snapshot_context'],
    recognized_export: ['same_current_row', 'candidate_same_current_row'],
  }
  if (!roles[edge.type].includes(edge.role)) fail('invalid_endpoint_type', 'Role is not valid for edge type')
  if (edge.type === 'event_process' && edge.role === 'supports_award' && event?.event.eventType !== 'award') fail('invalid_endpoint_type', 'Award role requires award event')
  if (edge.type === 'event_process' && edge.role === 'supports_review' && event?.event.eventType !== 'review') fail('invalid_endpoint_type', 'Review role requires review event')
  if (edge.type === 'event_process' && confirmed && relation?.relation.declareKind &&
      ((edge.role === 'supports_award' && relation.relation.declareKind !== 'apply') ||
       (edge.role === 'supports_review' && relation.relation.declareKind !== 'review'))) {
    fail('invalid_endpoint_type', 'Support role conflicts with original process type')
  }
  if (edge.type === 'event_process' && confirmed && edge.role !== 'context_only' && relation?.relation.appliedAt && event) {
    const decisionYear = event.event.decidedYear ?? (event.event.eventType === 'award' ? event.event.year : null)
    const applicationYear = Number(relation.relation.appliedAt.slice(0, 4))
    if (decisionYear && Number.isInteger(applicationYear) && applicationYear > decisionYear) fail('invalid_endpoint_type', 'Later application cannot support an earlier official decision')
  }
  if (edge.type === 'later_process') {
    const e = db.select().from(schema.enterprise).where(eq(schema.enterprise.id, edge.enterpriseId)).get()
    if (!e || !db.select().from(schema.title).where(eq(schema.title.code, edge.titleCode)).get()) fail('invalid_endpoint_type', 'Enterprise/title not found')
    if (edge.predecessorEventId != null) {
      const preceding = eventSource(db, edge.predecessorEventId)
      if (preceding.record.enterpriseId !== edge.enterpriseId) fail('identity_conflict', 'Predecessor belongs to another enterprise')
      sameTitle(edge.titleCode, preceding.record.titleCode, true)
      const decidedYear = preceding.event.decidedYear ?? (preceding.event.eventType === 'award' ? preceding.event.year : null)
      const appliedYear = Number(relation?.relation.appliedAt?.slice(0, 4))
      if (decidedYear && Number.isInteger(appliedYear) && appliedYear < decidedYear) fail('invalid_endpoint_type', 'Follow-up process predates its predecessor')
    }
  }
  const enterpriseId = event?.record.enterpriseId ?? (edge.type === 'later_process' ? edge.enterpriseId : relation?.relation.enterpriseId)
  const titleCode = event?.record.titleCode ?? (edge.type === 'later_process' ? edge.titleCode : relation ? relationTitle(relation) : null) ?? exported?.exportBatch.titleCode ?? null
  if (!titleCode || ((event || edge.type === 'later_process') && !enterpriseId)) fail('ambiguous_candidate', 'No anchored enterprise/title for edge')
  const left = event ? { enterpriseId: event.record.enterpriseId, uscc: event.record.usccRaw ?? event.enterprise.usccNorm } :
    edge.type === 'later_process' ? { enterpriseId: edge.enterpriseId, uscc: db.select().from(schema.enterprise).where(eq(schema.enterprise.id, edge.enterpriseId)).get()?.usccNorm ?? null } :
    relation ? { enterpriseId: relation.relation.enterpriseId, uscc: relation.relation.usccRaw } : null
  if (relation && left && (event || edge.type === 'later_process')) {
    sameIdentity(left, { enterpriseId: relation.relation.enterpriseId, uscc: relation.relation.usccRaw }, confirmed)
    if (confirmed && !normalizeUscc(relation.relation.usccRaw) && relation.relation.verificationStatus !== 'confirmed') fail('ambiguous_candidate', 'Relation ownership remains pending')
  }
  if (exported && left) sameIdentity(left, { uscc: exported.exportRow.usccRaw }, confirmed)
  if (relation && exported) sameIdentity({ enterpriseId: relation.relation.enterpriseId, uscc: relation.relation.usccRaw }, { uscc: exported.exportRow.usccRaw }, confirmed)
  if (relation) sameTitle(titleCode, relationTitle(relation), confirmed)
  if (exported) sameTitle(titleCode, exported.exportBatch.titleCode, confirmed)
  if (edge.type === 'later_process' && confirmed && relation?.relation.declareKind && relation.relation.declareKind !== edge.role.replace('followup_', '')) fail('invalid_endpoint_type', 'Follow-up role conflicts with original process type')
  if (edge.type === 'recognized_export' && confirmed && edge.role === 'same_current_row' && !currentProofCoversRows(db, proofIds, edge.relationId, edge.exportRowId)) fail('incomplete_coverage', 'Confirmed current-source equivalence proof required')
  if (edge.type === 'recognized_export' && confirmed && edge.role === 'candidate_same_current_row') fail('incomplete_coverage', 'Candidate role cannot be confirmed as current equivalence')
  const provenance = { ...sourceProvenance(db, edge), comparisonProofIds: edge.type === 'recognized_export' ? proofIds : [] }
  const targetIdentity = { eventId: event?.event.id ?? null, recordId: event?.record.id ?? null,
    officialEvidence: provenance.officialEvidence.map(({ evidence, storedFile }) => ({ evidenceId: evidence.id, sourceFile: evidence.sourceFile, attachment: evidence.attachment, listNo: evidence.listNo, page: evidence.page, storedFileId: storedFile?.id ?? null, storedFileSha256: storedFile?.sha256 ?? null })),
    predecessorEventId: edge.type === 'later_process' ? edge.predecessorEventId ?? null : null,
    predecessorEvidence: provenance.predecessor?.officialEvidence.map(({ evidence, storedFile }) => ({ evidenceId: evidence.id, sourceFile: evidence.sourceFile, attachment: evidence.attachment, listNo: evidence.listNo, page: evidence.page, storedFileId: storedFile?.id ?? null, storedFileSha256: storedFile?.sha256 ?? null })) ?? [],
    relationId: relation?.relation.id ?? null, queryId: relation?.query.id ?? null, queryNaturalKey: relation ? [relation.query.interface, relation.query.queryKey, relation.query.rdjb, relation.query.queriedAt, relation.relation.sequenceNo] : null, exportRowId: exported?.exportRow.id ?? null, exportNaturalKey: exported ? [exported.exportBatch.titleCode, exported.exportBatch.year, exported.exportBatch.sha256, exported.exportRow.sourceRowNo] : null }
  return { enterpriseId, titleCode, provenance, targetIdentity, sourceFingerprint: hash(sourceProvenance(db, edge)) }
}
function storedEdge(row: StoredCorrespondence): CorrespondenceEdge {
  const base = { relationId: row.relationId!, exportRowId: row.exportRowId!, eventId: row.eventId!, role: row.role }
  switch (row.type) {
    case 'event_process': return { type: row.type, eventId: base.eventId, relationId: base.relationId, role: row.role as 'context_only' }
    case 'event_recognized': return { type: row.type, eventId: base.eventId, relationId: base.relationId, role: row.role as 'current_context' }
    case 'later_process': return { type: row.type, enterpriseId: row.enterpriseId!, titleCode: row.titleCode, predecessorEventId: row.predecessorEventId, relationId: base.relationId, role: row.role as 'followup_apply' }
    case 'event_export_context': return { type: row.type, eventId: base.eventId, exportRowId: base.exportRowId, role: 'current_snapshot_context' }
    case 'process_export_context': return { type: row.type, relationId: base.relationId, exportRowId: base.exportRowId, role: 'current_snapshot_context' }
    case 'recognized_export': return { type: row.type, relationId: base.relationId, exportRowId: base.exportRowId, role: row.role as 'candidate_same_current_row' }
  }
}
function validatedRequest(request: CorrespondenceRequest) {
  if (!request || !filled(request.idempotencyKey) || !filled(request.sourceIdentity) || !filled(request.basis) || !filled(request.ruleId) || !filled(request.ruleVersion) ||
    !request.actor || !['user', 'agent'].includes(request.actor.type) || !filled(request.actor.id) || !Array.isArray(request.operations) || request.operations.length < 1) {
    fail('invalid_endpoint_type', 'Complete actor, basis, rule, source and at least one operation required')
  }
}
function buildPlan(db: Executor, request: CorrespondenceRequest) {
  validatedRequest(request)
  const requestHash = hash(request)
  const targets: Record<string, unknown>[] = []
  const impact: CorrespondenceImpact = { created: 0, unlinked: 0, audit: 0 }
  const touched = new Set<number>()
  const created = new Set<string>()
  for (const op of request.operations) {
    if (op.action === 'create' || op.action === 'correct') {
      const source = sourceForEdge(db, op.edge, op.action === 'correct' || op.status === 'confirmed', request.proofIds)
      const key = edgeKey(op.edge)
      if (created.has(key)) fail('ambiguous_candidate', 'Duplicate edge in one plan')
      created.add(key)
      const existing = db.select().from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.edgeKey, key)).get()
      if (existing) {
        if (op.action === 'correct' && existing.id === op.correspondenceId && existing.status === 'confirmed') {
          if (existing.revision !== op.expectedRevision) fail('stale_revision', 'Correspondence revision changed')
          if (existing.sourceFingerprint === source.sourceFingerprint) fail('ambiguous_candidate', 'Same edge has no changed source evidence to revalidate')
          targets.push({ edge: op.edge, targetIdentity: source.targetIdentity, enterpriseId: source.enterpriseId, titleCode: source.titleCode, sourceFingerprint: source.sourceFingerprint, reconfirmId: existing.id })
          impact.audit++
        } else if (op.action !== 'create' || op.status !== 'candidate' || existing.status !== 'rejected' ||
          (existing.ruleId === request.ruleId && existing.ruleVersion === request.ruleVersion && existing.sourceFingerprint === source.sourceFingerprint)) {
          fail('ambiguous_candidate', 'Edge already has a decision; new evidence or rule version is required to repropose')
        } else {
          targets.push({ edge: op.edge, targetIdentity: source.targetIdentity, enterpriseId: source.enterpriseId, titleCode: source.titleCode, sourceFingerprint: source.sourceFingerprint, rejectedId: existing.id, rejectedRevision: existing.revision })
          impact.audit++
        }
      } else {
        targets.push({ edge: op.edge, targetIdentity: source.targetIdentity, enterpriseId: source.enterpriseId, titleCode: source.titleCode, sourceFingerprint: source.sourceFingerprint })
        impact.created++
        impact.audit += op.action === 'correct' || op.status === 'confirmed' ? 2 : 1
      }
    }
    if (op.action === 'decide' || op.action === 'correct') {
      if (!positive(op.correspondenceId) || !Number.isSafeInteger(op.expectedRevision) || op.expectedRevision < 1) fail('invalid_endpoint_type', 'Correspondence ID and expected revision required')
      if (touched.has(op.correspondenceId)) fail('ambiguous_candidate', 'One plan cannot mutate the same decision twice')
      touched.add(op.correspondenceId)
      const row = db.select().from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.id, op.correspondenceId)).get()
      if (!row) fail('invalid_endpoint_type', 'Correspondence ID not found')
      if (row.revision !== op.expectedRevision) fail('stale_revision', 'Correspondence revision changed')
      const next = op.action === 'correct' ? 'unlinked' : op.status
      if (!(row.status === 'candidate' && ['confirmed', 'rejected'].includes(next)) && !(row.status === 'confirmed' && next === 'unlinked')) fail('invalid_endpoint_type', 'Invalid decision transition')
      const observedSourceFingerprint = next === 'unlinked'
        ? hash(sourceProvenance(db, storedEdge(row)))
        : sourceForEdge(db, storedEdge(row), next === 'confirmed', request.proofIds ?? (row.provenance.comparisonProofIds as number[] | undefined) ?? []).sourceFingerprint
      if (next !== 'unlinked' && observedSourceFingerprint !== row.sourceFingerprint) fail('plan_mismatch', 'Source row changed since correspondence decision')
      targets.push({ correspondenceId: row.id, revision: row.revision, status: row.status, sourceFingerprint: row.sourceFingerprint, observedSourceFingerprint })
      impact.audit++
      if (next === 'unlinked') impact.unlinked++
    }
  }
  return { requestHash, targets, impact, planHash: hash({ requestHash, targets, impact }) }
}
export function preflightRecordCorrespondences(db: Db, request: CorrespondenceRequest): CorrespondencePlan {
  validatedRequest(request)
  const old = findBatchByKey(db, request.idempotencyKey)
  if (old && (old.sourceKind !== 'correspondence_decision' || old.sourceIdentity !== request.sourceIdentity)) fail('idempotency_conflict', 'Idempotency key belongs to another source')
  const previous = old?.preflightResult as (CorrespondencePlan & { requestHash: string }) | null
  if (previous && previous.requestHash !== hash(request)) fail('idempotency_conflict', 'Idempotency key belongs to a different request')
  if (old?.status === 'committed' && previous) return { batchId: old.id, batchStatus: 'committed', planHash: previous.planHash, impact: previous.impact, targets: previous.targets }
  const plan = buildPlan(db, request)
  const batch = ensureBatchRow(db, { idempotencyKey: request.idempotencyKey, sourceKind: 'correspondence_decision', sourceIdentity: request.sourceIdentity })
  const result = { batchId: batch.id, batchStatus: 'preflight' as const, ...plan }
  const updated = db.update(schema.importBatch).set({ preflightResult: result, error: null })
    .where(and(eq(schema.importBatch.id, batch.id), eq(schema.importBatch.status, 'preflight'))).run()
  if (updated.changes === 0) {
    const current = findBatchByKey(db, request.idempotencyKey)
    const bound = current?.preflightResult as (CorrespondencePlan & { requestHash: string }) | null
    if (current?.status === 'committed' && bound?.requestHash === hash(request)) {
      return { batchId: current.id, batchStatus: 'committed', planHash: bound.planHash, impact: bound.impact, targets: bound.targets }
    }
    fail('idempotency_conflict', 'Batch changed during preflight')
  }
  return { batchId: batch.id, batchStatus: 'preflight', planHash: plan.planHash, impact: plan.impact, targets: plan.targets }
}
function addAudit(tx: Tx, row: StoredCorrespondence, batchId: number, request: CorrespondenceRequest, fromStatus: string | null, toStatus: string, expectedRevision: number, decidedAt: string) {
  tx.insert(schema.recordCorrespondenceAudit).values({ correspondenceId: row.id, batchId, idempotencyKey: request.idempotencyKey, fromStatus, toStatus, expectedRevision, resultingRevision: expectedRevision + 1, actorType: request.actor.type, actorId: request.actor.id, basis: request.basis, ruleId: request.ruleId, ruleVersion: request.ruleVersion, evidence: row.provenance, decidedAt }).run()
}
function insertEdge(tx: Tx, edge: CorrespondenceEdge, request: CorrespondenceRequest, batchId: number, status: 'candidate' | 'confirmed', at: string) {
  const source = sourceForEdge(tx, edge, status === 'confirmed', request.proofIds)
  const row = tx.insert(schema.recordCorrespondence).values({
    edgeKey: edgeKey(edge), type: edge.type, role: edge.role,
    eventId: 'eventId' in edge ? edge.eventId : null,
    predecessorEventId: edge.type === 'later_process' ? edge.predecessorEventId ?? null : null,
    relationId: 'relationId' in edge ? edge.relationId : null,
    exportRowId: 'exportRowId' in edge ? edge.exportRowId : null,
    enterpriseId: source.enterpriseId, titleCode: source.titleCode, status,
    revision: status === 'confirmed' ? 2 : 1,
    targetIdentity: source.targetIdentity, provenance: source.provenance, sourceFingerprint: source.sourceFingerprint,
    ruleId: request.ruleId, ruleVersion: request.ruleVersion, createdAt: at, decidedAt: status === 'confirmed' ? at : null,
  }).returning().get()
  addAudit(tx, row, batchId, request, null, 'candidate', 0, at)
  if (status === 'confirmed') addAudit(tx, row, batchId, request, 'candidate', 'confirmed', 1, at)
  return row.id
}
function reproposeEdge(tx: Tx, edge: CorrespondenceEdge, request: CorrespondenceRequest, batchId: number, at: string) {
  const existing = tx.select().from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.edgeKey, edgeKey(edge))).get()!
  const source = sourceForEdge(tx, edge, false, request.proofIds)
  tx.update(schema.recordCorrespondence).set({
    status: 'candidate', revision: existing.revision + 1, targetIdentity: source.targetIdentity,
    provenance: source.provenance, sourceFingerprint: source.sourceFingerprint,
    ruleId: request.ruleId, ruleVersion: request.ruleVersion, decidedAt: null, endedAt: null,
  }).where(eq(schema.recordCorrespondence.id, existing.id)).run()
  addAudit(tx, { ...existing, provenance: source.provenance }, batchId, request, 'rejected', 'candidate', existing.revision, at)
  return existing.id
}
function reconfirmEdge(tx: Tx, row: StoredCorrespondence, edge: CorrespondenceEdge, request: CorrespondenceRequest, batchId: number, at: string) {
  const source = sourceForEdge(tx, edge, true, request.proofIds)
  addAudit(tx, row, batchId, request, 'confirmed', 'unlinked', row.revision, at)
  const nextRevision = row.revision + 2
  const updated = tx.update(schema.recordCorrespondence).set({
    status: 'confirmed', revision: nextRevision, targetIdentity: source.targetIdentity,
    provenance: source.provenance, sourceFingerprint: source.sourceFingerprint,
    enterpriseId: source.enterpriseId, titleCode: source.titleCode,
    ruleId: request.ruleId, ruleVersion: request.ruleVersion, decidedAt: at, endedAt: null,
  }).where(and(eq(schema.recordCorrespondence.id, row.id), eq(schema.recordCorrespondence.revision, row.revision))).run()
  if (updated.changes !== 1) fail('stale_revision', 'Correspondence revision changed')
  addAudit(tx, { ...row, provenance: source.provenance }, batchId, request, 'unlinked', 'confirmed', row.revision + 1, at)
  return row.id
}
export function commitRecordCorrespondences(db: Db, request: CorrespondenceRequest, planHash: string): CorrespondenceReceipt {
  validatedRequest(request)
  const batch = findBatchByKey(db, request.idempotencyKey)
  if (!batch) fail('plan_mismatch', 'Preflight batch not found for source')
  if (batch.sourceKind !== 'correspondence_decision' || batch.sourceIdentity !== request.sourceIdentity) fail('idempotency_conflict', 'Idempotency key belongs to another source')
  const stored = batch.preflightResult as (CorrespondencePlan & { requestHash: string }) | null
  if (!stored) fail('plan_mismatch', 'No bound preflight plan')
  if (stored.requestHash !== hash(request)) fail('idempotency_conflict', 'Idempotency key belongs to a different request')
  if (stored.planHash !== planHash) fail('plan_mismatch', 'Submitted plan hash differs')
  if (batch.status === 'committed') return batch.summary as CorrespondenceReceipt
  return db.transaction((tx) => {
    const current = buildPlan(tx, request)
    if (current.planHash !== planHash) fail('plan_mismatch', 'Bound targets or source evidence changed')
    const at = new Date().toISOString()
    const correspondenceIds: number[] = []
    for (const op of request.operations) {
      if (op.action === 'create') {
        const existing = tx.select().from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.edgeKey, edgeKey(op.edge))).get()
        correspondenceIds.push(existing ? reproposeEdge(tx, op.edge, request, batch.id, at) : insertEdge(tx, op.edge, request, batch.id, op.status, at))
      } else {
        const row = tx.select().from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.id, op.correspondenceId)).get()!
        if (op.action === 'correct' && row.edgeKey === edgeKey(op.edge)) {
          correspondenceIds.push(reconfirmEdge(tx, row, op.edge, request, batch.id, at))
          continue
        }
        const next = op.action === 'correct' ? 'unlinked' : op.status
        tx.update(schema.recordCorrespondence).set({ status: next, revision: row.revision + 1, decidedAt: at, endedAt: next === 'unlinked' ? at : null, ruleId: request.ruleId, ruleVersion: request.ruleVersion,
          provenance: next === 'confirmed' && row.type === 'recognized_export' ? { ...row.provenance, comparisonProofIds: request.proofIds ?? [] } : row.provenance })
          .where(and(eq(schema.recordCorrespondence.id, row.id), eq(schema.recordCorrespondence.revision, row.revision))).run()
        addAudit(tx, { ...row, provenance: next === 'confirmed' && row.type === 'recognized_export' ? { ...row.provenance, comparisonProofIds: request.proofIds ?? [] } : row.provenance }, batch.id, request, row.status, next, row.revision, at)
        correspondenceIds.push(row.id)
        if (op.action === 'correct') correspondenceIds.push(insertEdge(tx, op.edge, request, batch.id, 'confirmed', at))
      }
    }
    const receipt: CorrespondenceReceipt = { batchId: batch.id, planHash, impact: current.impact, correspondenceIds }
    tx.update(schema.importBatch).set({ status: 'committed', summary: receipt, itemResults: correspondenceIds, committedAt: at, error: null }).where(eq(schema.importBatch.id, batch.id)).run()
    return receipt
  })
}
export function readRecordCorrespondenceBatch(db: Db, idempotencyKey: string): CorrespondenceReceipt | null {
  const batch = findBatchByKey(db, idempotencyKey)
  return batch?.sourceKind === 'correspondence_decision' && batch.status === 'committed' ? batch.summary as CorrespondenceReceipt : null
}
export function listRecordCorrespondences(db: Db, filter: CorrespondenceFilter = {}): CorrespondenceRead[] {
  const entries = Object.entries(filter).filter(([, value]) => value != null) as [keyof CorrespondenceFilter, string | number][]
  return db.select().from(schema.recordCorrespondence).all().filter((row) => entries.every(([key, value]) => row[key] === value)).sort((a, b) => a.id - b.id).map((row) => {
    let requiresRevalidation = false
    if (row.status === 'confirmed') {
      try { requiresRevalidation = sourceForEdge(db, storedEdge(row), true, (row.provenance.comparisonProofIds as number[] | undefined) ?? []).sourceFingerprint !== row.sourceFingerprint }
      catch { requiresRevalidation = true }
    }
    return { ...row, requiresRevalidation }
  })
}
export function getRecordCorrespondenceAudit(db: Db, correspondenceId: number): CorrespondenceAudit[] {
  return db.select().from(schema.recordCorrespondenceAudit).where(eq(schema.recordCorrespondenceAudit.correspondenceId, correspondenceId)).all().sort((a, b) => a.id - b.id)
}
