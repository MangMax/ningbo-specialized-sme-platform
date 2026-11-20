import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import type { RosterImportItemResult, RosterImportRequest } from '../../lib/roster-import-client'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { advancePostgresOfficialEventRevision } from './evidence-revision-postgres'
import { lockPostgresFilePaths, refreshPostgresDerivedFileParts } from './file-parts-postgres'
import {
  officialAppendSchema, officialFactFailure, officialPlanDigest, readOfficialFile, type OfficialClaimChange,
  type OfficialCoordinate, type OfficialEvidenceLocatorMove,
} from './official-evidence-plan'
import { planPostgresOfficialEvidenceChanges } from './official-evidence-plan-postgres'
import { writePostgresOfficialPublishedRow } from './official-evidence-write-postgres'
import { EvidenceCorrectionError, evidenceCorrectionRequestSchema } from './roster-evidence-correction'
import { planPostgresEvidenceCorrectionTargets, writePostgresEvidenceCorrection } from './roster-evidence-correction-postgres'
import { hasOfficialFactInput } from './roster-import'
import { validateRosterImportPageCounts } from './roster-import-page-validation'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Event = typeof schema.recordEvent.$inferSelect
type Record = typeof schema.record.$inferSelect
const appendBatch = officialAppendSchema.array().min(1).max(100)
const correctionBatch = evidenceCorrectionRequestSchema.omit({ idempotencyKey: true })
const ids = (values: Iterable<number>) => sql`${sql.param([...new Set(values)])}::bigint[]`

interface OfficialImportOptions {
  filesDir?: string
  captures?: readonly OfficialClaimChange[]
  unknownClaims?: readonly { ref: string; coordinate: OfficialCoordinate }[]
  locatorMoves?: readonly OfficialEvidenceLocatorMove[]
  ownerMap?: ReadonlyMap<string, string>
  reviewDecision?: string
}

export interface PostgresOfficialImportState {
  declarations: Map<string, number>
  changedEvents: Map<number, number>
  files: Set<string>
}

export function createPostgresOfficialImportState(): PostgresOfficialImportState {
  return { declarations: new Map(), changedEvents: new Map(), files: new Set() }
}

export async function finishPostgresOfficialImport(tx: Tx, state: PostgresOfficialImportState) {
  for (const [eventId, revision] of state.changedEvents) await advancePostgresOfficialEventRevision(tx, eventId, revision)
  await refreshPostgresDerivedFileParts(tx, state.files)
}

function parseOfficialImportOperations(request: RosterImportRequest, captureCount = 0) {
  const { officialEvidenceAppends, officialEvidenceCorrections } = request.payload
  if (captureCount + (officialEvidenceAppends?.length ?? 0) + (officialEvidenceCorrections?.operations?.length ?? 0) > 100) {
    return officialFactFailure('input_limit', 'At most 100 new official fact operations', 400)
  }
  const appends = officialEvidenceAppends === undefined ? undefined : appendBatch.safeParse(officialEvidenceAppends)
  const correction = officialEvidenceCorrections === undefined ? undefined : correctionBatch.safeParse(officialEvidenceCorrections)
  if (appends?.success === false || correction?.success === false) {
    return officialFactFailure('invalid_input', 'Malformed typed official fact input', 400)
  }
  return { appends: appends?.data ?? [], correction: correction?.data }
}

async function lockOfficialImportTargets(tx: Tx, operations: ReturnType<typeof parseOfficialImportOperations>,
  paths: Iterable<string>, eventIds: Iterable<number>,
) {
  const { appends, correction } = operations
  const corrections = correction?.operations ?? []
  const priorPaths = corrections.length ? (await tx.execute<{ path: string }>(sql`
    SELECT source_file AS path FROM record_evidence WHERE id=ANY(${ids(corrections.map(op => op.evidenceId))})`)).rows : []
  await lockPostgresFilePaths(tx, [
    ...paths, ...appends.map(op => op.evidence.sourceFile), ...corrections.map(op => op.coordinate.sourceFile),
    ...priorPaths.map(row => row.path),
  ])
  const events = [...eventIds, ...appends.map(op => op.eventId), ...corrections.map(op => op.eventId)]
  if (events.length) await tx.execute(sql`SELECT id FROM record_event WHERE id=ANY(${ids(events)}) ORDER BY id FOR UPDATE`)
}

