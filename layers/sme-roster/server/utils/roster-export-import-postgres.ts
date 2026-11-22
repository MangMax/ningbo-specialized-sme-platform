import { createHash } from 'node:crypto'
import { runningPostgresJobRunner } from '../../../core/server/utils/postgres-jobs'
import { CANDIDATE_JOB_KIND } from './jobs/candidate-discovery-contract'
import { isJobId } from '../../../core/lib/job'
import { appLog, type LogContext } from '../../../core/lib/logging'
import { desc, DrizzleQueryError, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { RosterImportItemResult, RosterImportRequest, RosterImportPreflight, RosterImportSummary } from '../../lib/roster-import-client'
import { importBatch, importReceipt } from '../../../../db/postgresql/import-tables'
import { rosterAnnouncementIntake } from '../../../../db/postgresql/roster-selection-tables'
import { canonicalImportJson } from './import-request-canonical'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { ImportReceiptError } from './import-receipt-model'
import { planPostgresExportSnapshot, writePostgresExportSnapshot } from './export-snapshot-import-postgres'
import { publicRosterImportItems, readSummaryOf, replayBatchKey } from './roster-import-model'
import { runPostgresCorrespondenceTransaction } from './record-correspondence-write-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
export type PostgresImportAction = 'preflight' | 'commit'
export type PostgresImportBatch = {
  id: number; status: NonNullable<RosterImportPreflight['batchStatus']>; kind: string; identity: string; sha256: string | null
  summary: unknown; items: RosterImportItemResult[] | null
  preflight: RosterImportPreflight | null
}
const zeroSummary = { written: 0, skipped: 0, failed: 0, evidenceRepointed: 0 }

export async function lockPostgresRosterImportBatch(tx: Tx, key: string) {
  const [row] = await tx.select({
    id: importBatch.id, status: importBatch.status, kind: importBatch.sourceKind,
    identity: importBatch.sourceIdentity, sha256: importBatch.sourceSha256,
    summary: importBatch.summary, items: importBatch.itemResults, preflight: importBatch.preflightResult,
  }).from(importBatch).where(eq(importBatch.idempotencyKey, key)).for('update')
  if (!row) return undefined
  return {
    ...row,
    status: row.status as PostgresImportBatch['status'],
    summary: row.summary === null ? null : JSON.parse(row.summary),
    items: row.items === null ? null : JSON.parse(row.items) as PostgresImportBatch['items'],
    preflight: row.preflight === null ? null : JSON.parse(row.preflight) as PostgresImportBatch['preflight'],
  }
}

export function committedPostgresImportResult(batch: PostgresImportBatch, action: PostgresImportAction) {
  const storedIds = (batch.summary as { candidateTaskIds?: unknown } | null)?.candidateTaskIds
  const candidateTaskIds = Array.isArray(storedIds) ? storedIds.filter(isJobId) : []
  return action === 'preflight' ? { batchId: batch.id, status: 'preflight' as const, preflight: {
    add: 0, update: 0, remove: 0, review: 0, conflicts: [], evidenceRepoints: 0, batchStatus: 'committed' as const,
  } } : { batchId: batch.id, status: 'committed' as const, summary: readSummaryOf(batch.summary) ?? zeroSummary,
    items: publicRosterImportItems(batch.items ?? [], batch.id), error: null,
    ...(candidateTaskIds.length ? { candidateTaskIds } : {}) }
}

function conflict(message: string): never {
  throw new ImportReceiptError(409, 'idempotency_conflict', message)
}

// Drizzle 0.45 has row-level .for() locking but no PostgreSQL advisory lock or hashtext builder.
export async function lockPostgresRosterImportKey(tx: Tx, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(21784,hashtext(${key}))`)
}

export function isPostgresImportWriteRejection(error: unknown) {
  const cause = error instanceof DrizzleQueryError ? error.cause : error
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' && (code.startsWith('23') || code === 'P0001')
}

export async function executePostgresExportItems(tx: Tx, batch: PostgresImportBatch, action: PostgresImportAction,
  snapshot: NonNullable<RosterImportRequest['payload']['exportSnapshot']>): Promise<NativeImportExecution> {
  // This uses the same transaction-scoped advisory lock capability as the batch key.
  if (action === 'commit') await tx.execute(sql`SELECT pg_advisory_xact_lock(21783,hashtext(${String(snapshot.titleCode)}))`)
  const plan = await planPostgresExportSnapshot(tx, snapshot)
  if (action === 'preflight') return { preflight: { ...plan.preflight, batchStatus: batch.status } }
  let item: RosterImportItemResult
  try {
    item = await writePostgresExportSnapshot(tx, snapshot, batch.id, plan)
  } catch (error) {
    // Statement rejections roll back with the other import steps. Keep transaction
    // retries and errors with an unknown outcome on the exception path.
    if (!isPostgresImportWriteRejection(error)) throw error
    const message = '导出快照写入失败，已整批回滚，未写入任何数据'
    item = { ok: false, kind: 'export_batch', ref: 'export:payload',
      error: { code: 'export_write_failed', message } }
    return { preflight: plan.preflight, items: [item], summary: { ...zeroSummary, failed: 1 }, error: message }
  }
  const summary = item.ok ? { ...zeroSummary, written: Number(item.detail!.rowsWritten), skipped: Number(item.detail!.skipped) }
    : { ...zeroSummary, failed: 1 }
  return { preflight: plan.preflight, items: [item], summary,
    error: item.ok ? null : '批次校验未通过：1 项有误，未写入任何数据' }
}

export type NativeImportExecution = { preflight: RosterImportPreflight; summary?: never; items?: never; error?: never }
  | { preflight: RosterImportPreflight; summary: RosterImportSummary; items: RosterImportItemResult[]; error: string | null; candidateTaskIds?: string[]; queuedCandidateTaskIds?: string[]; replayUpdate?: number }

export async function executePostgresRosterImport(db: NodePgDatabase, action: PostgresImportAction | 'replay', request: RosterImportRequest,
  execute: (tx: Tx,batch: PostgresImportBatch) => Promise<NativeImportExecution>, context?: LogContext) {
  const key = action === 'replay' ? replayBatchKey(request.idempotencyKey) : request.idempotencyKey
  const bound = { ...request, sourceSha256: request.sourceSha256 ?? null }
  const hash = createHash('sha256').update(canonicalImportJson(bound)).digest('hex')
  const redact = await importPostgresReceiptRedactor(db)
  const attempt = await db.transaction(async tx => {
    await lockPostgresRosterImportKey(tx, key)
    if (action === 'commit') {
      const [intake] = await tx.select({ id: rosterAnnouncementIntake.id }).from(rosterAnnouncementIntake)
        .where(eq(rosterAnnouncementIntake.idempotencyKey, request.idempotencyKey))
      if (intake) conflict('Idempotency key belongs to an announcement intake')
    }
    let batch = await lockPostgresRosterImportBatch(tx, key)
    if (!batch) {
      // Check under the key lock before INSERT, which would otherwise consume an ID on replay.
      await tx.insert(importBatch).values({
        idempotencyKey: key, sourceKind: request.sourceKind, sourceIdentity: request.sourceIdentity,
        sourceSha256: bound.sourceSha256, status: 'preflight', createdAt: new Date().toISOString(),
      }).onConflictDoNothing({ target: importBatch.idempotencyKey })
      batch = (await lockPostgresRosterImportBatch(tx, key))!
    }
    if (batch.kind !== request.sourceKind || batch.identity !== request.sourceIdentity || batch.sha256 !== bound.sourceSha256) {
      conflict('Idempotency key belongs to a different source')
    }
    const [previous] = await tx.select({
      id: importReceipt.id, status: importReceipt.status, hash: importReceipt.requestHash,
      historicalProjection: importReceipt.historicalProjection,
    })
      .from(importReceipt).where(eq(importReceipt.batchId, batch.id)).orderBy(desc(importReceipt.id)).limit(1)
    if (action !== 'replay' && previous && previous.hash !== hash) {
      if (['committed','processing'].includes(previous.status)) conflict('Idempotency key belongs to a different request')
      if (request.sourceKind === 'platform_archive' && previous.historicalProjection) {
        conflict('Historical projection key belongs to a different request')
      }
    }
    if (batch.status === 'committed' && action !== 'replay') return { batch, receipt: null, originalReceiptId: previous?.id }
    const [receipt] = await tx.insert(importReceipt).values({
      batchId: batch.id, operation: action, requestHash: hash,
      status: 'processing', createdAt: new Date().toISOString(),
    }).returning({ id: importReceipt.id })
    return { batch, receipt: receipt!.id }
  })
  const receiptId = attempt.receipt
  const logReplay = (id: number | undefined) => appLog({ module: 'sme-roster', source: 'import',
    operation: 'import.' + action + '.replay', outcome: 'success', batchId: attempt.batch.id, receiptId: id,
  }, context)
  if (receiptId === null) {
    logReplay(attempt.originalReceiptId)
    return committedPostgresImportResult(attempt.batch, action === 'preflight' ? 'preflight' : 'commit')
  }
  const run = (remember: (jobs: readonly { id: string; kind: string }[]) => void) => runPostgresCorrespondenceTransaction(db, async tx => {
    remember([])
    const batch = (await lockPostgresRosterImportBatch(tx, key))!
    if (batch.status === 'committed' && action !== 'replay') {
      const replay = committedPostgresImportResult(batch, action)
      await tx.update(importReceipt).set({
        status: action === 'preflight' ? 'preflight' : 'committed',
        summary: 'summary' in replay ? JSON.stringify(replay.summary) : null,
        itemResults: JSON.stringify(redact('items' in replay ? replay.items : [])),
        completedAt: new Date().toISOString(),
      }).where(eq(importReceipt.id, receiptId))
      return { result: replay, replayed: true }
    }
    const result = await execute(tx,batch)
    const at = new Date().toISOString()
    if (result.summary === undefined) {
      const { preflight } = result
      await tx.update(importBatch).set({ preflightResult: JSON.stringify(preflight) }).where(eq(importBatch.id, batch.id))
      await tx.update(importReceipt).set({
        status: 'preflight', itemResults: JSON.stringify(redact(preflight.conflicts)), completedAt: at,
      }).where(eq(importReceipt.id, receiptId))
      return { result: { batchId: batch.id, status: 'preflight' as const, preflight }, replayed: false }
    }
    const { items, summary, error } = result
    const publicItems = publicRosterImportItems(items, batch.id)
    const status = error === null ? 'committed' as const : 'failed' as const
    const tasks = result.candidateTaskIds?.length ? { candidateTaskIds: result.candidateTaskIds } : {}
    await tx.update(importBatch).set({
      status, itemResults: JSON.stringify(items), summary: JSON.stringify({ ...summary, ...tasks }), error,
      committedAt: status === 'committed' ? at : null, preflightResult: JSON.stringify(result.preflight),
    }).where(eq(importBatch.id, batch.id))
    await tx.update(importReceipt).set({
      status, summary: JSON.stringify(summary), itemResults: JSON.stringify(redact(publicItems)), completedAt: at,
    }).where(eq(importReceipt.id, receiptId))
    remember((result.queuedCandidateTaskIds ?? []).map(id => ({ id, kind: CANDIDATE_JOB_KIND })))
    if (action === 'replay') return { result: { batchId: batch.id, status: error === null ? 'replayed' as const : 'failed' as const,
      update: result.replayUpdate ?? 0, evidenceRepointed: summary.evidenceRepointed, items: publicItems, error }, replayed: false }
    return { result: { batchId: batch.id, status, summary, items: publicItems, error, ...tasks }, replayed: false }
  })
  const runner = action === 'commit' && request.payload.platformQueries?.length ? runningPostgresJobRunner(db) : undefined
  const { result, replayed } = await (runner ? runner.trackSubmission(run, context) : run(() => {})).catch(async error => {
    await db.update(importReceipt).set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(importReceipt.id, receiptId))
    throw error
  })
  if (replayed) logReplay(receiptId)
  else logCompletedImport(action, result, receiptId, context)
  return result
}

function logCompletedImport(action: string, result: {
  batchId: number; status: string; summary?: RosterImportSummary; preflight?: RosterImportPreflight; items?: RosterImportItemResult[]
}, receiptId: number, context?: LogContext) {
  const conflicts = result.preflight?.conflicts.length ?? 0
  const businessConflict = conflicts > 0 || result.items?.some(item =>
    !item.ok && item.error && !['commit_rolled_back', 'not_executed'].includes(item.error.code))
  const failed = result.status === 'failed'
  appLog({ module: 'sme-roster', source: 'import', operation: 'import.' + action,
    outcome: failed ? 'failure' : conflicts ? 'denied' : 'success',
    ...(failed ? { errorCode: businessConflict ? 'import_conflict' : 'import_batch_failed' }
      : conflicts ? { errorCode: 'import_conflict', level: 'warn' as const } : {}),
    batchId: result.batchId, receiptId,
    counts: result.summary ? { done: result.summary.written, failed: result.summary.failed } : { failed: conflicts },
  }, context)
}
