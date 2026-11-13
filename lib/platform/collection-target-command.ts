import { ensureProcessStoredReady } from './process-stored-catalog'
import { captureNewReconcileSlot, reconcileSlotWriteInstalled } from './reconcile-slot-write'
import { witnessInstalled } from './recognized-witness-catalog'
import { captureWitnessCollection } from './recognized-witness-write'
import { sqliteConnection } from './target-connection'
import { replayOptionalString, platformQueryInsertMetadata } from './query-replay'
/** W4a: explicit offline 71606 complete-new-collection command. No public routing. */
import { requireCaptureForeignKeys } from './fingerprint-capture'
import { isDeepStrictEqual } from 'node:util'
import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { normalizeUscc } from '../domain'
import { normalizePlatformRelation } from './normalization'
import type { RosterImportPlatformQuery } from '../roster-import-client'
import { platformQueriesInputSchema } from '../../server/utils/roster-import-platform-schema'
import { FINAL_COLLECTION_SCOPE_VERSION } from '../../db/schema-phase'
import { targetSchema as s } from './target-schema'
import { platformEvidenceError, PLATFORM_PERSISTED_SOURCE, archiveQueryKey, recognizedStoredStatus, RDJB_TITLE_CODES } from './recognized-evidence'
import { writeApplyTarget, type ApplyTargetInput } from './apply-target-writer'
import { writeProcessTarget } from './process-target-writer'
import { writeRecognizedTarget } from './recognized-target-writer'
import { allocateLegacyAlias, insertArchiveValue, bindArchive, sealArchiveOwner } from './target-archive'

export type NewCollectionTargetCommand = {
  /** Original UTF-8 JSON query command, retained verbatim. Not a reuse/reference command. */
  queryText: string
  /** Original evidence JSON text, not regenerated from normalized rows. NULL when absent. */
  evidenceText: string | null
  createdAt: string
  /** Existing caller transaction batch; not a second command ledger. */
  batchId?: number
  assignments: ApplyTargetInput['assignment'][]
}
function positive(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid target identity')
  return value
}
function queryInput(input: NewCollectionTargetCommand): RosterImportPlatformQuery {
  if (input.batchId !== undefined) positive(input.batchId)
  const original: unknown = JSON.parse(input.queryText)
  platformQueriesInputSchema.parse([original])
  // The public Zod schema validates shape; retain original own raw JSON keys and types.
  const q = original as RosterImportPlatformQuery
  if (q.reuseExisting) throw new Error('Only complete new collections; reference reuse is deferred')
  if (!q.queryKey.trim() || !q.queriedAt.trim()) throw new Error('Query key and queriedAt required')
  const e = q.collectionEvidence
  if (!e && q.rawResponse == null && q.interface !== 'recognized_list') throw new Error('Legacy reference sentinel; reference reuse is deferred')
  if (!isDeepStrictEqual(e ?? null, input.evidenceText === null ? null : JSON.parse(input.evidenceText))) throw new Error('Evidence bytes do not match command')
  if (q.interface === 'recognized_list' && !e) throw new Error('Recognized collection requires original evidence')
  if (e) {
    const error = platformEvidenceError(e)
    if (error) throw new Error(error)
    const title = e.titleScope.rdjb.length === 1 ? RDJB_TITLE_CODES[e.titleScope.rdjb[0]!] : null
    const subjectKey = e.effectiveConditions.uscc ?? (e.effectiveConditions.name ? `name:${e.effectiveConditions.name}` : null)
    const keyMismatch = (subjectKey !== null && q.queryKey !== subjectKey) || ((e.rawData || e.dataRows) && q.queryKey !== archiveQueryKey(e))
    if (q.interface !== PLATFORM_PERSISTED_SOURCE[e.source] || keyMismatch || q.queriedAt !== e.queriedAt || (q.rdjb ?? '') !== e.titleScope.rdjb.join(',') || (q.titleCode ?? null) !== title || q.status !== recognizedStoredStatus(e)) throw new Error('Collection identity/status/title/source mismatch')
    if ((q.relations ?? []).length !== e.rows.length) throw new Error('Every original source row requires one relation')
    for (const [i, row] of (q.relations ?? []).entries()) {
      const raw = e.rows[i]!
      const selected = e.dataRows ? e.dataRows[i] : e.rawData ? e.rawData.rows[i] : raw
      if (row.sequenceNo !== i + 1 || !isDeepStrictEqual(row.rawFields, selected) || (row.relationKey ?? null) !== (raw.id ?? null) || (row.nameRaw ?? null) !== (raw.qymc ?? null) || (row.usccRaw ?? null) !== (raw.tyshxydm ?? null)) throw new Error('Relation sequence/raw fields/identity mismatch')
      if (q.interface === 'recognized_list' && [row.aliasNameRaw, row.province, row.status, row.batch, row.declareKind, row.appliedAt, row.awardBatchLabel, row.year].some(v => v != null)) throw new Error('Recognized fields must retain original meanings')
    }
  }
  const rows = q.relations ?? []
  if (rows.length !== input.assignments.length) throw new Error('Explicit assignment required for every row')
  for (const [i, row] of rows.entries()) {
    const normalized = normalizePlatformRelation(q.interface, row)
    if (normalized.normalizationConflicts.length) throw new Error('platform_field_conflict')
    positive(row.sequenceNo)
    if (row.sequenceNo !== i + 1) throw new Error('Complete materialized sequence required')
    const a = input.assignments[i]!
    for (const id of [row.enterpriseId, a.enterpriseId, a.commandReceiptId]) if (id != null) positive(id)
    if (a.origin !== 'command' || !a.actor || !a.basis) throw new Error('Explicit command provenance required')
    for (const field of ['enterpriseId', 'matchBasis', 'verificationStatus'] as const) if (row[field] !== undefined && row[field] !== a[field]) throw new Error('Assignment payload conflict')
  }
  return q
}

