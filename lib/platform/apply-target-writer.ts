/** W1a explicit finalized-target transaction seam. No public import routing. */
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
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
  position: Pick<typeof s.platformBusinessObservation.$inferInsert, 'sequenceNo' | 'pageId' | 'pageRowNo' | 'positionState'>
  /** Already validated by the current import contract. Raw JSON is serialized once here. */
  row: RosterImportRelation
  /** Explicit decision provenance; no inferred owner or historical confirmation time. */
  assignment: Assignment
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function positive(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid target identity')
}

/** A nested SQLite savepoint makes any failure atomic even if an outer caller catches it. */
export function writeApplyTarget<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: ApplyTargetInput) {
  return db.transaction(tx => {
    positive(input.collectionId); positive(input.position.sequenceNo)
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
    const fingerprint = digest(canonicalPlatformJson({ collectionId: collection.id, position: input.position, row: input.row, assignment: input.assignment }))
    const existing = tx.select().from(s.platformBusinessObservation).where(and(eq(s.platformBusinessObservation.collectionId, collection.id), eq(s.platformBusinessObservation.sequenceNo, input.position.sequenceNo))).get()
    if (existing) {
      if (existing.inputFingerprint !== fingerprint || existing.projectionRuleVersion !== PLATFORM_PROJECTION_RULE) throw new Error('observation_payload_conflict')
      const alias = tx.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.observationId, existing.id)).get()
      if (!alias) throw new Error('Missing observation alias')
      return { observationId: existing.id, recordId: existing.recordId, versionId: existing.versionId, relationAlias: alias.oldId, reused: true }
    }
    let recordId: number | null = null, versionId: number | null = null
    const now = new Date().toISOString()
    if (plan.platformKey) {
      tx.insert(s.platformBusinessRecord).values({ interface: 'apply_list', platformKey: plan.platformKey, identityRuleVersion: PLATFORM_PROJECTION_RULE }).onConflictDoNothing().run()
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
    const observation = tx.insert(s.platformBusinessObservation).values({ collectionId: collection.id, ...input.position, sourceRelationKey: input.row.relationKey ?? null, recordId, versionId, identityState: plan.identityState, contentState: plan.contentState, keySource: plan.keySource, projectionRuleVersion: PLATFORM_PROJECTION_RULE, inputFingerprint: fingerprint, indexedAt: now }).returning().get()
    const assignment = { ...input.assignment, observationId: observation.id, revision: 1 }
    tx.insert(s.platformObservationAssignment).values(assignment).run()
    const rawText = raw === null ? null : JSON.stringify(raw)
    const rawArchive = insertArchiveValue(tx, rawText === null ? { storageClass: 'null', bytes: null, createdAt: now } : { storageClass: 'text', bytes: Buffer.from(rawText), createdAt: now })
    bindArchive(tx, { kind: 'observation', ownerId: observation.id, field: 'rawFields', archiveId: rawArchive })
    const sourceArchive = insertArchiveValue(tx, input.row.sourceText == null ? { storageClass: 'null', bytes: null, createdAt: now } : { storageClass: 'text', bytes: Buffer.from(input.row.sourceText), createdAt: now })
    bindArchive(tx, { kind: 'observation', ownerId: observation.id, field: 'sourceText', archiveId: sourceArchive })
    sealArchiveOwner(tx, { kind: 'observation', ownerId: observation.id })
    const title = raw?.rdjb
    tx.insert(s.platformApplyProjection).values({ observationId: observation.id, basis: raw === null ? 'unavailable' : 'observation_reconciliation', parseState: raw === null ? 'absent' : 'valid', sourceArchiveId: rawArchive, ...(plan.applyRecord ?? parseApplyRecord(raw)), ruleVersion: APPLY_PROJECTION_RULE, sourceTitleKind: sourceValueKind(title), sourceTitleText: typeof title === 'string' ? title : null, sourceTitleNumberText: typeof title === 'number' ? String(title) : null, sourceTitleBoolean: typeof title === 'boolean' ? Number(title) : null, sourceTitleRuleVersion: 't05b-source-projections-v1', ...sourceFieldComparison('apply_list', { province: input.row.province ?? null, status: input.row.status ?? null, batch: input.row.batch ?? null, declareKind: input.row.declareKind ?? null, appliedAt: input.row.appliedAt ?? null, awardBatchLabel: input.row.awardBatchLabel ?? null, year: input.row.year ?? null }, raw, raw === null ? 'absent' : 'valid') }).run()
    const relationAlias = allocateLegacyAlias(tx, { kind: 'relation', observationId: observation.id })
    return { observationId: observation.id, recordId, versionId, relationAlias, reused: false }
  })
}
