import type { OfficialEventRow, RosterRecordRow } from './roster-event-version-model'
import { createHash } from 'node:crypto'
import { statSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { z } from 'zod'
import type { enterprise as EnterpriseTable } from '../../../../db/postgresql/enterprise-tables'
import type { recordEvidence as RecordEvidenceTable } from '../../../../db/postgresql/ledger-tables'
import type { officialEvidenceRowRevision as OfficialEvidenceRowRevisionTable } from '../../../../db/postgresql/official-evidence-tables'
import type { recordCorrespondence as RecordCorrespondenceTable } from '../../../../db/postgresql/qualification-tables'
import type { RegisteredDeclaration } from './registered-declaration-summary'
import { normalizeAttachment } from '../../lib/attachment'
import type { InputRef310 } from './parse-maintenance-contract'
import type { EventCorrectionRequest } from './roster-event-correction-model'

export const syncRequestSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(120),
  actor: z.strictObject({
    type: z.enum(['user', 'agent']),
    id: z.string().trim().min(1).max(200),
  }),
  basis: z.string().trim().min(1).max(4000),
})

export type SyncRequest = z.infer<typeof syncRequestSchema>

export const fileEventSyncHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')

export const FILE_EVENT_SYNC_CHUNK = 100

export const FILE_EVENT_SYNC_LIMIT = 3000

export function failFileEventSync(code: string, message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { code, statusCode })
}

export function fileEventSyncPhysical(ref: InputRef310, dir:string) {
  const root = realpathSync(dir),
    path = realpathSync(resolve(root, ref.relPath))
  if (!path.startsWith(root + sep)) failFileEventSync('source_changed', '文件路径越界')
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

export type FileSyncEventSources = {
  event:OfficialEventRow
  record:RosterRecordRow
  evidence:(typeof RecordEvidenceTable.$inferSelect)[]
  siblings:(OfficialEventRow)[]
  official:(Omit<typeof OfficialEvidenceRowRevisionTable.$inferSelect, 'sourceBindingKnown'> & { sourceBindingKnown: boolean })[]
  correspondences:(typeof RecordCorrespondenceTable.$inferSelect)[]
}

export function proposeFileEventSync(input: FileSyncEventSources,
  enterprise: Pick<typeof EnterpriseTable.$inferSelect,'id'|'name'>,
  source: Pick<ReturnType<typeof fileEventSyncPhysical>,'sha256'|'contentVersion'>,
  filePath:string, active:(RegisteredDeclaration)[]): { row:Row; op?:EventCorrectionRequest['operations'][number] } {
  const { event,record,evidence,official } = input
  const eventId = event.id
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
  if (record.source !== 'jxj' || event.eventType === 'maintain') {
    row.reason = '非正式公布事件'
    return { row }
  }
  let desired: { year: number | null; batchSeq: number | null } | undefined
  for (const e of evidence) {
    if (e.sourceFile !== filePath) {
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
    if (desired && fileEventSyncHash(desired) !== fileEventSyncHash(next)) {
      row.reason = '多出处对应分段年月互相冲突'
      break
    }
    desired = next
  }
  if (row.reason || !desired) return { row }
  if (
    (before.year != null && desired.year != null && before.year !== desired.year) ||
    (before.batchSeq != null && desired.batchSeq != null && before.batchSeq !== desired.batchSeq)
  ) {
    row.reason = '已知年份或批次不同，不能覆盖'
    return { row }
  }
  row.after = {
    year: before.year ?? desired.year,
    batchSeq: before.batchSeq ?? desired.batchSeq,
  }
  if (fileEventSyncHash(row.after) === fileEventSyncHash(before)) {
    row.status = 'unchanged'
    row.reason = '相同值或分段无可补值'
    return { row }
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
  return { row,op }
}

export function withoutFileSyncCollisions(rows:Row[],operations:EventCorrectionRequest['operations'],sources:FileSyncEventSources[]) {
  const byId = new Map(sources.map(source=>[source.event.id,source.event]))
  // Validate all prospective coordinates together; a conflicting batch is never partially applied.
  const collisions = new Set<number>()
  const prospective = operations.map((op) => ({
    op,
    event: {
      ...byId.get(op.eventId)!,
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
  return operations.filter(op=>!collisions.has(op.eventId))
}

export type FileEventSyncPlan = {
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
  receipts: Record<number, ReturnType<typeof fileEventSyncResult>>
}

export function fileEventSyncResult(plan: FileEventSyncPlan) {
  return {
    planHash: plan.planHash,
    rows: plan.rows,
    chunks: plan.chunks,
    chunkSize: FILE_EVENT_SYNC_CHUNK,
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
