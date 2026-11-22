import { collectionInsertValues, parseNewCollectionInput, positive, type NewCollectionTargetCommand } from './collection-command-input'
import { ensureProcessStoredReady } from './process-stored-catalog'
import { captureNewReconcileSlot,reconcileSlotWriteInstalled } from './reconcile-slot-write'
import { witnessInstalled } from './recognized-witness-catalog'
import { captureWitnessCollection } from './recognized-witness-write'
import { sqliteConnection } from './target-connection'
import { replayOptionalString } from './query-replay'
/** Atomic native collection creation, including source-owned observations and archives. */
import { requireCaptureForeignKeys } from './fingerprint-capture'
import { and,eq,sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { normalizeUscc } from '../domain'
import { targetSchema as s } from './target-schema'
import { writeApplyTarget, type ApplyTargetInput } from './apply-target-writer'
import { writeProcessTarget } from './process-target-writer'
import { writeRecognizedTarget } from './recognized-target-writer'
import { allocateLegacyAlias,insertArchiveValue,bindArchive,sealArchiveOwner } from './target-archive'

/** Savepoint remains atomic when composed inside a caller transaction which catches errors. */
export function writeNewCollectionTarget<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: NewCollectionTargetCommand) {
  requireCaptureForeignKeys(db)
  return db.transaction(tx => {
    ensureProcessStoredReady(sqliteConnection(tx))
    reconcileSlotWriteInstalled(sqliteConnection(tx))
    const q = parseNewCollectionInput(input)
    const e = q.collectionEvidence
    const existing = tx.select({ id: s.platformCollection.id }).from(s.platformCollection).where(and(eq(s.platformCollection.interface, q.interface), eq(s.platformCollection.queryKey, q.queryKey), eq(s.platformCollection.rdjb, replayOptionalString(q.rdjb) ?? ''), eq(s.platformCollection.queriedAt, q.queriedAt))).get()
    if (existing) throw new Error('collection_already_exists: new-only command; public reuse is deferred')
    // Same exact-USCC evidence gate as current import. Assignment is explicit, never inferred here.
    for (const [i, row] of (q.relations ?? []).entries()) {
      const a = input.assignments[i]!
      if (!e) continue
      const uscc = normalizeUscc(row.usccRaw)
      const owner = a.enterpriseId == null ? null : tx.select().from(s.enterprise).where(eq(s.enterprise.id, a.enterpriseId)).get()
      if (a.enterpriseId != null && (!owner || !uscc || owner.usccNorm !== uscc)) throw new Error('Explicit enterprise must match original row USCC')
      if (!['uscc', 'none'].includes(a.matchBasis)) throw new Error('Evidence identity requires exact USCC')
      if (a.verificationStatus === 'confirmed' && (!uscc || !tx.select({ id: s.enterprise.id }).from(s.enterprise).where(eq(s.enterprise.usccNorm, uscc)).get())) throw new Error('Confirmed relation requires exact-USCC enterprise')
    }
    const collection = tx.insert(s.platformCollection).values(collectionInsertValues(q, input.createdAt)).returning().get()
    const collectionId = positive(collection.id)
    const positions = new Map<number, ApplyTargetInput['position']>()
    let offset = 0
    for (const [ordinal, p] of (e?.pages ?? []).entries()) {
      const count = p.status === 'success' ? p.fetchedCount : 0
      const page = tx.insert(s.platformCollectionPage).values({
      collectionId,
      ordinal,
      source: p.source,
      rdjb: p.rdjb,
      pageNo: p.page,
      maxPage: p.maxPage ?? null,
      maxPagePresent:Object.hasOwn(p,'maxPage')?1:0,
      fetchedCount: p.fetchedCount,
      declaredTotal: p.declaredTotal,
      status: p.status,
      errorCode: p.error?.code ?? null,
      errorMessage: p.error?.message ?? null,
      sequenceStart: count ? offset + 1 : null,
      sequenceEnd: count ? offset + count : null,
      positionState: 'verified'
    }).returning().get()
      positive(page.id)
      for (let i = 1; i <= count; i++) positions.set(offset + i, { sequenceNo: offset + i, pageId: page.id, pageRowNo: i, positionState: 'verified' })
      offset += count
    }
    for (const [ordinal, u] of (e?.unfinished ?? []).entries()) tx.insert(s.platformCollectionUnfinished).values({ collectionId, ordinal, source: u.source, rdjb: u.rdjb, pageNo: u.page }).run()
    for (const name of ['name', 'uscc', 'combination', 'sqsj', 'rddqrq', 'whpcyear', 'whpc', 'szq', 'orderField', 'orderDirection'] as const) {
      const value = e?.effectiveConditions[name]
      tx.insert(s.platformCollectionCondition).values({ collectionId, name, valueKind: value === undefined ? 'absent' : 'text', textValue: value ?? null }).run()
    }
    // Ingest-only exact migration0027 JSON5/text-only/second-parse semantics, no old entity.
    const text = input.evidenceText
    const scope = tx.all<{ rdjb: string }>(sql`SELECT DISTINCT value rdjb FROM json_each(CASE WHEN json_valid(${text},2) THEN CASE WHEN json_valid(json_extract(${text},'$.titleScope.rdjb'),2) THEN json_extract(${text},'$.titleScope.rdjb') ELSE 'null' END ELSE 'null' END) WHERE type='text'`)
    for (const member of scope) tx.insert(s.platformQueryTitleScope).values({ collectionId, rdjb: member.rdjb }).run()
    const error = tx.get<{ invalid: number }>(sql`SELECT CASE WHEN ${text} IS NULL THEN 0 WHEN NOT json_valid(${text},2) THEN 1 WHEN json_extract(${text},'$.titleScope.rdjb') IS NULL THEN 0 WHEN NOT json_valid(json_extract(${text},'$.titleScope.rdjb'),2) THEN 1 ELSE 0 END invalid`)
    if (error?.invalid) tx.insert(s.platformQueryTitleScopeError).values({ collectionId }).run()
    for (const [field, value] of [['request', input.queryText], ['rawResponse', q.rawResponse ?? null], ['collectionEvidence', text]] as const) {
      const archiveId = positive(insertArchiveValue(tx, value === null ? { storageClass: 'null', bytes: null, createdAt: input.createdAt } : { storageClass: 'text', bytes: Buffer.from(value), createdAt: input.createdAt }))
      bindArchive(tx, { kind: 'collection', ownerId: collectionId, field, archiveId })
    }
    sealArchiveOwner(tx, { kind: 'collection', ownerId: collectionId })
    if(q.interface==='recognized_list'&&witnessInstalled(sqliteConnection(tx)))captureWitnessCollection(sqliteConnection(tx),collectionId)
    const queryAlias = allocateLegacyAlias(tx, { kind: 'query', collectionId })
    const observations = (q.relations ?? []).map((row, i) => {
      const args = { collectionId, ...(input.batchId === undefined ? {} : { batchId: input.batchId }), row, assignment: input.assignments[i]!, position: positions.get(row.sequenceNo) ?? { sequenceNo: row.sequenceNo, positionState: 'unknown' as const } }
      switch (q.interface) {
        case 'apply_list': return writeApplyTarget(tx, args)
        case 'business_list': return writeProcessTarget(tx, args)
        case 'recognized_list': return writeRecognizedTarget(tx, args)
      }
    })
    for (const o of observations) for (const id of [o.observationId, o.recordId, o.versionId, o.relationAlias]) if (id != null) positive(id)
    captureNewReconcileSlot(sqliteConnection(tx), collectionId)
    return { collectionId, queryAlias, observations }
  })
}

export { writeCollectionTarget, CollectionReplayError, type CollectionTargetCommand } from './collection-target-replay'
export type { NewCollectionTargetCommand } from './collection-command-input'
