/** Explicit caller-owned import composition. Ordinary runtime/worker guards stay closed. */
import { and, eq } from 'drizzle-orm'
import type { Executor } from './roster-import'
import { targetSchema as s } from '../../lib/platform/target-schema'
import { sqliteConnection } from '../../lib/platform/target-connection'
import { targetReplaySource, writeCollectionTarget, CollectionReplayError } from '../../lib/platform/collection-target-replay'
import { readDifferenceCollection } from '../../lib/platform/difference-sources'
import { verifyFingerprint } from '../../lib/platform/fingerprint-verifier'
import { normalizeUscc } from '../../lib/domain'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { planPlatformObservation, PLATFORM_RAW_HASH_RULE, PlatformProjectionError } from './platform-business-record'
import { captureQueryRevision113 } from './evidence-impact-113'
import type { RosterImportPlatformQuery, RosterImportItemResult } from '../../lib/roster-import-client'
import type { PlatformProjectionResult } from '../../lib/platform/business-record'

export function collectionImportTarget(db: Executor) {
  return Number(sqliteConnection(db).pragma('user_version', { simple: true })) === 71612
}
export function collectionImportSource(db: Executor, queryId: number) {
  const selected = readDifferenceCollection(db, queryId)
  if (!selected) throw new PlatformProjectionError('projection_source_missing', `Original query ${queryId} not found`)
  return targetReplaySource(db, sqliteConnection(db), selected.collection).source
}
function collectionProjection(db: Executor, relationId: number) {
  const a = s.platformLegacyRelationAlias, o = s.platformBusinessObservation
  const row = db.select({ observation: o, interface: s.platformCollection.interface }).from(a)
    .innerJoin(o, eq(o.id, a.observationId)).innerJoin(s.platformCollection, eq(s.platformCollection.id, o.collectionId))
    .where(eq(a.oldId, relationId)).get()
  if (!row) throw new PlatformProjectionError('projection_source_missing', `Original relation ${relationId} not found`)
  const p = row.interface === 'apply_list' ? s.platformApplyProjection : row.interface === 'business_list' ? s.platformBusinessProjection : s.platformRecognizedProjection
  const projection = row.observation.versionId == null ? undefined : db.select().from(p).where(eq(p.versionId, row.observation.versionId)).get()
  return { row: row.observation, interface: row.interface, projection }
}
export function collectionImportProjection(db: Executor, relationId: number) {
  const result = collectionProjection(db, relationId)
  verifyFingerprint(sqliteConnection(db), { observationId: result.row.id, collectionId: result.row.collectionId, relationAlias: relationId })
  return result
}
/** Preflight business fields come from source-owned projections after original admission. */
export function collectionImportPreview(db: Executor, relationId: number) {
  // The shared replay comparator has already admitted this original. Its reference
  // mode deliberately permits paired not_indexed rows without bootstrapping them.
  const { row, interface: source } = collectionProjection(db, relationId)
  const state = { relationId, identityState: row.identityState, contentState: row.contentState, keySource: row.keySource }
  if (source === 'apply_list') {
    const p = s.platformApplyProjection
    const fields = db.select({ titleRaw: p.titleRaw, declareKind: p.declareKind, declarationYear: p.declarationYear, appliedAt: p.appliedAt, status: p.status, nameRaw: p.nameRaw, usccRaw: p.usccRaw, ruleVersion: p.ruleVersion })
      .from(p).where(eq(p.observationId, row.id)).get()
    return { ...state, ...(fields ? { applyProjection: fields } : {}) }
  }
  if (source === 'business_list') {
    const p = s.platformBusinessProjection
    const fields = db.select({ titleRaw: p.titleRaw, declareKind: p.declareKind, businessYear: p.businessYear, appliedAt: p.appliedAt, status: p.status, batch: p.batch, awardBatchLabel: p.awardBatchLabel, province: p.province, nameRaw: p.nameRaw, usccRaw: p.usccRaw, ruleVersion: p.ruleVersion })
      .from(p).where(eq(p.observationId, row.id)).get()
    return { ...state, ...(fields ? { businessProjection: fields } : {}) }
  }
  const p = s.platformRecognizedProjection
  const fields = db.select({ titleRaw: p.titleRaw, validityDateRaw: p.validityDateRaw, maintenanceYear: p.maintenanceYear, maintenanceBatch: p.maintenanceBatch, district: p.district, awardNote: p.awardNote, nameRaw: p.nameRaw, usccRaw: p.usccRaw, ruleVersion: p.ruleVersion })
    .from(p).where(eq(p.observationId, row.id)).get()
  return { ...state, ...(fields ? { recognizedProjection: fields } : {}) }
}
export function writeImportedCollection(db: Executor, query: RosterImportPlatformQuery, batchId?: number): RosterImportItemResult {
  const existed = new Map((query.relations ?? []).map(row => {
    const plan = planPlatformObservation({ interface: query.interface, relationKey: row.relationKey, rawFields: row.rawFields })
    const record = plan.platformKey == null ? undefined : db.select().from(s.platformBusinessRecord).where(and(eq(s.platformBusinessRecord.interface, query.interface), eq(s.platformBusinessRecord.platformKey, plan.platformKey))).get()
    const version = !record || !plan.contentHash ? undefined : db.select().from(s.platformBusinessRecordVersion).where(and(eq(s.platformBusinessRecordVersion.recordId, record.id), eq(s.platformBusinessRecordVersion.hashAlgorithm, PLATFORM_RAW_HASH_RULE), eq(s.platformBusinessRecordVersion.contentHash, plan.contentHash))).get()
    const p = query.interface === 'apply_list' ? s.platformApplyProjection : query.interface === 'business_list' ? s.platformBusinessProjection : s.platformRecognizedProjection
    const projection = version ? db.select({ id: p.id }).from(p).where(eq(p.versionId, version.id)).get() : undefined
    return [row.sequenceNo, { record: !!record, version: !!version, projection: !!projection }]
  }))
  try {
    const result = writeCollectionTarget(db, {
      queryText: JSON.stringify(query), evidenceText: query.collectionEvidence == null ? null : JSON.stringify(query.collectionEvidence),
      createdAt: new Date().toISOString(), ...(batchId === undefined ? {} : { batchId }),
      assignments: (query.relations ?? []).map(raw => {
        const row = normalizePlatformRelation(query.interface, raw)
        const explicit = typeof row.enterpriseId === 'number' ? row.enterpriseId : null
        const uscc = normalizeUscc(row.usccRaw)
        const owner = explicit ?? (uscc ? db.select({ id: s.enterprise.id }).from(s.enterprise).where(eq(s.enterprise.usccNorm, uscc)).get()?.id : null) ?? null
        const unknown = row.declareKind != null && !s.platformRelation.declareKind.enumValues.includes(row.declareKind as 'apply' | 'review' | 'update')
        return { enterpriseId: owner, matchBasis: row.matchBasis ?? (explicit != null ? 'manual' : owner != null ? 'uscc' : 'none'),
          verificationStatus: row.verificationStatus ?? (owner != null && !unknown ? 'confirmed' : 'pending'),
          nameRaw: typeof row.nameRaw === 'string' ? row.nameRaw.trim() || null : null,
          usccRaw: typeof row.usccRaw === 'string' ? row.usccRaw.trim() || null : null,
          aliasNameRaw: typeof row.aliasNameRaw === 'string' ? row.aliasNameRaw.trim() || null : null,
          origin: 'command', actor: { type: 'agent', id: 'roster-import' }, basis: `roster-import batch:${batchId ?? 'unknown'}` }
      }),
    })
    if (result.reused && result.item) return result.item
    const seenRecords = new Set<number>(), seenVersions = new Set<number>()
    const canonicalProjection: PlatformProjectionResult[] = result.observations.map((written, index) => {
      const { row } = collectionImportProjection(db, written.relationAlias)
      if (row.identityState === 'not_indexed' || row.contentState === 'not_indexed' || row.keySource == null || row.projectionRuleVersion == null || row.inputFingerprint == null) throw new PlatformProjectionError('projection_missing', 'New source must have an indexed observation')
      const before = existed.get(query.relations![index]!.sequenceNo)!
      const recordCreated = row.recordId != null && !before.record && !seenRecords.has(row.recordId)
      const versionCreated = row.versionId != null && !before.version && !seenVersions.has(row.versionId)
      const projectionCreated = row.versionId != null && !before.projection && !seenVersions.has(row.versionId)
      if (row.recordId != null) seenRecords.add(row.recordId)
      if (row.versionId != null) seenVersions.add(row.versionId)
      const projected = row.versionId == null ? {} : query.interface === 'apply_list'
        ? { applyProjectionCreated: projectionCreated, applyProjectionReused: !projectionCreated }
        : query.interface === 'business_list' ? { businessProjectionCreated: projectionCreated, businessProjectionReused: !projectionCreated }
        : { recognizedProjectionCreated: projectionCreated, recognizedProjectionReused: !projectionCreated }
      return { relationId: written.relationAlias, recordId: row.recordId, versionId: row.versionId, identityState: row.identityState, contentState: row.contentState, keySource: row.keySource,
        projectionRuleVersion: row.projectionRuleVersion!, inputFingerprint: row.inputFingerprint!, syncRequested: true, observationCreated: true, recordCreated, versionCreated, ...projected }
    })
    captureQueryRevision113(db, result.queryAlias)
    return { ok: true, kind: 'platform_query', ref: `query:${result.queryAlias}`, detail: { relations: result.observations.map(o => o.relationAlias), skipped: 0, canonicalProjection, rowsWritten: 1 + result.observations.length } }
  } catch (error) {
    if (error instanceof CollectionReplayError) return error.result
    if (error instanceof PlatformProjectionError) return { ok: false, kind: 'platform_query', ref: 'query:target', error: { code: error.code, message: error.message, field: 'relations' } }
    throw error
  }
}

