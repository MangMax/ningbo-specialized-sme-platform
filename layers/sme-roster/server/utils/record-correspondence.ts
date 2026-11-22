import { type CorrespondenceRead, type DecisionLookup, type CorrespondenceRequest, type CorrespondencePlan, validatedRequest, fail, hash, buildRecordCorrespondencePlan, type CorrespondenceReceipt, recordCorrespondenceMutations, requestedCorrespondenceSources, type SourceReference, type ReadSources, type StoredCorrespondence, projectObservedCorrespondence } from './record-correspondence-model'
import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { correspondenceRefValidity, createCorrespondenceRefValidityReader } from './record-correspondence-ref-validity'
import { correspondenceColumns, correspondenceTable, externalRelationColumn } from './record-correspondence-store'
import { readCorrespondenceTargetSources } from './record-correspondence-target-sources'
import { ensureBatchRow, findBatchByKey } from './roster-batch-ledger'
type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx
export type CorrespondenceAudit = typeof schema.recordCorrespondenceAudit.$inferSelect
export type CorrespondenceFilter = Partial<Pick<CorrespondenceRead, 'id' | 'eventId' | 'relationId' | 'exportRowId' | 'enterpriseId' | 'titleCode' | 'status' | 'type' | 'role' | 'ruleVersion'>> & { anyEventId?: number }
function decisionLookup(db: Executor): DecisionLookup {
  const table = correspondenceTable(db)
  return {
    byId: id => db.select(correspondenceColumns(db)).from(table).where(eq(schema.recordCorrespondence.id, id)).get(),
    byEdge: key => db.select(correspondenceColumns(db)).from(table).where(eq(schema.recordCorrespondence.edgeKey, key)).get(),
  }
}
export function preflightRecordCorrespondences(db: Db, request: CorrespondenceRequest): CorrespondencePlan {
  validatedRequest(request)
  const old = findBatchByKey(db, request.idempotencyKey)
  if (old && (old.sourceKind !== 'correspondence_decision' || old.sourceIdentity !== request.sourceIdentity)) fail('idempotency_conflict', 'Idempotency key belongs to another source')
  const previous = old?.preflightResult as (CorrespondencePlan & { requestHash: string }) | null
  if (previous && previous.requestHash !== hash(request)) fail('idempotency_conflict', 'Idempotency key belongs to a different request')
  if (old?.status === 'committed' && previous) return { batchId: old.id, batchStatus: 'committed', planHash: previous.planHash, impact: previous.impact, targets: previous.targets }
  const plan = buildRecordCorrespondencePlan(decisionLookup(db), request, observeRequestSources(db, request))
  const batch = ensureBatchRow(db, { idempotencyKey: request.idempotencyKey, sourceKind: 'correspondence_decision', sourceIdentity: request.sourceIdentity })
  const result = { batchId: batch.id, batchStatus: 'preflight' as const, ...plan }
  const updated = db.update(schema.importBatch).set({ preflightResult: result, error: null })
    .where(and(eq(schema.importBatch.id, batch.id), eq(schema.importBatch.status, 'preflight'))).run()
  if (updated.changes === 0) {
    const current = findBatchByKey(db, request.idempotencyKey)
    const bound = current?.preflightResult as (CorrespondencePlan & { requestHash: string }) | null
    if (current?.status === 'committed' && bound?.requestHash === hash(request)) {
      return { batchId: current.id, batchStatus: 'committed', planHash: bound.planHash, impact: bound.impact, targets: bound.targets }
    }
    fail('idempotency_conflict', 'Batch changed during preflight')
  }
  return { batchId: batch.id, batchStatus: 'preflight', planHash: plan.planHash, impact: plan.impact, targets: plan.targets }
}
export function commitRecordCorrespondences(db: Db, request: CorrespondenceRequest, planHash: string): CorrespondenceReceipt {
  validatedRequest(request)
  const batch = findBatchByKey(db, request.idempotencyKey)
  if (!batch) fail('plan_mismatch', 'Preflight batch not found for source')
  if (batch.sourceKind !== 'correspondence_decision' || batch.sourceIdentity !== request.sourceIdentity) fail('idempotency_conflict', 'Idempotency key belongs to another source')
  const stored = batch.preflightResult as (CorrespondencePlan & { requestHash: string }) | null
  if (!stored) fail('plan_mismatch', 'No bound preflight plan')
  if (stored.requestHash !== hash(request)) fail('idempotency_conflict', 'Idempotency key belongs to a different request')
  if (stored.planHash !== planHash) fail('plan_mismatch', 'Submitted plan hash differs')
  if (batch.status === 'committed') return batch.summary as CorrespondenceReceipt
  return db.transaction((tx) => {
    const observed = observeRequestSources(tx, request)
    const current = buildRecordCorrespondencePlan(decisionLookup(tx), request, observed)
    if (current.planHash !== planHash) fail('plan_mismatch', 'Bound targets or source evidence changed')
    const at = new Date().toISOString()
    const correspondenceIds: number[] = []
    for (const mutation of recordCorrespondenceMutations(decisionLookup(tx), request, observed, batch.id, at)) {
      const table = correspondenceTable(tx)
      let id: number
      if (mutation.type === 'insert') {
        id = tx.insert(table).values(mutation.changes).returning({ id: table.id }).get().id
      } else {
        const row = mutation.row
        id = row.id
        const updated = tx.update(table).set(mutation.changes).where(and(eq(table.id, id), eq(table.revision, row.revision),
          mutation.candidateOnly ? eq(table.status, 'candidate') : undefined)).run()
        if (updated.changes !== 1) fail('stale_revision', 'Correspondence revision changed')
      }
      for (const audit of mutation.audits) tx.insert(schema.recordCorrespondenceAudit).values({ ...audit, correspondenceId: id }).run()
      correspondenceIds.push(id)
    }
    const receipt: CorrespondenceReceipt = { batchId: batch.id, planHash, impact: current.impact, correspondenceIds }
    tx.update(schema.importBatch).set({ status: 'committed', summary: receipt, itemResults: correspondenceIds, committedAt: at, error: null }).where(eq(schema.importBatch.id, batch.id)).run()
    return receipt
  })
}
export function readRecordCorrespondenceBatch(db: Db, idempotencyKey: string): CorrespondenceReceipt | null {
  const batch = findBatchByKey(db, idempotencyKey)
  return batch?.sourceKind === 'correspondence_decision' && batch.status === 'committed' ? batch.summary as CorrespondenceReceipt : null
}
function correspondenceWhere(db: Db, filter: CorrespondenceFilter) {
  const { anyEventId, ...exact } = filter
  const entries = Object.entries(exact).filter(([, value]) => value != null) as [keyof typeof exact, string | number][]
  return and(...entries.map(([key, value]) => sql`${key === 'relationId' ? externalRelationColumn(db) : correspondenceTable(db)[key]} = ${value}`),
    anyEventId == null ? undefined : or(eq(schema.recordCorrespondence.eventId, anyEventId), eq(schema.recordCorrespondence.predecessorEventId, anyEventId)))
}
function idChunks(values: Array<number | null>) {
  const ids = [...new Set(values.filter((id): id is number => id != null))]
  return Array.from({ length: Math.ceil(ids.length / 400) }, (_, i) => ids.slice(i * 400, (i + 1) * 400))
}
function observeRequestSources(db: Db, request: CorrespondenceRequest) {
  const stored = idChunks(request.operations.flatMap(op => 'correspondenceId' in op ? [op.correspondenceId] : [])).flatMap(ids => db.select(correspondenceColumns(db)).from(correspondenceTable(db)).where(inArray(correspondenceTable(db).id, ids)).all())
  return observeReadSources(db, requestedCorrespondenceSources(request, stored))
}
function observeReadSources(db: Db, rows: SourceReference[]): ReadSources {
  const sourceBound = rows.filter(row => row.status === 'confirmed' || row.status === 'candidate')
  const events = idChunks(sourceBound.flatMap(r => [r.eventId, r.predecessorEventId])).flatMap(ids => db.select({ event: schema.recordEvent, record: schema.record, enterprise: schema.enterprise }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.recordEvent.recordId, schema.record.id)).innerJoin(schema.enterprise, eq(schema.record.enterpriseId, schema.enterprise.id)).where(inArray(schema.recordEvent.id, ids)).all())
  const targetRelations = readCorrespondenceTargetSources(db, sourceBound.flatMap(r => r.relationId === null ? [] : [r.relationId]))
  const relations = targetRelations.map(r => r.relation)

  const exports = idChunks(sourceBound.map(r => r.exportRowId)).flatMap(ids => db.select({ exportRow: schema.platformExportRow, exportBatch: schema.platformExportBatch }).from(schema.platformExportRow).innerJoin(schema.platformExportBatch, eq(schema.platformExportRow.batchId, schema.platformExportBatch.id)).where(inArray(schema.platformExportRow.id, ids)).all())
  const enterprises = idChunks([...sourceBound.map(r => r.enterpriseId), ...relations.map(r => r.enterpriseId)]).flatMap(ids => db.select().from(schema.enterprise).where(inArray(schema.enterprise.id, ids)).all())
  const titles = [...new Set(sourceBound.map(r => r.titleCode))]
  const storedTitles = titles.length ? db.select({ code: schema.title.code }).from(schema.title).where(inArray(schema.title.code, titles)).all() : []
  const evidence = idChunks(events.map(r => r.event.id)).flatMap(ids => db.select().from(schema.recordEvidence).where(inArray(schema.recordEvidence.recordEventId, ids)).orderBy(asc(schema.recordEvidence.id)).all())
  const paths = [...new Set(evidence.map(r => r.sourceFile))]
  const files = Array.from({ length: Math.ceil(paths.length / 400) }, (_, i) => paths.slice(i * 400, (i + 1) * 400)).flatMap(paths => db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, bytes: schema.storedFile.bytes, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt }).from(schema.storedFile).where(inArray(schema.storedFile.relPath, paths)).all())
  const filesByPath = new Map(files.map(r => [r.relPath, r]))
  return { events: new Map(events.map(r => [r.event.id, r])), relations: new Map(targetRelations.map(r => [r.relation.id, r])), exports: new Map(exports.map(r => [r.exportRow.id, r])), enterprises: new Map(enterprises.map(r => [r.id, r])), titles: new Set(storedTitles.map(r => r.code)), evidence: Map.groupBy(evidence.map(evidence => ({ evidence, storedFile: filesByPath.get(evidence.sourceFile) ?? null })), r => r.evidence.recordEventId) }
}
function readCorrespondences(db: Db, rows: StoredCorrespondence[]) {
  const observed = observeReadSources(db, rows)
  return rows.map(row => projectObservedCorrespondence(row, observed))
}
/** Scoped comparison adapter; use #85's batched source validity reader. */
export function readScopedRecordCorrespondences(db: Db, rows: StoredCorrespondence[]): CorrespondenceRead[] {
  return readCorrespondences(db, rows)
}
export function listRecordCorrespondences(db: Db, filter: CorrespondenceFilter = {}): CorrespondenceRead[] {
  return readCorrespondences(db, db.select(correspondenceColumns(db)).from(correspondenceTable(db)).where(correspondenceWhere(db, filter)).orderBy(asc(schema.recordCorrespondence.id)).all())
}
export function getRecordCorrespondence(db: Db, id: number): CorrespondenceRead | null {
  const row = db.select(correspondenceColumns(db)).from(correspondenceTable(db)).where(eq(schema.recordCorrespondence.id, id)).get()
  return row ? readCorrespondences(db, [row])[0]! : null
}
export interface CorrespondencePaging { page: number; pageSize: number }
export function pageRecordCorrespondences(db: Db, filter: CorrespondenceFilter, paging: CorrespondencePaging) {
  const t = correspondenceTable(db)
  // Public pages omit these private fields; only confirmed rows need provenance for revalidation.
  const columns = { ...correspondenceColumns(db), targetIdentity: sql`'{}'`.mapWith(t.targetIdentity), provenance: sql`case when ${t.status} = 'confirmed' then ${t.provenance} else '{}' end`.mapWith(t.provenance) }
  const where = correspondenceWhere(db, filter)
  const total = db.select({ total: count() }).from(correspondenceTable(db)).where(where).get()!.total
  const rows = readCorrespondences(db, db.select(columns).from(correspondenceTable(db)).where(where).orderBy(asc(schema.recordCorrespondence.id))
    .limit(paging.pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER, (paging.page - 1) * paging.pageSize)).all())
  return { rows, total, ...paging }
}
/** Reverse links expose only these columns; candidate provenance is never needed. */
function correspondenceRefColumns(db: Db) {
  const t = correspondenceTable(db)
  return { id: t.id, type: t.type, role: t.role, status: t.status, eventId: t.eventId, predecessorEventId: t.predecessorEventId, relationId: externalRelationColumn(db), exportRowId: t.exportRowId, enterpriseId: t.enterpriseId, titleCode: t.titleCode, revision: t.revision }
}
export type CorrespondenceRefRow = Pick<StoredCorrespondence, keyof ReturnType<typeof correspondenceRefColumns>>
export function listRecordCorrespondencesForIds(db: Db, ids: number[]) {
  return readCorrespondences(db, idChunks(ids).flatMap(ids => db.select(correspondenceColumns(db)).from(correspondenceTable(db)).where(inArray(correspondenceTable(db).id, ids)).all()))
}
function refsWithCurrentValidity(db: Db, refs: CorrespondenceRefRow[], readValidity = (ids: number[]) => correspondenceRefValidity(db, ids)) {
  const validity = new Map(idChunks(refs.filter(r => r.status === 'confirmed').map(r => r.id)).flatMap(ids => [...readValidity(ids)]))
  return refs.map(row => ({ ...row, requiresRevalidation: validity.get(row.id) ?? false }))
}
export function listRecordCorrespondenceRefs(db: Db, filter: CorrespondenceFilter, sources?: { eventIds: number[]; relationIds: number[]; exportRowIds: number[] }) {
  const t = correspondenceTable(db)
  const refs = db.select(correspondenceRefColumns(db))
    .from(t).where(sources ? or(inArray(t.eventId, sources.eventIds), inArray(t.predecessorEventId, sources.eventIds), inArray(externalRelationColumn(db), sources.relationIds), inArray(t.exportRowId, sources.exportRowIds)) : correspondenceWhere(db, filter)).orderBy(asc(t.id)).all()
  return refsWithCurrentValidity(db, refs)
}
/** Request-owned fixed-scope statement only. Every call reads and revalidates
 * current rows; neither returned rows nor source validity are cached.
 */
