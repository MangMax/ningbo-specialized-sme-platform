import { fileEventSyncPhysical, type SyncRequest, failFileEventSync, FILE_EVENT_SYNC_LIMIT, type Row, type FileSyncEventSources, proposeFileEventSync, fileEventSyncHash, withoutFileSyncCollisions, type FileEventSyncPlan, fileEventSyncResult, FILE_EVENT_SYNC_CHUNK } from './file-event-sync-model'
import { fileClassificationJoin, classificationColumns } from './roster-file-classification'
import { asc, eq, inArray, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { preflightRanges669, preflightParse310 } from './parse-maintenance-105'
import { buildPlan, preflightEventCorrections, commitEventCorrections } from './roster-event-correction'
import type { EventCorrectionRequest } from './roster-event-correction-model'
type Db = BetterSQLite3Database<typeof schema>
function physical(db: Db, id: number, dir: string) {
  return fileEventSyncPhysical(preflightParse310(db,id,{kind:'file'},dir).inputRef,dir)
}
function snapshot(db: Db, id: number, dir: string, request: SyncRequest) {
  // Preserve the field order used by persisted in-flight plan fingerprints.
  const file = db.select({
    id: schema.storedFile.id,
    relPath: schema.storedFile.relPath,
    displayName: schema.storedFile.displayName,
    filename: schema.storedFile.filename,
    ext: schema.storedFile.ext,
    bytes: schema.storedFile.bytes,
    sha256: schema.storedFile.sha256,
    ...classificationColumns,
    createdAt: schema.storedFile.createdAt,
    removedAt: schema.storedFile.removedAt,
  }).from(schema.storedFile).innerJoin(schema.rosterFileClassification, fileClassificationJoin).where(eq(schema.storedFile.id, id)).get()
  if (!file || file.removedAt) failFileEventSync('file_unavailable', '文件不存在或已移出', 404)
  const source = physical(db, id, dir)
  const declarations = db
    .select()
    .from(schema.fileDeclaration669)
    .where(eq(schema.fileDeclaration669.fileId, id))
    .orderBy(asc(schema.fileDeclaration669.declarationId))
    .limit(1001)
    .all()
  const refs = db
    .select()
    .from(schema.recordEvidence)
    .where(eq(schema.recordEvidence.sourceFile, file.relPath))
    .orderBy(asc(schema.recordEvidence.id))
    .limit(FILE_EVENT_SYNC_LIMIT + 1)
    .all()
  if (refs.length > FILE_EVENT_SYNC_LIMIT || declarations.length > 1000)
    failFileEventSync('capacity', '超过3000出处或1000声明；须先缩小文件维护范围，不截断', 413)
  const ids = [...new Set(refs.map((r) => r.recordEventId))].sort((a, b) => a - b)
  const rows: Row[] = [],
    operations: EventCorrectionRequest['operations'] = [],
    sources: FileSyncEventSources[] = []
  const active = declarations.filter((d) => d.active)
  for (const eventId of ids) {
    const event = db
      .select()
      .from(schema.recordEvent)
      .where(eq(schema.recordEvent.id, eventId))
      .get()!
    const record = db
      .select()
      .from(schema.record)
      .where(eq(schema.record.id, event.recordId))
      .get()!
    const evidence = db
      .select()
      .from(schema.recordEvidence)
      .where(eq(schema.recordEvidence.recordEventId, eventId))
      .orderBy(asc(schema.recordEvidence.id))
      .limit(301)
      .all()
    if (evidence.length > 300) failFileEventSync('capacity', '单事件出处超过300', 413)
    const siblings = db
      .select()
      .from(schema.recordEvent)
      .where(eq(schema.recordEvent.recordId, record.id))
      .orderBy(asc(schema.recordEvent.id))
      .limit(FILE_EVENT_SYNC_LIMIT + 1)
      .all()
    const official = evidence.length
      ? db
          .select()
          .from(schema.officialEvidenceRowRevision)
          .where(
            inArray(
              schema.officialEvidenceRowRevision.evidenceId,
              evidence.map((e) => e.id),
            ),
          )
          .orderBy(
            asc(schema.officialEvidenceRowRevision.evidenceId),
            asc(schema.officialEvidenceRowRevision.revision),
          )
          .limit(FILE_EVENT_SYNC_LIMIT + 1)
          .all()
      : []
    if (official.length > FILE_EVENT_SYNC_LIMIT || siblings.length > FILE_EVENT_SYNC_LIMIT)
      failFileEventSync('capacity', '事件历史或同记录事件超过3000；须先缩小维护范围', 413)
    const correspondences = db
      .select()
      .from(schema.recordCorrespondence)
      .where(
        or(
          eq(schema.recordCorrespondence.eventId, eventId),
          eq(schema.recordCorrespondence.predecessorEventId, eventId),
        ),
      )
      .orderBy(asc(schema.recordCorrespondence.id))
      .limit(301)
      .all()
    if (correspondences.length > 300) failFileEventSync('capacity', '事件对应影响超过300', 413)
    sources.push({ event, record, evidence, siblings, official, correspondences })
    const enterprise = db
      .select()
      .from(schema.enterprise)
      .where(eq(schema.enterprise.id, record.enterpriseId))
      .get()!
    const { row,op } = proposeFileEventSync(sources.at(-1)!,enterprise,source,file.relPath,active)
    rows.push(row)
    if (!op) continue
    try {
      buildPlan(db, {
        ...request,
        sourceIdentity: `file-event-sync:${id}`,
        operations: [op],
      })
      row.status = 'update'
      row.reason = '仅补未知正式年月'
      operations.push(op)
    } catch (error) {
      row.reason = (error as Error).message
    }
  }
  return {
    fingerprint: fileEventSyncHash({ file, source, declarations, refs, sources }),
    rows,
    operations: withoutFileSyncCollisions(rows,operations,sources),
  }
}
function bound(db: Db, id: number, request: SyncRequest) {
  const key = `file-event-sync:${id}:${request.idempotencyKey}`
  const batch = db
    .select()
    .from(schema.importBatch)
    .where(eq(schema.importBatch.idempotencyKey, key))
    .get()
  const plan = batch?.preflightResult as FileEventSyncPlan | undefined
  if (
    batch &&
    (!plan ||
      plan.protocol !== 'file-event-sync-671-v1' ||
      plan.requestHash !== fileEventSyncHash({ id, request }))
  )
    failFileEventSync('idempotency_conflict', '幂等键已被不同请求使用')
  return { key, batch, plan }
}
export async function preflightFileEventSync(
  db: Db,
  id: number,
  request: SyncRequest,
  dir: string,
) {
  const old = bound(db, id, request)
  if (old.plan) return fileEventSyncResult(old.plan)
  await preflightRanges669(db, id, { kind: 'file', verifyPhysicalPages: true }, dir)
  return db.transaction(
    () => {
      const replay = bound(db, id, request)
      if (replay.plan) return fileEventSyncResult(replay.plan)
      const s = snapshot(db, id, dir, request),
        requestHash = fileEventSyncHash({ id, request })
      const plan: FileEventSyncPlan = {
        protocol: 'file-event-sync-671-v1',
        requestHash,
        planHash: fileEventSyncHash({ requestHash, ...s }),
        ...s,
        expectedFingerprint: s.fingerprint,
        chunks: Math.ceil(s.operations.length / FILE_EVENT_SYNC_CHUNK),
        completed: [],
        updated: 0,
        receipts: {},
      }
      db.insert(schema.importBatch)
        .values({
          idempotencyKey: old.key,
          sourceKind: 'event_correction',
          sourceIdentity: `file-event-sync:${id}`,
          preflightResult: plan,
        })
        .run()
      return fileEventSyncResult(plan)
    },
    { behavior: 'immediate' },
  )
}
export async function commitFileEventSync(
  db: Db,
  id: number,
  request: SyncRequest,
  planHash: string,
  chunk: number,
  dir: string,
) {
  const old = bound(db, id, request)
  if (!old.plan || old.plan.planHash !== planHash) failFileEventSync('plan_mismatch', '需要原始预检计划')
  if (old.plan.completed.includes(chunk)) return old.plan.receipts[chunk]!
  try { await preflightRanges669(db,id,{kind:'file',verifyPhysicalPages:true},dir) }
  catch (error) {
    const completed = bound(db,id,request).plan
    if (completed?.planHash===planHash && completed.completed.includes(chunk)) return completed.receipts[chunk]!
    throw error
  }
  try {
    return db.transaction(
      () => {
        const { batch, plan } = bound(db, id, request)
        if (!batch || !plan || plan.planHash !== planHash) failFileEventSync('plan_mismatch', '预检计划不存在')
        if (plan.completed.includes(chunk)) return plan.receipts[chunk]!
        if (chunk !== plan.completed.length || chunk >= plan.chunks)
          failFileEventSync('chunk_order', '必须顺序执行未完成块')
        if (
          snapshot(db, id, dir, request).fingerprint !==
          (plan.expectedFingerprint ?? plan.fingerprint)
        )
          failFileEventSync('stale_membership', '完整候选成员、事件或出处已变化；请重新预检')
        const correction: EventCorrectionRequest = {
          ...request,
          // Public plan keys keep their existing namespace for persisted-plan replay.
          // A distinct prefix prevents every accepted client string (including colons)
          // from aliasing a correction chunk in the shared import_batch ledger.
          idempotencyKey: `file-event-sync-chunk:${id}:${request.idempotencyKey}:${chunk}`,
          sourceIdentity: `file-event-sync:${id}:${planHash}`,
          operations: plan.operations.slice(chunk * FILE_EVENT_SYNC_CHUNK, (chunk + 1) * FILE_EVENT_SYNC_CHUNK),
        }
        const preflight = preflightEventCorrections(db, correction)
        commitEventCorrections(db, correction, (preflight as { planHash: string }).planHash)
        // Rebase the full membership only after our own atomic correction, never after external edits.
        plan.expectedFingerprint = snapshot(db, id, dir, request).fingerprint
        plan.failedEvents = 0
        plan.updated += correction.operations.length
        plan.completed.push(chunk)
        const receipt = structuredClone(fileEventSyncResult(plan))
        plan.receipts[chunk] = receipt
        db.update(schema.importBatch)
          .set({
            preflightResult: plan,
            status: plan.completed.length === plan.chunks ? 'committed' : 'preflight',
            summary: fileEventSyncResult(plan),
          })
          .where(eq(schema.importBatch.id, batch.id))
          .run()
        return receipt
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    // The correction transaction has rolled back. Retain only progress about this
    // failed attempt, never any partially written event or correction audit.
    if (!(error as { statusCode?: number }).statusCode) {
      const progress = db.transaction(
        () => {
          const current = bound(db, id, request)
          if (!current.batch || !current.plan || current.plan.completed.includes(chunk))
            return undefined
          current.plan.failedEvents = current.plan.operations.slice(
            chunk * FILE_EVENT_SYNC_CHUNK,
            (chunk + 1) * FILE_EVENT_SYNC_CHUNK,
          ).length
          db.update(schema.importBatch)
            .set({ preflightResult: current.plan, summary: fileEventSyncResult(current.plan) })
            .where(eq(schema.importBatch.id, current.batch.id))
            .run()
          return fileEventSyncResult(current.plan)
        },
        { behavior: 'immediate' },
      )
      throw Object.assign(new Error('同步失败，本块已回滚；已完成块保留，可用原请求续跑'), {
        statusCode: 500,
        code: 'transaction_failed',
        progress,
      })
    }
    throw error
  }
}
export { syncRequestSchema, type SyncRequest, fileEventSyncHash, FILE_EVENT_SYNC_CHUNK, FILE_EVENT_SYNC_LIMIT, failFileEventSync, fileEventSyncPhysical, type FileSyncEventSources, proposeFileEventSync, withoutFileSyncCollisions, type FileEventSyncPlan, fileEventSyncResult } from './file-event-sync-model'