/** Lock the combined announcement and explicit-operation targets in file-then-event order. */
export async function lockPostgresOfficialImportTargets(tx: Tx, request: RosterImportRequest,
  paths: Iterable<string>, eventIds: Iterable<number>,
) {
  await lockOfficialImportTargets(tx, parseOfficialImportOperations(request), paths, eventIds)
}

/** Plan against the caller's serializable transaction before writing announcement events, repoints or merges. */
export async function planPostgresOfficialImport(tx: Tx, request: RosterImportRequest, options: OfficialImportOptions = {}) {
  if (!hasOfficialFactInput(request)) return null
  const { captures = [], unknownClaims = [], locatorMoves = [], filesDir, ownerMap = new Map<string, string>(), reviewDecision } = options
  const operations = parseOfficialImportOperations(request, captures.length)
  const { appends, correction } = operations
  if (!captures.length && !appends.length && !correction) {
    return officialFactFailure('invalid_input', 'Opt-in official request has no fact operations', 409)
  }
  await lockOfficialImportTargets(tx, operations, [
    ...captures.map(change => change.coordinate.sourceFile),
    ...locatorMoves.flatMap(move => [move.fromSourceFile, move.sourceFile]),
  ], locatorMoves.map(move => move.recordEventId))
  if (appends.some(op => op.evidence.page !== null) || correction?.operations.some(op => op.coordinate.page !== null)) {
    const [error] = await validateRosterImportPageCounts({ ...request, payload: {
      officialEvidenceAppends: appends, officialEvidenceCorrections: correction,
    } }, filesDir)
    if (error?.error) return officialFactFailure(error.error.code, error.error.message, 409)
  }
  const changes = captures.map(change => ({ ...change }))
  const originalVersions: unknown[] = []
  const appendTargets = []
  for (const [index, op] of appends.entries()) {
    const { rows: [target] } = await tx.execute<{ event: Event; record: Record }>(sql`
      SELECT ${postgresRosterRow(schema.recordEvent,'e')} AS event,${postgresRosterRow(schema.record,'r')} AS record
      FROM record_event e JOIN record r ON r.id=e.record_id JOIN enterprise owner ON owner.id=r.enterprise_id
      WHERE e.id=${op.eventId}`)
    if (!target || target.record.source !== 'jxj' || target.record.id !== op.recordId || target.record.enterpriseId !== op.enterpriseId) {
      return officialFactFailure('target_mismatch', 'Exact event and current real owner must match', 409)
    }
    if (target.event.revision !== op.expectedVersion) return officialFactFailure('stale_version', 'Official event revision changed', 409)
    const { rows: scope } = await tx.execute<{ id: number }>(sql`
      SELECT id::float8 AS id FROM record_evidence WHERE record_event_id=${op.eventId} ORDER BY id LIMIT 301`)
    if (scope.length > 300) return officialFactFailure('source_limit', 'Event evidence exceeds 300', 413)
    originalVersions.push({ ...target, scope: scope.map(row => row.id) })
    const { publishedRow, ...coordinate } = op.evidence
    const ref = `append:${index}`
    const change: OfficialClaimChange = { ref, evidenceId: ref, eventId: op.eventId, owner: `enterprise:${op.enterpriseId}`,
      titleCode: target.record.titleCode, coordinate, publishedRow, expectedRowRevision: 0 }
    changes.push(change)
    appendTargets.push({ event: target.event, scope: scope.length, change })
  }
  const inspections = new Map<string, ReturnType<typeof readOfficialFile> & { pageCount: null }>()
  for (const op of correction?.operations ?? []) {
    const path = op.coordinate.sourceFile
    if (!inspections.has(path)) inspections.set(path, { ...readOfficialFile(filesDir, path), pageCount: null })
  }
  const correctionTargets = correction ? await planPostgresEvidenceCorrectionTargets(tx,
    { ...correction, idempotencyKey: request.idempotencyKey }, inspections, true).catch(error => {
    if (error instanceof EvidenceCorrectionError) return officialFactFailure(error.code, error.message, error.status)
    throw error
  }) : []
  for (const target of correctionTargets) {
    if (!target.rowChange) return officialFactFailure('ambiguity', 'Import correction requires explicit publishedRow', 409)
    changes.push(target.rowChange)
    originalVersions.push({ evidenceId: target.evidenceId, expectedVersion: target.expectedVersion, event: target.event, file: target.file })
  }
  const finalOwner = (owner: string | null) => {
    const seen = new Set<string>()
    while (owner !== null && ownerMap.has(owner)) {
      if (seen.has(owner)) return officialFactFailure('ambiguity', 'Cyclic merge ownership', 409)
      seen.add(owner)
      owner = ownerMap.get(owner)!
    }
    return owner
  }
  const facts = await planPostgresOfficialEvidenceChanges(tx, changes, filesDir, finalOwner, unknownClaims, locatorMoves)
  const additions = Map.groupBy(appendTargets.filter(({ change }) => change.noOpEvidenceId === undefined), target => target.event.id)
  for (const { event, scope } of appendTargets) {
    if (scope + (additions.get(event.id)?.length ?? 0) > 300) {
      return officialFactFailure('source_limit', 'Final event evidence exceeds 300', 413)
    }
  }
  const { officialEvidencePlanHash: _provided, ...payload } = request.payload
  const hash = officialPlanDigest({ request: { ...request, sourceSha256: request.sourceSha256 ?? null, payload },
    facts: facts.planHash, originalVersions, ownerMap: [...ownerMap] })
  const planHash = reviewDecision === undefined ? hash : officialPlanDigest({ review: reviewDecision, plan: hash })
  return { planHash, operations: changes.length, appendTargets, correction, correctionTargets }
}

