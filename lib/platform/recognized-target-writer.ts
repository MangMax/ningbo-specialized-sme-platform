/** W3a explicit finalized-target transaction seam. No public import routing. */
import { capturePhase, nextObservationId, captureFingerprintBasis, assertCapturedInput } from './fingerprint-capture'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { RosterImportRelation } from '../roster-import-client'
import { targetSchema as s } from './target-schema'
import { parseRecognizedRecord, parseRecognizedSourceFidelity, RECOGNIZED_PROJECTION_RULE } from './recognized-projection'
import { canonicalPlatformJson, planPlatformObservation, PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE } from './observation-plan'
import { sourceFieldComparison, sourceValueKind } from './source-extraction'
import { allocateLegacyAlias, insertArchiveValue, bindArchive, sealArchiveOwner } from './target-archive'

type Assignment = Omit<typeof s.platformObservationAssignment.$inferInsert, 'observationId' | 'revision'>
export type RecognizedTargetInput = {
  collectionId: number
  position: Pick<typeof s.platformBusinessObservation.$inferInsert, 'sequenceNo' | 'pageId' | 'pageRowNo' | 'positionState'>
  /** Already validated by the current import contract. Raw JSON is serialized once here. */
  row: RosterImportRelation
  /** Explicit decision provenance; no inferred owner or historical confirmation time. */
  assignment: Assignment
}
function positive(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid target identity')
}

