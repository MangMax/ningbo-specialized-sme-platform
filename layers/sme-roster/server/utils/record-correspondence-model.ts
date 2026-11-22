import { createHash } from 'node:crypto'
import type * as schema from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import type { PlatformStoredQuery, PlatformStoredRelation } from '../../lib/platform/read'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { platformRowTitle } from '../../lib/platform/row-title'
import { correspondenceIdentityProblem } from './record-correspondence-identity'
import type { readCorrespondenceTargetSources } from './record-correspondence-target-sources'
import { versionedOfficialEvent } from './roster-event-version-model'

export type CorrespondenceEdge =
  | { type: 'event_process'; eventId: number; relationId: number; role: 'supports_award' | 'supports_review' | 'context_only' }
  | { type: 'event_recognized'; eventId: number; relationId: number; role: 'recognized_corrob' | 'current_context' }
  | { type: 'later_process'; enterpriseId: number; titleCode: string; predecessorEventId?: number | null; relationId: number; role: 'followup_apply' | 'followup_update' | 'followup_review' }
  | { type: 'event_export_context'; eventId: number; exportRowId: number; role: 'current_snapshot_context' }
  | { type: 'process_export_context'; relationId: number; exportRowId: number; role: 'current_snapshot_context' }
  | { type: 'recognized_export'; relationId: number; exportRowId: number; role: 'same_current_row' | 'candidate_same_current_row' }

export type CorrespondenceOperation =
  | { action: 'revalidate'; correspondenceId: number; expectedRevision: number }
  | { action: 'create'; edge: CorrespondenceEdge; status: 'candidate' | 'confirmed' | 'rejected' }
  | { action: 'decide'; correspondenceId: number; expectedRevision: number; status: 'confirmed' | 'rejected' | 'unlinked' }
  | { action: 'correct'; correspondenceId: number; expectedRevision: number; edge: CorrespondenceEdge }

export interface CorrespondenceRequest {
  idempotencyKey: string
  sourceIdentity: string
  actor: { type: 'user' | 'agent'; id: string }
  basis: string
  ruleId: string
  ruleVersion: string
  operations: CorrespondenceOperation[]
}

export interface CorrespondenceImpact { created: number; unlinked: number; audit: number }

export interface CorrespondencePlan { batchId: number; batchStatus: 'preflight' | 'committed'; planHash: string; impact: CorrespondenceImpact; targets: Record<string, unknown>[] }

export interface CorrespondenceReceipt { batchId: number; planHash: string; impact: CorrespondenceImpact; correspondenceIds: number[] }

export type StoredCorrespondence = Omit<typeof schema.recordCorrespondence.$inferSelect, 'observationId'> & { relationId: number | null }

export type CorrespondenceRead = StoredCorrespondence & { requiresRevalidation: boolean }

export class CorrespondenceError extends Error {
  constructor(readonly code: 'invalid_endpoint_type' | 'identity_conflict' | 'title_conflict' | 'ambiguous_candidate' | 'incomplete_coverage' | 'stale_revision' | 'plan_mismatch' | 'idempotency_conflict', message: string) {
    super(message)
    this.name = 'CorrespondenceError'
  }
  get status() { return ['stale_revision', 'plan_mismatch', 'idempotency_conflict'].includes(this.code) ? 409 : 422 }
}

export function fail(code: CorrespondenceError['code'], message: string): never { throw new CorrespondenceError(code, message) }

export function correspondenceHash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

export const hash = correspondenceHash

function positive(id: number | null | undefined) { return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 }

function filled(s: unknown) { return typeof s === 'string' && s.trim().length > 0 }

export function correspondenceEdgeKey(edge: CorrespondenceEdge) {
  switch (edge.type) {
    case 'event_process':
    case 'event_recognized': return hash([edge.type, edge.eventId, edge.relationId, edge.role])
    case 'later_process': return hash([edge.type, edge.enterpriseId, edge.titleCode, edge.predecessorEventId ?? null, edge.relationId, edge.role])
    case 'event_export_context': return hash([edge.type, edge.eventId, edge.exportRowId, edge.role])
    case 'process_export_context':
    case 'recognized_export': return hash([edge.type, edge.relationId, edge.exportRowId, edge.role])
  }
}

const edgeKey = correspondenceEdgeKey

function eventSource(sources: ReadSources, id: number) {
  if (!positive(id)) fail('invalid_endpoint_type', 'eventId must be a positive integer')
  const row = sources.events.get(id)
  if (!row || row.record.source !== 'jxj') fail('invalid_endpoint_type', 'Official jxj event not found')
  return row
}

