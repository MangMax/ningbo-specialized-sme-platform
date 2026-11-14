/** Offline historical oracle from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
import { PlatformProjectionError } from '../../../lib/platform/projection-error'
export { PlatformProjectionError } from '../../../lib/platform/projection-error'
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import * as schema from '../../legacy-schema'
import type { Executor } from '../../../server/utils/roster-import'
import type { PlatformApplyProjectionPreview, PlatformBusinessProjectionPreview, PlatformObservationProjection, PlatformProjectionResult, PlatformRecognizedProjectionPreview } from '../../../lib/platform/business-record'
import { APPLY_PROJECTION_RULE, parseApplyRecord, type ApplyProjectionFields } from '../../../lib/platform/apply-record'
import { BUSINESS_PROJECTION_RULE, type BusinessProjectionFields } from '../../../lib/platform/business-projection'
import { RECOGNIZED_PROJECTION_RULE, type RecognizedSourceFidelity, type RecognizedProjectionFields } from '../../../lib/platform/recognized-projection'

import { PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE, canonicalPlatformJson, platformObservationPayload, planPlatformObservation } from '../../../lib/platform/observation-plan'
export { PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE, canonicalPlatformJson, platformObservationPayload, planPlatformObservation } from '../../../lib/platform/observation-plan'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
type Input = Parameters<typeof planPlatformObservation>[0]

/** Read native raw TEXT: malformed historical JSON must remain unverifiable, not crash decoding. */
export function readPlatformObservationPlan(db: Executor, relationId: number) {
  const source = db.get<{ interface: string; relationKey: string | null; rawText: string | null; queryId: number; sequenceNo: number; queryKey: string; rdjb: string; queriedAt: string }>(sql`
    SELECT q.interface, r.relation_key AS relationKey, r.raw_fields AS rawText,
      r.query_id AS queryId, r.sequence_no AS sequenceNo, q.query_key AS queryKey, q.rdjb, q.queried_at AS queriedAt
    FROM platform_relation r JOIN platform_query q ON q.id = r.query_id WHERE r.id = ${relationId}`)
  if (!source) throw new PlatformProjectionError('projection_source_missing', `Original relation ${relationId} not found`)
  let rawFields: unknown = null
  try { rawFields = source.rawText === null ? null : JSON.parse(source.rawText) } catch { /* retain invalid bytes in fingerprint */ }
  const plan = planPlatformObservation({ ...source, rawFields })
  const { rawText, ...position } = source
  const inputFingerprint = hash(canonicalPlatformJson({ ...position, rawFields, invalidRaw: rawFields === null ? rawText : null }))
  const existing = db.select().from(schema.platformBusinessObservation).where(eq(schema.platformBusinessObservation.relationId, relationId)).get()
  if (existing && (existing.inputFingerprint !== inputFingerprint || existing.projectionRuleVersion !== PLATFORM_PROJECTION_RULE)) {
    throw new PlatformProjectionError('projection_source_drift', `Original relation ${relationId} changed after projection`)
  }
  return { ...plan, relationId, interface: source.interface as typeof schema.platformQuery.$inferSelect['interface'], inputFingerprint, projectionRuleVersion: PLATFORM_PROJECTION_RULE }
}

/** Replayed collection rows may neither acquire a new key nor replace their original raw. */
export function assertPlatformObservationReplay(db: Executor, relationId: number, input: Input) {
  const original = db.get<{ relationKey: string | null; rawText: string | null }>(sql`SELECT relation_key AS relationKey, raw_fields AS rawText FROM platform_relation WHERE id = ${relationId}`)!
  let rawFields: unknown
  try { rawFields = original.rawText === null ? null : JSON.parse(original.rawText) }
  catch { throw new PlatformProjectionError('observation_payload_conflict', `Original relation ${relationId} has unverifiable raw bytes`) }
  if (platformObservationPayload({ interface: input.interface, relationKey: original.relationKey, rawFields }) !== platformObservationPayload(input)) {
    throw new PlatformProjectionError('observation_payload_conflict', `Collection row ${relationId} has a different key/raw payload`)
  }
  readPlatformObservationPlan(db, relationId)
}

export function projectionPreview(plan: ReturnType<typeof readPlatformObservationPlan>) {
  return { relationId: plan.relationId, identityState: plan.identityState, contentState: plan.contentState, keySource: plan.keySource, projectionRuleVersion: plan.projectionRuleVersion, inputFingerprint: plan.inputFingerprint }
}