export function verifyImportedCollectionFields(db: Executor, results: PlatformProjectionResult[], reference: boolean) {
  const observations = new Map(results.filter(r => r.syncRequested).map(r => [r.relationId, r]))
  const versions = new Set<number>()
  let quarantinedObservations = 0
  for (const result of observations.values()) {
    const { row, projection } = collectionImportProjection(db, result.relationId)
    if (row.recordId !== result.recordId || row.versionId !== result.versionId || row.inputFingerprint !== result.inputFingerprint) throw new PlatformProjectionError('projection_mapping_conflict', 'Completion observation differs')
    if (row.versionId == null || row.recordId == null) { quarantinedObservations++; continue }
    if (!projection) throw new PlatformProjectionError('projection_missing', 'Required source projection missing')
    versions.add(row.versionId)
  }
  const created = new Set(results.filter(r => r.syncRequested && r.versionId != null && versions.has(r.versionId) && (r.applyProjectionCreated || r.businessProjectionCreated || r.recognizedProjectionCreated)).map(r => r.versionId)).size
  return { status: quarantinedObservations || reference ? 'partial' as const : observations.size ? 'ready' as const : 'not_performed' as const,
    eligibleVersions: versions.size, projectionsCreated: created, projectionsReused: versions.size - created, projectionsChecked: versions.size, observationsChecked: observations.size, quarantinedObservations }
}
