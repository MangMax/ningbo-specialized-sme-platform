import { fileClassificationJoin, classificationColumns } from './roster-file-classification'
import { createHash } from 'node:crypto'
import { statSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { asc, eq, inArray, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '../../../../db/schema'
import { normalizeAttachment } from '../../lib/attachment'
import { preflightRanges669, preflightParse310 } from './parse-maintenance-105'
import {
  buildPlan,
  preflightEventCorrections,
  commitEventCorrections,
  type EventCorrectionRequest,
} from './roster-event-correction'

type Db = BetterSQLite3Database<typeof schema>
export const syncRequestSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(120),
  actor: z.strictObject({
    type: z.enum(['user', 'agent']),
    id: z.string().trim().min(1).max(200),
  }),
  basis: z.string().trim().min(1).max(4000),
})
export type SyncRequest = z.infer<typeof syncRequestSchema>
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const CHUNK = 100,
  LIMIT = 3000
function fail(code: string, message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { code, statusCode })
}
function physical(db: Db, id: number, dir: string) {
  const ref = preflightParse310(db, id, { kind: 'file' }, dir).inputRef
  const root = realpathSync(dir),
    path = realpathSync(resolve(root, ref.relPath))
  if (!path.startsWith(root + sep)) fail('source_changed', '文件路径越界')
  const s = statSync(path, { bigint: true })
  return {
    ...ref,
    contentVersion: [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':'),
  }
}
type Row = {
  eventId: number
  enterpriseId: number
  enterpriseName: string
  status: 'update' | 'unchanged' | 'conflict'
  reason: string
  before: { year: number | null; batchSeq: number | null }
  after: { year: number | null; batchSeq: number | null }
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
  if (!file || file.removedAt) fail('file_unavailable', '文件不存在或已移出', 404)
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
    .limit(LIMIT + 1)
    .all()
  if (refs.length > LIMIT || declarations.length > 1000)
    fail('capacity', '超过3000出处或1000声明；须先缩小文件维护范围，不截断', 413)
  const ids = [...new Set(refs.map((r) => r.recordEventId))].sort((a, b) => a - b)
  const rows: Row[] = [],
    operations: EventCorrectionRequest['operations'] = [],
    sources: unknown[] = []
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
    if (evidence.length > 300) fail('capacity', '单事件出处超过300', 413)
    const siblings = db
      .select()
      .from(schema.recordEvent)
      .where(eq(schema.recordEvent.recordId, record.id))
      .orderBy(asc(schema.recordEvent.id))
      .limit(LIMIT + 1)
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
          .limit(LIMIT + 1)
          .all()
      : []
    if (official.length > LIMIT || siblings.length > LIMIT)
      fail('capacity', '事件历史或同记录事件超过3000；须先缩小维护范围', 413)
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
    if (correspondences.length > 300) fail('capacity', '事件对应影响超过300', 413)
    sources.push({ event, record, evidence, siblings, official, correspondences })
    const enterprise = db
      .select()
      .from(schema.enterprise)
      .where(eq(schema.enterprise.id, record.enterpriseId))
      .get()!
    const before = { year: event.year, batchSeq: event.batchSeq },
      row: Row = {
        eventId,
        enterpriseId: enterprise.id,
        enterpriseName: enterprise.name,
        before,
        after: { ...before },
        status: 'conflict',
        reason: '',
      }
    rows.push(row)
    if (record.source !== 'jxj' || event.eventType === 'maintain') {
      row.reason = '非正式公布事件'
      continue
    }
    let desired: { year: number | null; batchSeq: number | null } | undefined
    for (const e of evidence) {
      if (e.sourceFile !== file.relPath) {
        row.reason = '多出处未能证明一致，须逐出处核实'
        break
      }
      const captured = official.filter((r) => r.evidenceId === e.id).at(-1)
      if (
        captured?.sourceBindingKnown &&
        (captured.sha256 !== source.sha256 ||
          captured.path !== e.sourceFile ||
          captured.page !== e.page ||
          normalizeAttachment(captured.attachment) !== normalizeAttachment(e.attachment))
      ) {
        row.reason = '出处原绑定与当前来源冲突'
        break
      }
      if (e.page == null) {
        row.reason = '出处缺少物理页码'
        break
      }
      const matches = active.filter(
        (d) =>
          d.part.titleCode === record.titleCode &&
          d.part.eventKind === event.eventType &&
          normalizeAttachment(d.part.attachment) === normalizeAttachment(e.attachment) &&
          d.pageRanges?.some((r) => e.page! >= r.start && e.page! <= r.end),
      )
      if (matches.length !== 1) {
        row.reason = matches.length ? '同页多段无法唯一归属' : '没有唯一已保存范围声明'
        break
      }
      const d = matches[0]!
      if (d.sha256 !== source.sha256 || d.contentVersion !== source.contentVersion) {
        row.reason = '声明来源内容已变化'
        break
      }
      const next = { year: d.part.year, batchSeq: d.part.batch }
      if (desired && hash(desired) !== hash(next)) {
        row.reason = '多出处对应分段年月互相冲突'
        break
      }
      desired = next
    }
    if (row.reason || !desired) continue
    if (
      (before.year != null && desired.year != null && before.year !== desired.year) ||
      (before.batchSeq != null && desired.batchSeq != null && before.batchSeq !== desired.batchSeq)
    ) {
      row.reason = '已知年份或批次不同，不能覆盖'
      continue
    }
    row.after = {
      year: before.year ?? desired.year,
      batchSeq: before.batchSeq ?? desired.batchSeq,
    }
    if (hash(row.after) === hash(before)) {
      row.status = 'unchanged'
      row.reason = '相同值或分段无可补值'
      continue
    }
    const patch: { year?: number; batchSeq?: number } = {}
    if (before.year == null && row.after.year != null) patch.year = row.after.year
    if (before.batchSeq == null && row.after.batchSeq != null) patch.batchSeq = row.after.batchSeq
    const op = {
      eventId,
      recordId: record.id,
      enterpriseId: enterprise.id,
      expectedRevision: event.revision,
      patch,
    }
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
  // Validate all prospective coordinates together; a conflicting batch is never partially applied.
  const collisions = new Set<number>()
  const prospective = operations.map((op) => ({
    op,
    event: {
      ...(
        sources[ids.indexOf(op.eventId)] as {
          event: typeof schema.recordEvent.$inferSelect
        }
      ).event,
      ...op.patch,
    },
  }))
  for (let i = 0; i < prospective.length; i++)
    for (let j = i + 1; j < prospective.length; j++) {
      const a = prospective[i]!,
        b = prospective[j]!,
        x = a.event,
        y = b.event
      if (
        a.op.recordId !== b.op.recordId ||
        x.eventType !== y.eventType ||
        x.year !== y.year ||
        x.batchSeq !== y.batchSeq
      )
        continue
      if (
        x.eventType !== 'review' ||
        x.year == null ||
        x.batchSeq == null ||
        x.decidedYear == null ||
        y.decidedYear == null ||
        x.decidedYear === y.decidedYear
      ) {
        collisions.add(x.id)
        collisions.add(y.id)
      }
    }
  for (const row of rows)
    if (collisions.has(row.eventId)) {
      row.status = 'conflict'
      row.reason = '补齐后的正式事件坐标被计划内其他事件占用'
    }
  return {
    fingerprint: hash({ file, source, declarations, refs, sources }),
    rows,
    operations: operations.filter((op) => !collisions.has(op.eventId)),
  }
}
type Plan = {
  protocol: 'file-event-sync-671-v1'
  requestHash: string
  planHash: string
  fingerprint: string
  expectedFingerprint: string
  rows: Row[]
  operations: EventCorrectionRequest['operations']
  chunks: number
  completed: number[]
  updated: number
  failedEvents?: number
  receipts: Record<number, ReturnType<typeof result>>
}
function bound(db: Db, id: number, request: SyncRequest) {
  const key = `file-event-sync:${id}:${request.idempotencyKey}`
  const batch = db
    .select()
    .from(schema.importBatch)
    .where(eq(schema.importBatch.idempotencyKey, key))
    .get()
  const plan = batch?.preflightResult as Plan | undefined
  if (
    batch &&
    (!plan ||
      plan.protocol !== 'file-event-sync-671-v1' ||
      plan.requestHash !== hash({ id, request }))
  )
    fail('idempotency_conflict', '幂等键已被不同请求使用')
  return { key, batch, plan }
}
function result(plan: Plan) {
  return {
    planHash: plan.planHash,
    rows: plan.rows,
    chunks: plan.chunks,
    chunkSize: CHUNK,
    completed: plan.completed,
    counts: {
      updated: plan.updated,
      unchanged: plan.rows.filter((r) => r.status === 'unchanged').length,
      conflicts: plan.rows.filter((r) => r.status === 'conflict').length,
      failed: plan.failedEvents ?? 0,
      unexecuted: plan.operations.length - plan.updated - (plan.failedEvents ?? 0),
    },
  }
}
export async function preflightFileEventSync(
  db: Db,
  id: number,
  request: SyncRequest,
  dir: string,
) {
  const old = bound(db, id, request)
  if (old.plan) return result(old.plan)
  await preflightRanges669(db, id, { kind: 'file', verifyPhysicalPages: true }, dir)
  return db.transaction(
    () => {
      const replay = bound(db, id, request)
      if (replay.plan) return result(replay.plan)
      const s = snapshot(db, id, dir, request),
        requestHash = hash({ id, request })
      const plan: Plan = {
        protocol: 'file-event-sync-671-v1',
        requestHash,
        planHash: hash({ requestHash, ...s }),
        ...s,
        expectedFingerprint: s.fingerprint,
        chunks: Math.ceil(s.operations.length / CHUNK),
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
      return result(plan)
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
  if (!old.plan || old.plan.planHash !== planHash) fail('plan_mismatch', '需要原始预检计划')
  if (old.plan.completed.includes(chunk)) return old.plan.receipts[chunk]!
  await preflightRanges669(db, id, { kind: 'file', verifyPhysicalPages: true }, dir)
  try {
    return db.transaction(
      () => {
        const { batch, plan } = bound(db, id, request)
        if (!batch || !plan || plan.planHash !== planHash) fail('plan_mismatch', '预检计划不存在')
        if (plan.completed.includes(chunk)) return plan.receipts[chunk]!
        if (chunk !== plan.completed.length || chunk >= plan.chunks)
          fail('chunk_order', '必须顺序执行未完成块')
        if (
          snapshot(db, id, dir, request).fingerprint !==
          (plan.expectedFingerprint ?? plan.fingerprint)
        )
          fail('stale_membership', '完整候选成员、事件或出处已变化；请重新预检')
        const correction: EventCorrectionRequest = {
          ...request,
          // Public plan keys keep their existing namespace for persisted-plan replay.
          // A distinct prefix prevents every accepted client string (including colons)
          // from aliasing a correction chunk in the shared import_batch ledger.
          idempotencyKey: `file-event-sync-chunk:${id}:${request.idempotencyKey}:${chunk}`,
          sourceIdentity: `file-event-sync:${id}:${planHash}`,
          operations: plan.operations.slice(chunk * CHUNK, (chunk + 1) * CHUNK),
        }
        const preflight = preflightEventCorrections(db, correction)
        commitEventCorrections(db, correction, (preflight as { planHash: string }).planHash)
        // Rebase the full membership only after our own atomic correction, never after external edits.
        plan.expectedFingerprint = snapshot(db, id, dir, request).fingerprint
        plan.failedEvents = 0
        plan.updated += correction.operations.length
        plan.completed.push(chunk)
        const receipt = structuredClone(result(plan))
        plan.receipts[chunk] = receipt
        db.update(schema.importBatch)
          .set({
            preflightResult: plan,
            status: plan.completed.length === plan.chunks ? 'committed' : 'preflight',
            summary: result(plan),
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
            chunk * CHUNK,
            (chunk + 1) * CHUNK,
          ).length
          db.update(schema.importBatch)
            .set({ preflightResult: current.plan, summary: result(current.plan) })
            .where(eq(schema.importBatch.id, current.batch.id))
            .run()
          return result(current.plan)
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