/** Savepoint remains atomic when composed inside a caller transaction which catches errors. */
export function writeNewCollectionTarget<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: NewCollectionTargetCommand) {
  requireCaptureForeignKeys(db)
  return db.transaction(tx => {
    if (tx.get<{ user_version: number }>(sql`PRAGMA user_version`)?.user_version !== FINAL_COLLECTION_SCOPE_VERSION && tx.get<{ user_version: number }>(sql`PRAGMA user_version`)?.user_version !== 71607 && tx.get<{ user_version: number }>(sql`PRAGMA user_version`)?.user_version !== 71608 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version !== 71609 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version !==71610 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71611 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71612 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71613) throw new Error('Explicit 71606 target required')
    ensureProcessStoredReady(sqliteConnection(tx))
    reconcileSlotWriteInstalled(sqliteConnection(tx))
    const q = queryInput(input)
    if(tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version===71608 && q.interface!=='apply_list')throw new Error('71608 command supports apply_list only')
    const e = q.collectionEvidence, metadata = platformQueryInsertMetadata(q)
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
    const collection = tx.insert(s.platformCollection).values({
      interface: q.interface,
      queryKey: q.queryKey,
      rdjb: replayOptionalString(q.rdjb) ?? '',
      titleCode: metadata.titleCode,
      queriedAt: q.queriedAt,
      createdAt: input.createdAt,
      status: metadata.status,
      failureReason: metadata.failureReason,
      source: e?.source ?? null,
      evidenceStatus: e?.status ?? null,
      completedAt: e?.completedAt ?? null,
      completeness: e?.completeness ?? 'unknown',
      fullRange: e ? Number(e.fullRange) : null,
      fetchedCount: e?.fetchedCount ?? null,
      declaredTotal: e?.declaredTotal ?? null,
      scopeMode: e?.titleScope.mode ?? null,
      provenanceState: e ? 'captured' : 'unknown',
      parseState: e ? 'valid' : 'absent',
      ruleVersion: 'w4a-new-collection-v1',
      errorCode: e?.error?.code ?? null,
      errorMessage: e?.error?.message ?? null,
      maxRequests: e?.limits.maxRequests ?? null,
      maxRows: e?.limits.maxRows ?? null,
      maxDurationMs: e?.limits.maxDurationMs ?? null,
      pageSize: e?.limits.pageSize ?? null
    }).returning().get()
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
