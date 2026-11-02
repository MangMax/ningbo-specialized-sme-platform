import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import * as schema from '../../db/schema'
import type { Executor } from './roster-import'
import type { PlatformApplyProjectionPreview, PlatformObservationProjection, PlatformProjectionResult } from '../../lib/platform/business-record'
import { APPLY_PROJECTION_RULE, parseApplyRecord, type ApplyProjectionFields } from '../../lib/platform/apply-record'

export const PLATFORM_PROJECTION_RULE = 'platform-observation-v1'
export const PLATFORM_RAW_HASH_RULE = 'platform-row-json-v1'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** JSON only: do not coerce types, omit values, normalize text or sort arrays. */
export function canonicalPlatformJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from(value, canonicalPlatformJson).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPlatformJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new Error('platform_raw_not_json')
}

const key = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
type Input = { interface: string; relationKey: unknown; rawFields: unknown }
export function platformObservationPayload(input: Input): string {
  return canonicalPlatformJson({ interface: input.interface, relationKey: input.relationKey ?? null, rawFields: input.rawFields ?? null })
}

export function planPlatformObservation(input: Input) {
  const raw = input.rawFields && typeof input.rawFields === 'object' && !Array.isArray(input.rawFields)
    ? input.rawFields as Record<string, unknown> : null
  const relationKey = key(input.relationKey), rawKey = key(raw?.id)
  const identityState = relationKey && rawKey && relationKey !== rawKey ? 'conflict' : relationKey || rawKey ? 'resolved' : 'missing_key'
  const platformKey = identityState === 'resolved' ? relationKey ?? rawKey : null
  const canonicalRawJson = platformKey && raw && Object.keys(raw).length ? canonicalPlatformJson(raw) : null
  return {
    platformKey, identityState,
    contentState: canonicalRawJson ? 'verified' : 'unverifiable',
    keySource: relationKey && rawKey ? 'both' : relationKey ? 'relation_key' : rawKey ? 'raw_id' : 'none',
    canonicalRawJson,
    contentHash: canonicalRawJson ? hash(`${PLATFORM_RAW_HASH_RULE}\n${canonicalRawJson}`) : null,
    // Only a verified apply_list version can own typed source fields. Unknown/missing
    // keys stay isolated as observations and never acquire a reusable typed row.
    applyRecord: input.interface === 'apply_list' && canonicalRawJson ? parseApplyRecord(raw) : null,
  } as const
}

export class PlatformProjectionError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

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

const APPLY_FIELDS = ['declareKind', 'declarationYear', 'appliedAt', 'status', 'nameRaw', 'usccRaw', 'province'] as const

/** One typed row per immutable content version. Rejects a same-version drift instead of
 * silently reinterpreting historical content under a newer rule. */
function ensureApplyProjection(db: Executor, versionId: number, recordId: number, fields: ApplyProjectionFields): { created: boolean; reused: boolean } {
  const existing = db.select().from(schema.platformApplyProjection).where(eq(schema.platformApplyProjection.versionId, versionId)).get()
  if (existing) {
    if (existing.ruleVersion !== APPLY_PROJECTION_RULE) throw new PlatformProjectionError('apply_projection_conflict', 'Apply projection rule differs')
    if (APPLY_FIELDS.some(field => existing[field] !== fields[field])) throw new PlatformProjectionError('apply_projection_conflict', 'Apply projection fields differ for the same content version')
    return { created: false, reused: true }
  }
  db.insert(schema.platformApplyProjection).values({ versionId, recordId, ...fields, ruleVersion: APPLY_PROJECTION_RULE }).run()
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
  const typed = plan.applyRecord && recordId != null && versionId != null
    ? ensureApplyProjection(db, versionId, recordId, plan.applyRecord)
    : null
  return {
    ...projection, recordCreated, versionCreated, observationCreated: !!created,
    ...(typed ? { applyProjectionCreated: typed.created, applyProjectionReused: typed.reused } : {}),
  }
}