function relationSource(sources: ReadSources, id: number) {
  if (!positive(id)) fail('invalid_endpoint_type', 'relationId must be a positive integer')
  const row = sources.relations.get(id)
  if (!row || !['success', 'partial'].includes(row.query.status)) fail('invalid_endpoint_type', 'Persisted positive interface row not found')
  return { ...row, relation: row.facts }
}

function exportSource(sources: ReadSources, id: number) {
  if (!positive(id)) fail('invalid_endpoint_type', 'exportRowId must be a positive integer')
  const row = sources.exports.get(id)
  if (!row || row.exportBatch.importStatus !== 'imported') fail('invalid_endpoint_type', 'Persisted imported export row not found')
  return row
}

function sourceProvenance(sources: ReadSources, edge: CorrespondenceEdge) {
  const event = 'eventId' in edge ? sources.events.get(edge.eventId) : undefined
  const relation = 'relationId' in edge ? sources.relations.get(edge.relationId) : undefined
  const exported = 'exportRowId' in edge ? sources.exports.get(edge.exportRowId) : undefined
  const predecessor = edge.type === 'later_process' && edge.predecessorEventId != null
    ? sources.events.get(edge.predecessorEventId) : undefined
  return {
    event: event ? versionedOfficialEvent(event.event) : null, record: event?.record ?? null, officialEnterprise: event?.enterprise ?? null,
    officialEvidence: event ? sources.evidence.get(event.event.id) ?? [] : [],
    predecessor: predecessor ? { ...predecessor, event: versionedOfficialEvent(predecessor.event), officialEvidence: sources.evidence.get(predecessor.event.id) ?? [] } : null,
    relation: relation?.relation ?? null, query: relation?.query ?? null,
    exportRow: exported?.exportRow ?? null, exportBatch: exported?.exportBatch ?? null,
  }
}

function relationTitle(source: ReturnType<typeof relationSource>): string | null {
  const { query, relation } = source
  const fromPosition = query.interface === 'recognized_list'
    ? RDJB_TITLE_CODES[relation.sourceRdjb ?? '']
    : undefined
  const fromScope = RDJB_TITLE_CODES[platformRowTitle(query.rdjb, relation.rawFields)]
  if (query.titleCode && fromPosition && query.titleCode !== fromPosition) fail('title_conflict', 'Query and row title differ')
  if (query.titleCode && fromScope && query.titleCode !== fromScope) fail('title_conflict', 'Query title and rdjb differ')
  return fromPosition ?? query.titleCode ?? fromScope ?? null
}

function sameIdentity(left: { enterpriseId?: number | null; uscc: string | null }, right: { enterpriseId?: number | null; uscc: string | null }, confirmed: boolean) {
  const problem = correspondenceIdentityProblem(left, right, confirmed)
  if (problem) fail(problem.code, problem.message)
}

function sameTitle(a: string | null, b: string | null, confirmed: boolean) {
  if (a && b && a !== b) fail('title_conflict', 'Source title codes conflict')
  if (confirmed && (!a || !b)) fail('incomplete_coverage', 'Row title is not explicit')
}