/** Planned apply_list fields for preflight only. Raw bytes and hashes stay server-side. */
export function applyProjectionPreview(plan: { applyRecord: ApplyProjectionFields | null }): PlatformApplyProjectionPreview | null {
  return plan.applyRecord ? { ...plan.applyRecord, ruleVersion: APPLY_PROJECTION_RULE } : null
}

/** Planned business_list fields for preflight only. Query title scope and raw bytes stay server-side. */
export function businessProjectionPreview(plan: { businessProjection: BusinessProjectionFields | null }): PlatformBusinessProjectionPreview | null {
  return plan.businessProjection ? { ...plan.businessProjection, ruleVersion: BUSINESS_PROJECTION_RULE } : null
}

/** Planned recognized_list fields for preflight only. Query title scope and raw bytes stay server-side. */
export function recognizedProjectionPreview(plan: { recognizedProjection: RecognizedProjectionFields | null }): PlatformRecognizedProjectionPreview | null {
  return plan.recognizedProjection ? { ...plan.recognizedProjection, ruleVersion: RECOGNIZED_PROJECTION_RULE } : null
}

const APPLY_FIELDS = ['titleRaw', 'declareKind', 'declarationYear', 'appliedAt', 'status', 'nameRaw', 'usccRaw'] as const

/** One typed row per immutable content version. Rejects a same-version drift instead of
 * silently reinterpreting historical content under a newer rule. */
function ensureApplyProjection(db: Executor, versionId: number, recordId: number, fields: ApplyProjectionFields, verifyOnly = false): { created: boolean; reused: boolean } {
  const existing = db.select().from(schema.platformApplyProjection).where(eq(schema.platformApplyProjection.versionId, versionId)).get()
  if (existing) {
    if (existing.recordId !== recordId) throw new PlatformProjectionError('apply_projection_conflict', 'Projection owner differs')
    if (existing.ruleVersion !== APPLY_PROJECTION_RULE) throw new PlatformProjectionError('apply_projection_conflict', 'Apply projection rule differs')
    if (APPLY_FIELDS.some(field => existing[field] !== fields[field])) throw new PlatformProjectionError('apply_projection_conflict', 'Apply projection fields differ for the same content version')
    return { created: false, reused: true }
  }
  if (verifyOnly) throw new PlatformProjectionError('projection_missing', 'Required source projection missing')
  db.insert(schema.platformApplyProjection).values({ versionId, recordId, ...fields, ruleVersion: APPLY_PROJECTION_RULE }).run()
  return { created: true, reused: false }
}

const BUSINESS_FIELDS = ['titleRaw', 'declareKind', 'businessYear', 'appliedAt', 'status', 'batch', 'awardBatchLabel', 'province', 'nameRaw', 'usccRaw'] as const

/** One typed row per immutable content version. Rejects a same-version drift instead of
 * silently reinterpreting historical content under a newer rule. */
function ensureBusinessProjection(db: Executor, versionId: number, recordId: number, fields: BusinessProjectionFields, verifyOnly = false): { created: boolean; reused: boolean } {
  const existing = db.select().from(schema.platformBusinessProjection).where(eq(schema.platformBusinessProjection.versionId, versionId)).get()
  if (existing) {
    if (existing.recordId !== recordId) throw new PlatformProjectionError('business_projection_conflict', 'Projection owner differs')
    if (existing.ruleVersion !== BUSINESS_PROJECTION_RULE) throw new PlatformProjectionError('business_projection_conflict', 'Business projection rule differs')
    if (BUSINESS_FIELDS.some(field => existing[field] !== fields[field])) throw new PlatformProjectionError('business_projection_conflict', 'Business projection fields differ for the same content version')
    return { created: false, reused: true }
  }
  if (verifyOnly) throw new PlatformProjectionError('projection_missing', 'Required source projection missing')
  db.insert(schema.platformBusinessProjection).values({ versionId, recordId, ...fields, ruleVersion: BUSINESS_PROJECTION_RULE }).run()
  return { created: true, reused: false }
}

const RECOGNIZED_FIELDS = ['validityDateRaw', 'maintenanceYear', 'maintenanceBatch', 'district', 'awardNote', 'titleRaw', 'nameRaw', 'usccRaw'] as const

/** One typed row per immutable content version. Rejects a same-version drift instead of
 * silently reinterpreting historical content under a newer rule. */
