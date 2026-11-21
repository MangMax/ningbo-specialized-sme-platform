import { createHash } from 'node:crypto'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { RosterImportItemResult, RosterImportRequest, RosterImportPreflight, RosterImportSummary } from '../../lib/roster-import-client'
import { alias } from 'drizzle-orm/pg-core'
import { importBatch, importReceipt } from '../../../../db/postgresql/import-tables'
import { rosterAnnouncementIntake } from '../../../../db/postgresql/roster-selection-tables'
import { canonicalImportJson } from './import-receipt-ledger'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { ImportReceiptError } from './import-receipts'
import { planPostgresExportSnapshot, writePostgresExportSnapshot } from './export-snapshot-import-postgres'
import { publicRosterImportItems, readSummaryOf, replayBatchKey } from './roster-import'
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
  return action === 'preflight' ? { batchId: batch.id, status: 'preflight' as const, preflight: {
    add: 0, update: 0, remove: 0, review: 0, conflicts: [], evidenceRepoints: 0, batchStatus: 'committed' as const,
  } } : { batchId: batch.id, status: 'committed' as const, summary: readSummaryOf(batch.summary) ?? zeroSummary,
    items: publicRosterImportItems(batch.items ?? [], batch.id), error: null }
}

function conflict(message: string): never {
  throw new ImportReceiptError(409, 'idempotency_conflict', message)
}