export type PostgresOfficialImportPlan = NonNullable<Awaited<ReturnType<typeof planPostgresOfficialImport>>>

export function assertPostgresOfficialImportPlanHash(plan: PostgresOfficialImportPlan | null, submittedPlanHash: string | undefined) {
  if (plan && submittedPlanHash !== plan.planHash) {
    return officialFactFailure('plan_mismatch', 'Matching opt-in preflight planHash required; sources or final plan changed', 409)
  }
}

/** Apply a plan rebuilt in this transaction. The coordinator finalizes shared effects before merges. */
export async function applyPostgresOfficialImport(tx: Tx, plan: PostgresOfficialImportPlan, batchId: number,
  submittedPlanHash: string | undefined, sharedState?: PostgresOfficialImportState): Promise<RosterImportItemResult> {
  assertPostgresOfficialImportPlanHash(plan, submittedPlanHash)
  const state = sharedState ?? createPostgresOfficialImportState()
  const declarationsBefore = state.declarations.size
  const evidence: unknown[] = []
  let rowsWritten = 0
  for (const { event, change } of plan.appendTargets) {
    if (change.noOpEvidenceId !== undefined) {
      evidence.push({ evidenceId: change.noOpEvidenceId, eventId: event.id, unchanged: true })
      continue
    }
    const { sourceFile, attachment, listNo, page } = change.coordinate
    const { rows: [inserted] } = await tx.execute<{ id: number }>(sql`
      INSERT INTO record_evidence(record_event_id,source_file,attachment,list_no,page)
      VALUES(${event.id},${sourceFile},${attachment},${listNo},${page}) RETURNING id::float8 AS id`)
    evidence.push(await writePostgresOfficialPublishedRow(tx, change.publishedRow, inserted!.id, 0,
      { kind: 'import', batchId }, state.declarations))
    state.changedEvents.set(event.id, event.revision)
    state.files.add(sourceFile)
    rowsWritten++
  }
  for (const target of plan.correctionTargets) {
    if (await writePostgresEvidenceCorrection(tx, target, plan.correction!, { kind: 'import', batchId }, state.declarations)) {
      state.changedEvents.set(target.eventId, target.event.revision)
      state.files.add(target.before.sourceFile).add(target.after.sourceFile)
    }
    evidence.push({ evidenceId: target.evidenceId, eventId: target.eventId,
      revision: target.rowChange!.expectedRowRevision + Number(target.rowChange!.changed) })
  }
  if (!sharedState) await finishPostgresOfficialImport(tx, state)
  return { ok: true, kind: 'official_evidence', ref: 'official_evidence',
    detail: { evidence, rowsWritten: rowsWritten + state.declarations.size - declarationsBefore } }
}