function ensureRecognizedProjection(db: Executor, versionId: number, recordId: number, fields: RecognizedProjectionFields, fidelity: RecognizedSourceFidelity, verifyOnly = false): { created: boolean; reused: boolean } {
  const existing = db.select().from(schema.platformRecognizedProjection).where(eq(schema.platformRecognizedProjection.versionId, versionId)).get()
  if (existing) {
    if (existing.ruleVersion !== RECOGNIZED_PROJECTION_RULE) throw new PlatformProjectionError('recognized_projection_conflict', 'Recognized projection rule differs')
    if (RECOGNIZED_FIELDS.some(field => existing[field] !== fields[field])) throw new PlatformProjectionError('recognized_projection_conflict', 'Recognized projection fields differ for the same content version')
    // This is the explicit additive completion path for a new relationId command.
    // Normalized v1 content, ownership, IDs, timestamps and fingerprints never change.
    if (existing.recordId !== recordId) throw new PlatformProjectionError('recognized_projection_conflict', 'Recognized projection owner differs')
    if (existing.sourceMaintenanceYearAbsent === null) {
      if (verifyOnly) throw new PlatformProjectionError('projection_missing', 'Recognized source fidelity missing')
      if (existing.sourceValidityDate !== null || existing.sourceMaintenanceBatch !== null) {
        throw new PlatformProjectionError('recognized_projection_conflict', 'Partial recognized source-fidelity capture')
      }
      db.update(schema.platformRecognizedProjection).set(fidelity).where(eq(schema.platformRecognizedProjection.versionId, versionId)).run()
    } else if (existing.sourceValidityDate !== fidelity.sourceValidityDate
      || existing.sourceMaintenanceBatch !== fidelity.sourceMaintenanceBatch
      || existing.sourceMaintenanceYearAbsent !== fidelity.sourceMaintenanceYearAbsent) {
      throw new PlatformProjectionError('recognized_projection_conflict', 'Recognized source-fidelity capture differs')
    }
    return { created: false, reused: true }
  }
  if (verifyOnly) throw new PlatformProjectionError('projection_missing', 'Required source projection missing')
  db.insert(schema.platformRecognizedProjection).values({ versionId, recordId, ...fields, ...fidelity, ruleVersion: RECOGNIZED_PROJECTION_RULE }).run()
  return { created: true, reused: false }
}

/** Caller owns the single import transaction, including the original archive and receipt. */
export function ensurePlatformObservation(db: Executor, relationId: number, batchId?: number, expectedFingerprint?: string): PlatformProjectionResult {
  const plan = readPlatformObservationPlan(db, relationId)
  if (expectedFingerprint && expectedFingerprint !== plan.inputFingerprint) throw new PlatformProjectionError('projection_source_drift', `Original relation ${relationId} changed since preflight`)
  let recordId: number | null = null, versionId: number | null = null
  let recordCreated = false, versionCreated = false
  if (plan.platformKey) {
    const inserted = db.insert(schema.platformBusinessRecord).values({ interface: plan.interface, platformKey: plan.platformKey, identityRuleVersion: PLATFORM_PROJECTION_RULE }).onConflictDoNothing().returning().get()
    const record = inserted ?? db.select().from(schema.platformBusinessRecord).where(and(eq(schema.platformBusinessRecord.interface, plan.interface), eq(schema.platformBusinessRecord.platformKey, plan.platformKey))).get()!
    recordId = record.id; recordCreated = !!inserted
    if (record.identityRuleVersion !== PLATFORM_PROJECTION_RULE) throw new PlatformProjectionError('projection_rule_conflict', 'Record identity rule differs')
    if (plan.canonicalRawJson && plan.contentHash) {
      const insertedVersion = db.insert(schema.platformBusinessRecordVersion).values({ recordId, hashAlgorithm: PLATFORM_RAW_HASH_RULE, contentHash: plan.contentHash, canonicalRawJson: plan.canonicalRawJson }).onConflictDoNothing().returning().get()
      const version = insertedVersion ?? db.select().from(schema.platformBusinessRecordVersion).where(and(eq(schema.platformBusinessRecordVersion.recordId, recordId), eq(schema.platformBusinessRecordVersion.hashAlgorithm, PLATFORM_RAW_HASH_RULE), eq(schema.platformBusinessRecordVersion.contentHash, plan.contentHash))).get()!
      if (version.canonicalRawJson !== plan.canonicalRawJson) throw new PlatformProjectionError('platform_content_hash_conflict', 'Hash hit has different canonical raw content')
      versionId = version.id; versionCreated = !!insertedVersion
    }
  }
  const projection: PlatformObservationProjection = { ...projectionPreview(plan), recordId, versionId }
  const created = db.insert(schema.platformBusinessObservation).values({ ...projection, batchId: batchId ?? null }).onConflictDoNothing().returning().get()
  const observation = created ?? db.select().from(schema.platformBusinessObservation).where(eq(schema.platformBusinessObservation.relationId, relationId)).get()!
  if (Object.entries(projection).some(([field, value]) => observation[field as keyof typeof observation] !== value)) throw new PlatformProjectionError('projection_mapping_conflict', 'Stored projection does not match original observation')
  const applyProjectionResult = plan.applyRecord && recordId != null && versionId != null
    ? ensureApplyProjection(db, versionId, recordId, plan.applyRecord)
    : null
  const businessProjectionResult = plan.businessProjection && recordId != null && versionId != null
    ? ensureBusinessProjection(db, versionId, recordId, plan.businessProjection)
    : null
  const recognizedProjectionResult = plan.recognizedProjection && recordId != null && versionId != null
    ? ensureRecognizedProjection(db, versionId, recordId, plan.recognizedProjection, plan.recognizedSourceFidelity!)
    : null
  return {
    ...projection, syncRequested: true, recordCreated, versionCreated, observationCreated: !!created,
    ...(applyProjectionResult ? { applyProjectionCreated: applyProjectionResult.created, applyProjectionReused: applyProjectionResult.reused } : {}),
    ...(businessProjectionResult ? { businessProjectionCreated: businessProjectionResult.created, businessProjectionReused: businessProjectionResult.reused } : {}),
    ...(recognizedProjectionResult ? { recognizedProjectionCreated: recognizedProjectionResult.created, recognizedProjectionReused: recognizedProjectionResult.reused } : {}),
  }
}