// Drizzle 0.45 has row-level .for() locking but no PostgreSQL advisory lock or hashtext builder.
export async function lockPostgresRosterImportKey(tx: Tx, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(21784,hashtext(${key}))`)
}

export async function executePostgresExportItems(tx: Tx, batch: PostgresImportBatch, action: PostgresImportAction,
  snapshot: NonNullable<RosterImportRequest['payload']['exportSnapshot']>): Promise<NativeImportExecution> {
  // This uses the same transaction-scoped advisory lock capability as the batch key.
  if (action === 'commit') await tx.execute(sql`SELECT pg_advisory_xact_lock(21783,hashtext(${String(snapshot.titleCode)}))`)
  const plan = await planPostgresExportSnapshot(tx, snapshot)
  if (action === 'preflight') return { preflight: { ...plan.preflight, batchStatus: batch.status } }
  const item = await writePostgresExportSnapshot(tx, snapshot, batch.id, plan)
  const summary = item.ok ? { ...zeroSummary, written: Number(item.detail!.rowsWritten), skipped: Number(item.detail!.skipped) }
    : { ...zeroSummary, failed: 1 }
  return { preflight: plan.preflight, items: [item], summary,
    error: item.ok ? null : '批次校验未通过：1 项有误，未写入任何数据' }
}

export type NativeImportExecution = { preflight: RosterImportPreflight; summary?: never; items?: never; error?: never }
  | { preflight: RosterImportPreflight; summary: RosterImportSummary; items: RosterImportItemResult[]; error: string | null; candidateTaskIds?: string[]; replayUpdate?: number }

export async function executePostgresRosterImport(db: NodePgDatabase, action: PostgresImportAction | 'replay', request: RosterImportRequest,
  execute: (tx: Tx,batch: PostgresImportBatch) => Promise<NativeImportExecution>) {
  const key = action === 'replay' ? replayBatchKey(request.idempotencyKey) : request.idempotencyKey
  const bound = { ...request, sourceSha256: request.sourceSha256 ?? null }
  const hash = createHash('sha256').update(canonicalImportJson(bound)).digest('hex')
  const redact = await importPostgresReceiptRedactor(db)
  const body = JSON.stringify(redact(bound))
  const attempt = await db.transaction(async tx => {
    await lockPostgresRosterImportKey(tx, key)
    if (action === 'commit') {
      const [intake] = await tx.select({ id: rosterAnnouncementIntake.id }).from(rosterAnnouncementIntake)
        .where(eq(rosterAnnouncementIntake.idempotencyKey, request.idempotencyKey))
      if (intake) conflict('Idempotency key belongs to an announcement intake')
    }
    await tx.insert(importBatch).values({
      idempotencyKey: key, sourceKind: request.sourceKind, sourceIdentity: request.sourceIdentity,
      sourceSha256: bound.sourceSha256, status: 'preflight', createdAt: new Date().toISOString(),
    }).onConflictDoNothing({ target: importBatch.idempotencyKey })
    const batch = (await lockPostgresRosterImportBatch(tx, key))!
    if (batch.kind !== request.sourceKind || batch.identity !== request.sourceIdentity || batch.sha256 !== bound.sourceSha256) {
      conflict('Idempotency key belongs to a different source')
    }
    const [previous] = await tx.select({ id: importReceipt.id, status: importReceipt.status, hash: importReceipt.requestHash })
      .from(importReceipt).where(eq(importReceipt.batchId, batch.id)).orderBy(desc(importReceipt.id)).limit(1)
    if (action !== 'replay' && previous && previous.hash !== hash) {
      if (['committed','processing'].includes(previous.status)) conflict('Idempotency key belongs to a different request')
      if (request.sourceKind === 'platform_archive') {
        const bodyOwner = alias(importReceipt, 'body_owner')
        const [original] = await tx.select({ body: importReceipt.requestBody, ownerBody: bodyOwner.requestBody })
          .from(importReceipt).leftJoin(bodyOwner, eq(bodyOwner.id, importReceipt.bodyReceiptId))
          .where(eq(importReceipt.id, previous.id))
        const originalBody = original?.ownerBody ?? original?.body
        const prior = originalBody ? JSON.parse(originalBody) as RosterImportRequest : null
        if (request.payload.platformRecordObservations !== undefined || prior?.payload?.platformRecordObservations !== undefined) {
          conflict('Historical projection key belongs to a different request')
        }
      }
    }
    if (batch.status === 'committed' && action !== 'replay') return { batch, receipt: null }
    const [owner] = await tx.select({ id: importReceipt.id }).from(importReceipt)
      .where(and(eq(importReceipt.batchId, batch.id), eq(importReceipt.requestHash, hash),
        isNull(importReceipt.bodyReceiptId), eq(importReceipt.requestBody, body)))
      .orderBy(asc(importReceipt.id)).limit(1)
    const [receipt] = await tx.insert(importReceipt).values({
      bodyReceiptId: owner?.id ?? null, batchId: batch.id, operation: action, requestHash: hash,
      requestBody: owner ? '' : body, status: 'processing', createdAt: new Date().toISOString(),
    }).returning({ id: importReceipt.id })
    return { batch, receipt: receipt!.id }
  })
  const receiptId = attempt.receipt
  if (receiptId === null) return committedPostgresImportResult(attempt.batch, action === 'preflight' ? 'preflight' : 'commit')
  try {
    return await runPostgresCorrespondenceTransaction(db, async tx => {
      const batch = (await lockPostgresRosterImportBatch(tx, key))!
      if (batch.status === 'committed' && action !== 'replay') {
        const replay = committedPostgresImportResult(batch, action)
        await tx.update(importReceipt).set({
          status: action === 'preflight' ? 'preflight' : 'committed',
          summary: 'summary' in replay ? JSON.stringify(replay.summary) : null,
          itemResults: JSON.stringify(redact('items' in replay ? replay.items : [])),
          completedAt: new Date().toISOString(),
        }).where(eq(importReceipt.id, receiptId))
        return replay
      }
      const result = await execute(tx,batch)
      const at = new Date().toISOString()
      if (result.summary === undefined) {
        const { preflight } = result
        await tx.update(importBatch).set({ preflightResult: JSON.stringify(preflight) }).where(eq(importBatch.id, batch.id))
        await tx.update(importReceipt).set({
          status: 'preflight', itemResults: JSON.stringify(redact(preflight.conflicts)), completedAt: at,
        }).where(eq(importReceipt.id, receiptId))
        return { batchId: batch.id, status: 'preflight' as const, preflight }
      }
      const { items, summary, error } = result
      const status = error === null ? 'committed' as const : 'failed' as const
      await tx.update(importBatch).set({
        status, itemResults: JSON.stringify(items), summary: JSON.stringify(summary), error,
        committedAt: status === 'committed' ? at : null, preflightResult: JSON.stringify(result.preflight),
      }).where(eq(importBatch.id, batch.id))
      await tx.update(importReceipt).set({
        status, summary: JSON.stringify(summary), itemResults: JSON.stringify(redact(items)), completedAt: at,
      }).where(eq(importReceipt.id, receiptId))
      if (action === 'replay') return { batchId: batch.id, status: error === null ? 'replayed' as const : 'failed' as const,
        update: result.replayUpdate ?? 0, evidenceRepointed: summary.evidenceRepointed, items: publicRosterImportItems(items,batch.id), error }
      return { batchId: batch.id, status, summary, items, error, ...(result.candidateTaskIds?.length ? { candidateTaskIds: result.candidateTaskIds } : {}) }
    })
  } catch (error) {
    await db.update(importReceipt).set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(importReceipt.id, receiptId))
    throw error
  }
}