function sourceForEdge(observed: ReadSources, edge: CorrespondenceEdge, confirmed: boolean) {
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
  const event = 'eventId' in edge ? eventSource(observed, edge.eventId) : null
  const relation = 'relationId' in edge ? relationSource(observed, edge.relationId) : null
  const exported = 'exportRowId' in edge ? exportSource(observed, edge.exportRowId) : null
  if (event && event.record.usccRaw && event.enterprise.usccNorm && normalizeUscc(event.record.usccRaw) !== normalizeUscc(event.enterprise.usccNorm)) fail('identity_conflict', 'Official record USCC differs from its enterprise')
  if (relation?.relation.enterpriseId && relation.relation.usccRaw) {
    const owner = observed.enterprises.get(relation.relation.enterpriseId)
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
  if (confirmed && relation?.relation.normalizationConflicts.length &&
      (edge.type === 'later_process' || edge.type === 'event_process' && edge.role !== 'context_only')) {
    fail('invalid_endpoint_type', 'Conflicting archived process facts require review')
  }
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
    const e = observed.enterprises.get(edge.enterpriseId)
    if (!e || !observed.titles.has(edge.titleCode)) fail('invalid_endpoint_type', 'Enterprise/title not found')
    if (edge.predecessorEventId != null) {
      const preceding = eventSource(observed, edge.predecessorEventId)
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
    edge.type === 'later_process' ? { enterpriseId: edge.enterpriseId, uscc: (observed.enterprises.get(edge.enterpriseId))?.usccNorm ?? null } :
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
  if (edge.type === 'recognized_export' && confirmed) {
    fail('incomplete_coverage', 'Recognized interface and export rows can only be recorded as candidates')
  }
  const provenance = sourceProvenance(observed, edge)
  const targetIdentity = { eventId: event?.event.id ?? null, recordId: event?.record.id ?? null,
    officialEvidence: provenance.officialEvidence.map(({ evidence, storedFile }) => ({ evidenceId: evidence.id, sourceFile: evidence.sourceFile, attachment: evidence.attachment, listNo: evidence.listNo, page: evidence.page, storedFileId: storedFile?.id ?? null, storedFileSha256: storedFile?.sha256 ?? null })),
    predecessorEventId: edge.type === 'later_process' ? edge.predecessorEventId ?? null : null,
    predecessorEvidence: provenance.predecessor?.officialEvidence.map(({ evidence, storedFile }) => ({ evidenceId: evidence.id, sourceFile: evidence.sourceFile, attachment: evidence.attachment, listNo: evidence.listNo, page: evidence.page, storedFileId: storedFile?.id ?? null, storedFileSha256: storedFile?.sha256 ?? null })) ?? [],
    relationId: relation?.relation.id ?? null, queryId: relation?.query.id ?? null, queryNaturalKey: relation ? [relation.query.interface, relation.query.queryKey, relation.query.rdjb, relation.query.queriedAt, relation.relation.sequenceNo] : null, exportRowId: exported?.exportRow.id ?? null, exportNaturalKey: exported ? [exported.exportBatch.titleCode, exported.exportBatch.year, exported.exportBatch.sha256, exported.exportRow.sourceRowNo] : null }
  return { enterpriseId, titleCode, provenance, targetIdentity, sourceFingerprint: hash(provenance) }
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

export function validatedRequest(request: CorrespondenceRequest) {
  if (!request || !filled(request.idempotencyKey) || !filled(request.sourceIdentity) || !filled(request.basis) || !filled(request.ruleId) || !filled(request.ruleVersion) ||
    !request.actor || !['user', 'agent'].includes(request.actor.type) || !filled(request.actor.id) || !Array.isArray(request.operations) || request.operations.length < 1) {
    fail('invalid_endpoint_type', 'Complete actor, basis, rule, source and at least one operation required')
  }
}

export type DecisionLookup = { byId: (id: number) => StoredCorrespondence | undefined; byEdge: (key: string) => StoredCorrespondence | undefined }

export function buildRecordCorrespondencePlan(lookup: DecisionLookup, request: CorrespondenceRequest, observed: ReadSources) {
  validatedRequest(request)
  const requestHash = hash(request)
  const targets: Record<string, unknown>[] = []
  const impact: CorrespondenceImpact = { created: 0, unlinked: 0, audit: 0 }
  const touched = new Set<number>()
  const created = new Set<string>()
  for (const op of request.operations) {
    if (op.action === 'revalidate') {
      if (!positive(op.correspondenceId) || !positive(op.expectedRevision)) fail('invalid_endpoint_type', 'Correspondence ID and expected revision required')
      if (touched.has(op.correspondenceId)) fail('ambiguous_candidate', 'One plan cannot mutate the same decision twice')
      touched.add(op.correspondenceId)
      const row = lookup.byId(op.correspondenceId)
      if (!row || row.status !== 'candidate') fail('invalid_endpoint_type', 'Only a candidate can rebind source evidence')
      if (row.revision !== op.expectedRevision) fail('stale_revision', 'Correspondence revision changed')
      const source = sourceForEdge(observed, storedEdge(row), false)
      if (source.sourceFingerprint === row.sourceFingerprint) fail('ambiguous_candidate', 'Same edge has no changed source evidence to revalidate')
      targets.push({ correspondenceId: row.id, revision: row.revision, status: row.status, sourceFingerprint: row.sourceFingerprint, observedSourceFingerprint: source.sourceFingerprint, targetIdentity: source.targetIdentity })
      impact.audit++
    }
    if (op.action === 'create' || op.action === 'correct') {
      const source = sourceForEdge(observed, op.edge, op.action === 'correct' || op.status === 'confirmed')
      const key = edgeKey(op.edge)
      if (created.has(key)) fail('ambiguous_candidate', 'Duplicate edge in one plan')
      created.add(key)
      const existing = lookup.byEdge(key)
      if (existing) {
        if (op.action === 'correct' && existing.status === 'candidate') {
          if (touched.has(existing.id)) fail('ambiguous_candidate', 'One plan cannot mutate the same replacement twice')
          touched.add(existing.id)
          if (existing.sourceFingerprint !== source.sourceFingerprint) fail('plan_mismatch', 'Replacement candidate source changed; revalidation required')
          targets.push({ edge: op.edge, targetIdentity: source.targetIdentity, sourceFingerprint: source.sourceFingerprint, confirmId: existing.id, confirmRevision: existing.revision })
          impact.audit++
        } else if (op.action === 'correct' && existing.id === op.correspondenceId && existing.status === 'confirmed') {
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
        impact.audit += op.action === 'correct' || op.status !== 'candidate' ? 2 : 1
      }
    }
    if (op.action === 'decide' || op.action === 'correct') {
      if (!positive(op.correspondenceId) || !Number.isSafeInteger(op.expectedRevision) || op.expectedRevision < 1) fail('invalid_endpoint_type', 'Correspondence ID and expected revision required')
      if (touched.has(op.correspondenceId)) fail('ambiguous_candidate', 'One plan cannot mutate the same decision twice')
      touched.add(op.correspondenceId)
      const row = lookup.byId(op.correspondenceId)
      if (!row) fail('invalid_endpoint_type', 'Correspondence ID not found')
      if (row.revision !== op.expectedRevision) fail('stale_revision', 'Correspondence revision changed')
      const next = op.action === 'correct' ? 'unlinked' : op.status
      if (!(row.status === 'candidate' && ['confirmed', 'rejected'].includes(next)) && !(row.status === 'confirmed' && next === 'unlinked')) fail('invalid_endpoint_type', 'Invalid decision transition')
      const observedSourceFingerprint = next === 'unlinked'
        ? hash(sourceProvenance(observed, storedEdge(row)))
        : sourceForEdge(observed, storedEdge(row), next === 'confirmed').sourceFingerprint
      if (next !== 'unlinked' && observedSourceFingerprint !== row.sourceFingerprint) fail('plan_mismatch', 'Source row changed since correspondence decision')
      targets.push({ correspondenceId: row.id, revision: row.revision, status: row.status, sourceFingerprint: row.sourceFingerprint, observedSourceFingerprint })
      impact.audit++
      if (next === 'unlinked') impact.unlinked++
    }
  }
  return { requestHash, targets, impact, planHash: hash({ requestHash, targets, impact }) }
}

type DecisionState = typeof schema.recordCorrespondence.$inferInsert

type DecisionAudit = Omit<typeof schema.recordCorrespondenceAudit.$inferInsert, 'correspondenceId'>

type DecisionMutation = {
  audits: DecisionAudit[]
} & ({ type: 'insert'; changes: DecisionState } | { type: 'update'; row: StoredCorrespondence; changes: Partial<DecisionState>; candidateOnly?: boolean })

export function* recordCorrespondenceMutations(
  lookup: DecisionLookup, request: CorrespondenceRequest, observed: ReadSources, batchId: number, at: string,
): Generator<DecisionMutation> {
  const rule = { ruleId: request.ruleId, ruleVersion: request.ruleVersion }
  const audit = (fromStatus: string | null, toStatus: string, expectedRevision: number, evidence: StoredCorrespondence['provenance']): DecisionAudit => ({
    batchId, idempotencyKey: request.idempotencyKey, fromStatus, toStatus, expectedRevision, resultingRevision: expectedRevision + 1,
    actorType: request.actor.type, actorId: request.actor.id, basis: request.basis, ...rule, evidence, decidedAt: at,
  })
  const insert = (edge: CorrespondenceEdge, status: 'candidate' | 'confirmed' | 'rejected'): DecisionMutation => {
    const source = sourceForEdge(observed, edge, status === 'confirmed')
    const audits = [audit(null, 'candidate', 0, source.provenance)]
    if (status !== 'candidate') audits.push(audit('candidate', status, 1, source.provenance))
    return { type: 'insert', audits, changes: {
      edgeKey: edgeKey(edge), type: edge.type, role: edge.role,
      eventId: 'eventId' in edge ? edge.eventId : null,
      predecessorEventId: edge.type === 'later_process' ? edge.predecessorEventId ?? null : null,
      observationId: 'relationId' in edge ? observed.relations.get(edge.relationId)!.observationId! : null,
      exportRowId: 'exportRowId' in edge ? edge.exportRowId : null,
      ...source, ...rule, status, revision: status === 'candidate' ? 1 : 2,
      createdAt: at, decidedAt: status === 'candidate' ? null : at,
    } }
  }
  for (const op of request.operations) {
    if (op.action === 'create') {
      const row = lookup.byEdge(edgeKey(op.edge))
      if (row) {
        const { enterpriseId: _enterprise, titleCode: _title, ...source } = sourceForEdge(observed, op.edge, false)
        yield { type: 'update', row, changes: { ...source, ...rule, status: 'candidate', revision: row.revision + 1, decidedAt: null, endedAt: null },
          audits: [audit('rejected', 'candidate', row.revision, source.provenance)] }
      } else yield insert(op.edge, op.status)
      continue
    }
    const row = lookup.byId(op.correspondenceId)!
    if (op.action === 'revalidate') {
      const source = sourceForEdge(observed, storedEdge(row), false)
      yield { type: 'update', row, candidateOnly: true, changes: { ...source, ...rule, revision: row.revision + 1 },
        audits: [audit('candidate', 'candidate', row.revision, source.provenance)] }
      continue
    }
    if (op.action === 'correct' && row.edgeKey === edgeKey(op.edge)) {
      const source = sourceForEdge(observed, op.edge, true)
      yield { type: 'update', row, changes: { ...source, ...rule, status: 'confirmed', revision: row.revision + 2, decidedAt: at, endedAt: null },
        audits: [audit('confirmed', 'unlinked', row.revision, row.provenance), audit('unlinked', 'confirmed', row.revision + 1, source.provenance)] }
      continue
    }
    const next = op.action === 'correct' ? 'unlinked' : op.status
    const provenance = row.provenance
    yield { type: 'update', row, changes: { ...rule, status: next, revision: row.revision + 1, decidedAt: at, endedAt: next === 'unlinked' ? at : null, provenance },
      audits: [audit(row.status, next, row.revision, provenance)] }
    if (op.action === 'correct') {
      const replacement = lookup.byEdge(edgeKey(op.edge))
      if (replacement) {
        const { provenance } = sourceForEdge(observed, op.edge, true)
        yield { type: 'update', row: replacement, candidateOnly: true,
          changes: { ...rule, status: 'confirmed', revision: replacement.revision + 1, decidedAt: at, provenance },
          audits: [audit('candidate', 'confirmed', replacement.revision, provenance)] }
      } else yield insert(op.edge, 'confirmed')
    }
  }
}

type EventRows = { event: typeof schema.recordEvent.$inferSelect; record: typeof schema.record.$inferSelect; enterprise: typeof schema.enterprise.$inferSelect }

type RelationRows = { relation: PlatformStoredRelation; query: PlatformStoredQuery; facts: ReturnType<typeof readCorrespondenceTargetSources>[number]['facts']; observationId?: number }

type ExportRows = { exportRow: typeof schema.platformExportRow.$inferSelect; exportBatch: typeof schema.platformExportBatch.$inferSelect }

export interface ReadSources {
  events: Map<number, EventRows>
  relations: Map<number, RelationRows>
  exports: Map<number, ExportRows>
  enterprises: Map<number, typeof schema.enterprise.$inferSelect>
  titles: Set<string>
  evidence: Map<number, Array<{ evidence: typeof schema.recordEvidence.$inferSelect; storedFile: { id: number; relPath: string; bytes: number; sha256: string | null; removedAt: string | null } | null }>>
}

export type SourceReference = Pick<StoredCorrespondence, 'status' | 'eventId' | 'predecessorEventId' | 'relationId' | 'exportRowId' | 'enterpriseId' | 'titleCode'>

export function requestedCorrespondenceSources(request: CorrespondenceRequest, stored: StoredCorrespondence[]) {
  const references: SourceReference[] = stored.map(row => ({ ...row, status: 'candidate' }))
  for (const op of request.operations) if ('edge' in op && op.edge && typeof op.edge === 'object') {
    const edge = op.edge
    references.push({ status: 'candidate', eventId: 'eventId' in edge ? edge.eventId : null, predecessorEventId: edge.type === 'later_process' ? edge.predecessorEventId ?? null : null, relationId: 'relationId' in edge ? edge.relationId : null, exportRowId: 'exportRowId' in edge ? edge.exportRowId : null, enterpriseId: edge.type === 'later_process' ? edge.enterpriseId : null, titleCode: edge.type === 'later_process' ? edge.titleCode : '' })
  }
  return references
}

export function projectObservedCorrespondence(row: StoredCorrespondence, observed: ReadSources): CorrespondenceRead {
  let requiresRevalidation = false
  if (row.status === 'confirmed' || row.status === 'candidate') {
    try { requiresRevalidation = sourceForEdge(observed, storedEdge(row), row.status === 'confirmed').sourceFingerprint !== row.sourceFingerprint }
    catch { requiresRevalidation = true }
  }
  return { ...row, requiresRevalidation }
}