/** Read-only completion check, after all writers and inside the same business transaction. */
export function verifyPlatformFields(db: Executor, results: PlatformProjectionResult[], referenceParticipated: boolean) {
  const observations = new Map(results.filter(row => row.syncRequested).map(row => [row.relationId, row]))
  const versions = new Set<number>()
  let quarantinedObservations = 0
  for (const row of observations.values()) {
    const plan = readPlatformObservationPlan(db, row.relationId)
    const stored = db.select().from(schema.platformBusinessObservation).where(eq(schema.platformBusinessObservation.relationId, row.relationId)).get()
    if (!stored || stored.recordId !== row.recordId || stored.versionId !== row.versionId || stored.inputFingerprint !== row.inputFingerprint || Object.entries(projectionPreview(plan)).some(([field, value]) => stored[field as keyof typeof stored] !== value)) throw new PlatformProjectionError('projection_mapping_conflict', 'Completion observation differs')
    if (row.versionId === null || row.recordId === null) { quarantinedObservations++; continue }
    const record = db.select().from(schema.platformBusinessRecord).where(eq(schema.platformBusinessRecord.id, row.recordId)).get()
    const version = db.select().from(schema.platformBusinessRecordVersion).where(eq(schema.platformBusinessRecordVersion.id, row.versionId)).get()
    if (!record || record.interface !== plan.interface || record.platformKey !== plan.platformKey || record.identityRuleVersion !== PLATFORM_PROJECTION_RULE || !version || version.recordId !== row.recordId || version.hashAlgorithm !== PLATFORM_RAW_HASH_RULE || version.contentHash !== plan.contentHash || version.canonicalRawJson !== plan.canonicalRawJson) throw new PlatformProjectionError('projection_mapping_conflict', 'Completion version owner or original differs')
    if (plan.applyRecord) ensureApplyProjection(db, row.versionId, row.recordId, plan.applyRecord, true)
    else if (plan.businessProjection) ensureBusinessProjection(db, row.versionId, row.recordId, plan.businessProjection, true)
    else if (plan.recognizedProjection) ensureRecognizedProjection(db, row.versionId, row.recordId, plan.recognizedProjection, plan.recognizedSourceFidelity!, true)
    else throw new PlatformProjectionError('projection_missing', 'Unsupported source projection')
    versions.add(row.versionId)
  }
  const created = new Set(results.filter(row => row.syncRequested && row.versionId !== null && versions.has(row.versionId) && (row.applyProjectionCreated || row.businessProjectionCreated || row.recognizedProjectionCreated)).map(row => row.versionId)).size
  return { status: quarantinedObservations || referenceParticipated ? 'partial' as const : observations.size ? 'ready' as const : 'not_performed' as const, eligibleVersions: versions.size, projectionsCreated: created, projectionsReused: versions.size - created, projectionsChecked: versions.size, observationsChecked: observations.size, quarantinedObservations }
}
