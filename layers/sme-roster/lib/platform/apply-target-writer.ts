import { reconcileStoredApplyObservation, requireReconcileObservationWrite } from './reconcile-slot-write'
import { captureRelationEvidence } from './relation-evidence-snapshot'
import { candidateObservationValues, verifyCandidateObservation } from './candidate-scope-write'
import { sqliteConnection } from './target-connection'
import { storedApplyProjection } from './apply-stored-schema'
import { applyMaterialization, capturedApplyValues, APPLY_MATERIALIZATION_RULE } from './apply-materialization'
import { verifyFingerprint } from './fingerprint-verifier'
/** W1a explicit finalized-target transaction seam. No public import routing. */
import { requireFingerprintCapture, nextObservationId, captureFingerprintBasis, assertCapturedInput } from './fingerprint-capture'
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { RosterImportRelation } from '../roster-import-client'
import { targetSchema as s } from './target-schema'
import { parseApplyRecord, APPLY_PROJECTION_RULE } from './apply-record'
import { canonicalPlatformJson, planPlatformObservation, PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE } from './observation-plan'
import { sourceFieldComparison, sourceValueKind } from './source-extraction'
import { allocateLegacyAlias, insertArchiveValue, bindArchive, sealArchiveOwner } from './target-archive'

type Assignment = Omit<typeof s.platformObservationAssignment.$inferInsert, 'observationId' | 'revision'>
export type ApplyTargetInput = {
  collectionId: number
  /** Existing import ledger provenance, supplied only by the caller coordinator. */
  batchId?: number
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
export function writeApplyTarget<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: ApplyTargetInput) {
  requireFingerprintCapture(db)
  const rawText = input.row.rawFields == null ? null : JSON.stringify(input.row.rawFields)
  const materialized = applyMaterialization(db,input.row,rawText)
  if(((input.assignment.nameRaw??null)!==materialized.nameRaw || (input.assignment.usccRaw??null)!==materialized.usccRaw)) throw new Error('apply_stored_conflict: revision1 materialization mismatch')
  return db.transaction(tx => {
    // S requires revision1 before observation INSERT; its incoming FK is immediate.
    // Defer within this transaction, never disable FK enforcement or reset before COMMIT.
    tx.run(sql`PRAGMA defer_foreign_keys=ON`)
    positive(input.collectionId); if(input.batchId!==undefined)positive(input.batchId); positive(input.position.sequenceNo)
    if (input.assignment.origin !== 'command' || !input.assignment.actor || !input.assignment.basis) throw new Error('Explicit command provenance required')
    if (input.row.sequenceNo !== input.position.sequenceNo) throw new Error('Observation position mismatch')
    const collection = tx.select().from(s.platformCollection).where(eq(s.platformCollection.id, input.collectionId)).get()
    if (!collection || collection.interface !== 'apply_list') throw new Error('Apply collection owner mismatch')
    if (input.position.pageId != null) {
      const page = tx.select().from(s.platformCollectionPage).where(eq(s.platformCollectionPage.id, input.position.pageId)).get()
      if (!page || page.collectionId !== collection.id) throw new Error('Page collection owner mismatch')
    }
    const raw = input.row.rawFields ?? null
    const plan = planPlatformObservation({ interface: 'apply_list', relationKey: input.row.relationKey, rawFields: raw })
    // Payload identity includes explicit stored facts and provenance, not just version bytes.
    // Callers supply materialized validated rows, rather than partial reference commands.
    const inputBytes = Buffer.from(canonicalPlatformJson({ collectionId: collection.id, position: input.position, row: input.row, assignment: input.assignment, ...(input.batchId === undefined ? {} : { batchId: input.batchId }) }))
    const fingerprint = createHash('sha256').update(inputBytes).digest('hex')
    const existing = tx.select().from(s.platformBusinessObservation).where(and(eq(s.platformBusinessObservation.collectionId, collection.id), eq(s.platformBusinessObservation.sequenceNo, input.position.sequenceNo))).get()
    requireReconcileObservationWrite(sqliteConnection(tx), collection.id, !!existing)
    if (existing) {
      assertCapturedInput(tx, existing.id, inputBytes)
      if (existing.inputFingerprint !== fingerprint || existing.projectionRuleVersion !== PLATFORM_PROJECTION_RULE) throw new Error('observation_payload_conflict')
      const alias = tx.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.observationId, existing.id)).get()
      if (!alias) throw new Error('Missing observation alias')
      verifyCandidateObservation(tx, existing.id)
      verifyFingerprint(sqliteConnection(tx),{observationId:existing.id,collectionId:existing.collectionId,relationAlias:alias.oldId})
      return { observationId: existing.id, recordId: existing.recordId, versionId: existing.versionId, relationAlias: alias.oldId, reused: true, materializationRule:APPLY_MATERIALIZATION_RULE }
    }
    const observationId = nextObservationId(tx)
    captureFingerprintBasis(tx, observationId, 'target-command-v1', inputBytes)
    const { recordId, versionId, now } = ensureApplyTargetContent(tx, plan)
    tx.insert(s.platformObservationAssignment).values({...input.assignment,observationId,revision:1}).run()
    const candidateValues = candidateObservationValues(tx, collection, input.position.sequenceNo)
    const observation = tx.insert(s.platformBusinessObservation).values({ ...candidateValues, applyExactOwnerId:observationId,applyExactState:'captured' as const,applySqlFactTitleState:'captured' as const, id: observationId, collectionId: collection.id, ...input.position, sourceRelationKey: materialized.sourceRelationKey, recordId, versionId, identityState: plan.identityState, contentState: plan.contentState, keySource: plan.keySource, projectionRuleVersion: PLATFORM_PROJECTION_RULE, inputFingerprint: fingerprint, indexedAt: now, batchId: input.batchId ?? null }).returning().get()
    const assignment = { ...input.assignment, observationId: observation.id, revision: 1 }
    const rawArchive = insertArchiveValue(tx, rawText === null ? { storageClass: 'null', bytes: null, createdAt: now } : { storageClass: 'text', bytes: Buffer.from(rawText), createdAt: now })
    bindArchive(tx, { kind: 'observation', ownerId: observation.id, field: 'rawFields', archiveId: rawArchive })
    const sourceArchive = insertArchiveValue(tx, input.row.sourceText == null ? { storageClass: 'null', bytes: null, createdAt: now } : { storageClass: 'text', bytes: Buffer.from(input.row.sourceText), createdAt: now })
    bindArchive(tx, { kind: 'observation', ownerId: observation.id, field: 'sourceText', archiveId: sourceArchive })
    const relationAlias = allocateLegacyAlias(tx, { kind: 'relation', observationId: observation.id })
    captureRelationEvidence(tx,{observationId:observation.id,collectionId:collection.id,relationAlias,row:input.row,assignment,createdAt:now})
    sealArchiveOwner(tx, { kind: 'observation', ownerId: observation.id })
    const title = raw?.rdjb
    tx.insert(storedApplyProjection).values({ ...capturedApplyValues(materialized), observationId: observation.id, basis: raw === null ? 'unavailable' : 'observation_reconciliation', parseState: raw === null ? 'absent' : 'valid', sourceArchiveId: rawArchive, ...(plan.applyRecord ?? parseApplyRecord(raw)), ruleVersion: APPLY_PROJECTION_RULE, sourceTitleKind: sourceValueKind(title), sourceTitleText: typeof title === 'string' ? title : null, sourceTitleNumberText: typeof title === 'number' ? String(title) : null, sourceTitleBoolean: typeof title === 'boolean' ? Number(title) : null, sourceTitleRuleVersion: 't05b-source-projections-v1', ...sourceFieldComparison('apply_list', reconcileStoredApplyObservation(sqliteConnection(tx), observation.id), raw, raw === null ? 'absent' : 'valid') }).run()
    return { observationId: observation.id, recordId, versionId, relationAlias, reused: false, materializationRule:APPLY_MATERIALIZATION_RULE }
  })
}