/** A nested SQLite savepoint makes any failure atomic even if an outer caller catches it. */
export function writeRecognizedTarget<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: RecognizedTargetInput) {
  const capturing = capturePhase(db)
  return db.transaction(tx => {
    positive(input.collectionId); positive(input.position.sequenceNo)
    for (const id of [input.position.pageId, input.position.pageRowNo, input.assignment.enterpriseId, input.assignment.commandReceiptId, input.row.enterpriseId]) if (id != null) positive(id)
    if (input.position.pageRowNo != null && input.position.pageId == null) throw new Error('Page row requires page')
    for (const field of ['enterpriseId', 'matchBasis', 'verificationStatus'] as const) {
      if (input.row[field] !== undefined && input.row[field] !== input.assignment[field]) throw new Error('Assignment payload conflict')
    }
    if (input.assignment.origin !== 'command' || !input.assignment.actor || !input.assignment.basis) throw new Error('Explicit command provenance required')
    if (input.row.sequenceNo !== input.position.sequenceNo) throw new Error('Observation position mismatch')
    const collection = tx.select().from(s.platformCollection).where(eq(s.platformCollection.id, input.collectionId)).get()
    if (!collection || collection.interface !== 'recognized_list') throw new Error('Recognized collection owner mismatch')
    if (input.position.pageId != null) {
      const page = tx.select().from(s.platformCollectionPage).where(eq(s.platformCollectionPage.id, input.position.pageId)).get()
      if (!page || page.collectionId !== collection.id) throw new Error('Page collection owner mismatch')
    }
    const raw = input.row.rawFields ?? null
    const plan = planPlatformObservation({ interface: 'recognized_list', relationKey: input.row.relationKey, rawFields: raw })
    // Payload identity includes explicit stored facts and provenance, not just version bytes.
    // Callers supply materialized validated rows, rather than partial reference commands.
    const inputBytes = Buffer.from(canonicalPlatformJson({ collectionId: collection.id, position: input.position, row: input.row, assignment: input.assignment }))
    const fingerprint = createHash('sha256').update(inputBytes).digest('hex')
    const existing = tx.select().from(s.platformBusinessObservation).where(and(eq(s.platformBusinessObservation.collectionId, collection.id), eq(s.platformBusinessObservation.sequenceNo, input.position.sequenceNo))).get()
    if (existing) {
      if (capturing) assertCapturedInput(tx, existing.id, inputBytes)
      for (const id of [existing.id, existing.recordId, existing.versionId]) if (id != null) positive(id)
      if (existing.inputFingerprint !== fingerprint || existing.projectionRuleVersion !== PLATFORM_PROJECTION_RULE) throw new Error('observation_payload_conflict')
      const alias = tx.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.observationId, existing.id)).get()
      if (!alias) throw new Error('Missing observation alias')
      positive(alias.oldId)
      return { observationId: existing.id, recordId: existing.recordId, versionId: existing.versionId, relationAlias: alias.oldId, reused: true }
    }
    const observationId = capturing ? nextObservationId(tx) : undefined
    if (capturing) captureFingerprintBasis(tx, observationId!, 'target-command-v1', inputBytes)
    let recordId: number | null = null, versionId: number | null = null
    const now = new Date().toISOString()
    if (plan.platformKey) {
      tx.insert(s.platformBusinessRecord).values({ interface: 'recognized_list', platformKey: plan.platformKey, identityRuleVersion: PLATFORM_PROJECTION_RULE }).onConflictDoNothing().run()
      const record = tx.select().from(s.platformBusinessRecord).where(and(eq(s.platformBusinessRecord.interface, 'recognized_list'), eq(s.platformBusinessRecord.platformKey, plan.platformKey))).get()!
      positive(record.id)
      if (record.identityRuleVersion !== PLATFORM_PROJECTION_RULE) throw new Error('projection_rule_conflict')
      recordId = record.id
      if (plan.canonicalRawJson && plan.contentHash) {
        let version = tx.select().from(s.platformBusinessRecordVersion).where(and(eq(s.platformBusinessRecordVersion.recordId, recordId), eq(s.platformBusinessRecordVersion.hashAlgorithm, PLATFORM_RAW_HASH_RULE), eq(s.platformBusinessRecordVersion.contentHash, plan.contentHash))).get()
        if (!version) {
          const archiveId = insertArchiveValue(tx, { storageClass: 'text', bytes: Buffer.from(plan.canonicalRawJson), createdAt: now })
          version = tx.insert(s.platformBusinessRecordVersion).values({ recordId, hashAlgorithm: PLATFORM_RAW_HASH_RULE, contentHash: plan.contentHash, canonicalRawJson: plan.canonicalRawJson }).returning().get()
          bindArchive(tx, { kind: 'version', ownerId: version.id, field: 'canonicalRawJson', archiveId })
          sealArchiveOwner(tx, { kind: 'version', ownerId: version.id })
          tx.update(s.platformBusinessRecordVersion).set({ canonicalArchiveId: archiveId }).where(eq(s.platformBusinessRecordVersion.id, version.id)).run()
          version = { ...version, canonicalArchiveId: archiveId }
        }
        positive(version.id)
        if (version.canonicalArchiveId != null) positive(version.canonicalArchiveId)
        if (version.canonicalRawJson !== plan.canonicalRawJson) throw new Error('platform_content_hash_conflict')
        const ref = tx.select({ bytes: s.platformArchiveValue.bytes, sealed: s.platformVersionArchiveRef.sealed, archiveId: s.platformArchiveValue.id }).from(s.platformVersionArchiveRef).innerJoin(s.platformArchiveValue, eq(s.platformArchiveValue.id, s.platformVersionArchiveRef.archiveId)).where(and(eq(s.platformVersionArchiveRef.ownerId, version.id), eq(s.platformVersionArchiveRef.field, 'canonicalRawJson'))).get()
        if (!ref || ref.sealed !== 1 || ref.archiveId !== version.canonicalArchiveId || !ref.bytes?.equals(Buffer.from(plan.canonicalRawJson))) throw new Error('Canonical archive conflict')
        versionId = version.id
        const fields = plan.recognizedProjection!
        const fidelity = plan.recognizedSourceFidelity!
        const projection = tx.select().from(s.platformRecognizedProjection).where(eq(s.platformRecognizedProjection.versionId, versionId)).get()
        if (projection) {
          positive(projection.id)
          if (projection.recordId !== recordId || projection.ruleVersion !== RECOGNIZED_PROJECTION_RULE || Object.entries(fields).some(([key, value]) => projection[key as keyof typeof fields] !== value)) throw new Error('recognized_projection_conflict')
          if (projection.sourceMaintenanceYearAbsent === null) {
            if (projection.sourceValidityDate !== null || projection.sourceMaintenanceBatch !== null) throw new Error('recognized_projection_conflict')
            // Legacy additive capture: normalized facts, version/hash and original bytes stay fixed.
            tx.update(s.platformRecognizedProjection).set(fidelity).where(eq(s.platformRecognizedProjection.id, projection.id)).run()
          } else if (projection.sourceValidityDate !== fidelity.sourceValidityDate || projection.sourceMaintenanceBatch !== fidelity.sourceMaintenanceBatch || projection.sourceMaintenanceYearAbsent !== fidelity.sourceMaintenanceYearAbsent) throw new Error('recognized_projection_conflict')
        } else positive(tx.insert(s.platformRecognizedProjection).values({ versionId, recordId, ...fields, ...fidelity, ruleVersion: RECOGNIZED_PROJECTION_RULE }).returning({ id: s.platformRecognizedProjection.id }).get().id)
      }
    }
    const observation = tx.insert(s.platformBusinessObservation).values({ id: observationId, collectionId: collection.id, ...input.position, sourceRelationKey: input.row.relationKey ?? null, recordId, versionId, identityState: plan.identityState, contentState: plan.contentState, keySource: plan.keySource, projectionRuleVersion: PLATFORM_PROJECTION_RULE, inputFingerprint: fingerprint, indexedAt: now }).returning().get()
    positive(observation.id)
    const assignment = { ...input.assignment, observationId: observation.id, revision: 1 }
    tx.insert(s.platformObservationAssignment).values(assignment).run()
    const rawText = raw === null ? null : JSON.stringify(raw)
    const rawArchive = insertArchiveValue(tx, rawText === null ? { storageClass: 'null', bytes: null, createdAt: now } : { storageClass: 'text', bytes: Buffer.from(rawText), createdAt: now })
    bindArchive(tx, { kind: 'observation', ownerId: observation.id, field: 'rawFields', archiveId: rawArchive })
    const sourceArchive = insertArchiveValue(tx, input.row.sourceText == null ? { storageClass: 'null', bytes: null, createdAt: now } : { storageClass: 'text', bytes: Buffer.from(input.row.sourceText), createdAt: now })
    bindArchive(tx, { kind: 'observation', ownerId: observation.id, field: 'sourceText', archiveId: sourceArchive })
    sealArchiveOwner(tx, { kind: 'observation', ownerId: observation.id })
    const title = raw?.rdjb
    const observationProjection = tx.insert(s.platformRecognizedProjection).values({ observationId: observation.id, basis: raw === null ? 'unavailable' : 'observation_reconciliation', parseState: raw === null ? 'absent' : 'valid', sourceArchiveId: rawArchive, ...(plan.recognizedProjection ?? parseRecognizedRecord(raw)), ...(raw === null ? { sourceValidityDate: null, sourceMaintenanceBatch: null, sourceMaintenanceYearAbsent: null } : parseRecognizedSourceFidelity(raw)), ruleVersion: RECOGNIZED_PROJECTION_RULE, sourceTitleKind: sourceValueKind(title), sourceTitleText: typeof title === 'string' ? title : null, sourceTitleNumberText: typeof title === 'number' ? String(title) : null, sourceTitleBoolean: typeof title === 'boolean' ? Number(title) : null, sourceTitleRuleVersion: 't05b-source-projections-v1', ...sourceFieldComparison('recognized_list', { province: input.row.province ?? null, status: input.row.status ?? null, batch: input.row.batch ?? null, declareKind: input.row.declareKind ?? null, appliedAt: input.row.appliedAt ?? null, awardBatchLabel: input.row.awardBatchLabel ?? null, year: input.row.year ?? null }, raw, raw === null ? 'absent' : 'valid') }).returning({ id: s.platformRecognizedProjection.id }).get()
    positive(observationProjection.id)
    const relationAlias = allocateLegacyAlias(tx, { kind: 'relation', observationId: observation.id })
    return { observationId: observation.id, recordId, versionId, relationAlias, reused: false }
  })
}