export function createEnterpriseTitleCorrespondenceRefsReader(db: Db) {
  const t = correspondenceTable(db)
  const prepared = db.select(correspondenceRefColumns(db)).from(t)
    .where(and(eq(t.enterpriseId, sql.placeholder('enterpriseId')), eq(t.titleCode, sql.placeholder('titleCode'))))
    .orderBy(asc(t.id)).prepare()
  let validity: ReturnType<typeof createCorrespondenceRefValidityReader> | undefined
  const readValidity = (ids: number[]) => (validity ??= createCorrespondenceRefValidityReader(db))(ids)
  return Object.assign((enterpriseId: number, titleCode: string) => refsWithCurrentValidity(db, prepared.all({ enterpriseId, titleCode }), readValidity), {
    readBatch(enterpriseIds: readonly number[], titles?: readonly string[], scope?: 'recognition-witnesses') {
      const rows = db.select(correspondenceRefColumns(db)).from(t).where(and(inArray(t.enterpriseId, enterpriseIds), titles ? inArray(t.titleCode, titles) : undefined,
        // Only the internal global filter projection consumes this subset. Full
        // readers retain all refs and the identical source-validity algorithm.
        scope === 'recognition-witnesses' ? and(eq(t.type, 'event_recognized'), eq(t.role, 'recognized_corrob'), eq(t.status, 'confirmed'), sql`${t.eventId} is not null`, sql`${externalRelationColumn(db)} is not null`) : undefined)).orderBy(asc(t.id)).all()
      return refsWithCurrentValidity(db, rows, readValidity)
    },
  })
}
export function getRecordCorrespondenceAudit(db: Db, correspondenceId: number): CorrespondenceAudit[] {
  return db.select().from(schema.recordCorrespondenceAudit).where(eq(schema.recordCorrespondenceAudit.correspondenceId, correspondenceId)).orderBy(asc(schema.recordCorrespondenceAudit.id)).all()
}
export function pageRecordCorrespondenceAudit(db: Db, correspondenceId: number, paging: CorrespondencePaging) {
  const t = schema.recordCorrespondenceAudit, where = eq(t.correspondenceId, correspondenceId)
  const total = db.select({ total: count() }).from(t).where(where).get()!.total
  const rows = db.select().from(t).where(where).orderBy(asc(t.id)).limit(paging.pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER, (paging.page - 1) * paging.pageSize)).all()
  return { rows, total, ...paging }
}
export { type CorrespondenceEdge, type CorrespondenceOperation, type CorrespondenceRequest, type CorrespondenceImpact, type CorrespondencePlan, type CorrespondenceReceipt, type StoredCorrespondence, type CorrespondenceRead, CorrespondenceError, correspondenceHash, correspondenceEdgeKey, buildRecordCorrespondencePlan, recordCorrespondenceMutations, type ReadSources, type SourceReference, requestedCorrespondenceSources, projectObservedCorrespondence } from './record-correspondence-model'