/** Source-owned content completion shared with ordinary full-row target replay. */
export function ensureApplyTargetContent<S extends Record<string, unknown>>(tx: BetterSQLite3Database<S>, plan: ReturnType<typeof planPlatformObservation>, replay = false) {
    let recordId: number | null = null, versionId: number | null = null
    const now = new Date().toISOString()
    if (plan.platformKey) {
      if (!replay || !tx.select({id:s.platformBusinessRecord.id}).from(s.platformBusinessRecord).where(and(eq(s.platformBusinessRecord.interface, 'apply_list'),eq(s.platformBusinessRecord.platformKey,plan.platformKey))).get()) tx.insert(s.platformBusinessRecord).values({ interface: 'apply_list', platformKey: plan.platformKey, identityRuleVersion: PLATFORM_PROJECTION_RULE }).onConflictDoNothing().run()
      const record = tx.select().from(s.platformBusinessRecord).where(and(eq(s.platformBusinessRecord.interface, 'apply_list'), eq(s.platformBusinessRecord.platformKey, plan.platformKey))).get()!
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
        if (version.canonicalRawJson !== plan.canonicalRawJson) throw new Error('platform_content_hash_conflict')
        const ref = tx.select({ bytes: s.platformArchiveValue.bytes, sealed: s.platformVersionArchiveRef.sealed, archiveId: s.platformArchiveValue.id }).from(s.platformVersionArchiveRef).innerJoin(s.platformArchiveValue, eq(s.platformArchiveValue.id, s.platformVersionArchiveRef.archiveId)).where(and(eq(s.platformVersionArchiveRef.ownerId, version.id), eq(s.platformVersionArchiveRef.field, 'canonicalRawJson'))).get()
        if (!ref || ref.sealed !== 1 || ref.archiveId !== version.canonicalArchiveId || !ref.bytes?.equals(Buffer.from(plan.canonicalRawJson))) throw new Error('Canonical archive conflict')
        versionId = version.id
        const fields = plan.applyRecord!
        const projection = tx.select().from(s.platformApplyProjection).where(eq(s.platformApplyProjection.versionId, versionId)).get()
        if (projection) {
          if (projection.recordId !== recordId || projection.ruleVersion !== APPLY_PROJECTION_RULE || Object.entries(fields).some(([key, value]) => projection[key as keyof typeof fields] !== value)) throw new Error('apply_projection_conflict')
        } else tx.insert(s.platformApplyProjection).values({ versionId, recordId, ...fields, ruleVersion: APPLY_PROJECTION_RULE }).run()
      }
    }
    return { recordId, versionId, now }
}
