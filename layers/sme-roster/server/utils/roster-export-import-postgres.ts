import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { RosterImportItemResult, RosterImportRequest, RosterImportPreflight, RosterImportSummary } from '../../lib/roster-import-client'
import { canonicalImportJson } from './import-receipt-ledger'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { ImportReceiptError } from './import-receipts'
import { planPostgresExportSnapshot, writePostgresExportSnapshot } from './export-snapshot-import-postgres'
import { publicRosterImportItems, readSummaryOf } from './roster-import'
import { usePostgresRosterDb } from './postgres-roster-db'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Action = 'preflight' | 'commit'
type Batch = {
  id: number; status: NonNullable<RosterImportPreflight['batchStatus']>; kind: string; identity: string; sha256: string | null
  summary: unknown; items: RosterImportItemResult[] | null
}
const zeroSummary = { written: 0, skipped: 0, failed: 0, evidenceRepointed: 0 }

export async function lockPostgresRosterImportBatch(tx: Tx, key: string) {
  const { rows: [row] } = await tx.execute<Batch>(sql`
    SELECT id::float8 AS id,status,source_kind AS kind,source_identity AS identity,source_sha256 AS sha256,
      summary::json AS summary,item_results::json AS items FROM import_batch WHERE idempotency_key=${key} FOR UPDATE`)
  return row
}

export function committedPostgresImportResult(batch: Batch, action: Action) {
  return action === 'preflight' ? { batchId: batch.id, status: 'preflight' as const, preflight: {
    add: 0, update: 0, remove: 0, review: 0, conflicts: [], evidenceRepoints: 0, batchStatus: 'committed',
  } } : { batchId: batch.id, status: 'committed' as const, summary: readSummaryOf(batch.summary) ?? zeroSummary,
    items: publicRosterImportItems(batch.items ?? [], batch.id), error: null }
}

function conflict(message: string): never {
  throw new ImportReceiptError(409, 'idempotency_conflict', message)
}

export async function lockPostgresRosterImportKey(tx: Tx, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(21784,hashtext(${key}))`)
}

export async function runPostgresExportImport(action: Action | 'replay', request: RosterImportRequest) {
  if (action === 'replay' || request.sourceKind !== 'platform_export' || !request.payload.exportSnapshot ||
      Object.keys(request.payload).some(key => key !== 'exportSnapshot')) return undefined
  const db = usePostgresRosterDb(true)
  if (!db) return undefined
  const snapshot = request.payload.exportSnapshot
  return executePostgresRosterImport(db, action, request, async (tx, batch) => {
    if (action === 'commit') await tx.execute(sql`SELECT pg_advisory_xact_lock(21783,hashtext(${String(snapshot.titleCode)}))`)
    const plan = await planPostgresExportSnapshot(tx, snapshot)
    if (action === 'preflight') return { preflight: { ...plan.preflight, batchStatus: batch.status } }
    const item = await writePostgresExportSnapshot(tx, snapshot, batch.id, plan)
    const summary = item.ok ? { ...zeroSummary, written: Number(item.detail!.rowsWritten), skipped: Number(item.detail!.skipped) }
      : { ...zeroSummary, failed: 1 }
    return { preflight: plan.preflight, items: [item], summary,
      error: item.ok ? null : '批次校验未通过：1 项有误，未写入任何数据' }
  })
}

type NativeExecution = { preflight: RosterImportPreflight; summary?: never; items?: never; error?: never }
  | { preflight: RosterImportPreflight; summary: RosterImportSummary; items: RosterImportItemResult[]; error: string | null; candidateTaskIds?: string[] }

export async function executePostgresRosterImport(db: NodePgDatabase, action: Action, request: RosterImportRequest,
  execute: (tx: Tx,batch: Batch) => Promise<NativeExecution>) {
  const bound = { ...request, sourceSha256: request.sourceSha256 ?? null }
  const hash = createHash('sha256').update(canonicalImportJson(bound)).digest('hex')
  const redact = await importPostgresReceiptRedactor(db)
  const body = JSON.stringify(redact(bound))
  const attempt = await db.transaction(async tx => {
    await lockPostgresRosterImportKey(tx, request.idempotencyKey)
    if (action === 'commit') {
      const intake = await tx.execute(sql`SELECT id FROM roster_announcement_intake WHERE idempotency_key=${request.idempotencyKey}`)
      if (intake.rows.length) conflict('Idempotency key belongs to an announcement intake')
    }
    await tx.execute(sql`
      INSERT INTO import_batch(idempotency_key,source_kind,source_identity,source_sha256,status,created_at)
      VALUES (${request.idempotencyKey},${request.sourceKind},${request.sourceIdentity},${bound.sourceSha256},'preflight',${new Date().toISOString()})
      ON CONFLICT (idempotency_key) DO NOTHING`)
    const batch = (await lockPostgresRosterImportBatch(tx, request.idempotencyKey))!
    if (batch.kind !== request.sourceKind || batch.identity !== request.sourceIdentity || batch.sha256 !== bound.sourceSha256) {
      conflict('Idempotency key belongs to a different source')
    }
    const { rows: [previous] } = await tx.execute<{ status: string; hash: string }>(sql`
      SELECT status,request_hash AS hash FROM import_receipt WHERE batch_id=${batch.id} ORDER BY id DESC LIMIT 1`)
    if (previous && ['committed','processing'].includes(previous.status) && previous.hash !== hash) {
      conflict('Idempotency key belongs to a different request')
    }
    if (batch.status === 'committed') return { batch, receipt: null }
    const { rows: [receipt] } = await tx.execute<{ id: number }>(sql`
      WITH owner AS (
        SELECT id FROM import_receipt WHERE batch_id=${batch.id} AND request_hash=${hash}
          AND body_receipt_id IS NULL AND request_body=${body} ORDER BY id LIMIT 1
      ) INSERT INTO import_receipt(body_receipt_id,batch_id,operation,request_hash,request_body,status,created_at)
      SELECT id,${batch.id},${action},${hash},CASE WHEN id IS NULL THEN ${body} ELSE '' END,'processing',${new Date().toISOString()}
      FROM (VALUES(1)) instance(n) LEFT JOIN owner ON true RETURNING id::float8 AS id`)
    return { batch, receipt: receipt!.id }
  })
  if (attempt.receipt === null) return committedPostgresImportResult(attempt.batch, action)
  try {
    return await db.transaction(async tx => {
      const batch = (await lockPostgresRosterImportBatch(tx, request.idempotencyKey))!
      if (batch.status === 'committed') {
        const replay = committedPostgresImportResult(batch, action)
        await tx.execute(sql`UPDATE import_receipt SET status=${action === 'preflight' ? 'preflight' : 'committed'},
          summary=${'summary' in replay ? JSON.stringify(replay.summary) : null},
          item_results=${JSON.stringify(redact('items' in replay ? replay.items : []))},completed_at=${new Date().toISOString()} WHERE id=${attempt.receipt}`)
        return replay
      }
      const result = await execute(tx,batch)
      const at = new Date().toISOString()
      if (result.summary === undefined) {
        const { preflight } = result
        await tx.execute(sql`UPDATE import_batch SET preflight_result=${JSON.stringify(preflight)} WHERE id=${batch.id}`)
        await tx.execute(sql`UPDATE import_receipt SET status='preflight',item_results=${JSON.stringify(redact(preflight.conflicts))},
          completed_at=${at} WHERE id=${attempt.receipt}`)
        return { batchId: batch.id, status: 'preflight' as const, preflight }
      }
      const { items, summary, error } = result
      const status = error === null ? 'committed' as const : 'failed' as const
      await tx.execute(sql`UPDATE import_batch SET status=${status},item_results=${JSON.stringify(items)},summary=${JSON.stringify(summary)},
        error=${error},committed_at=${status === 'committed' ? at : null},preflight_result=${JSON.stringify(result.preflight)} WHERE id=${batch.id}`)
      await tx.execute(sql`UPDATE import_receipt SET status=${status},summary=${JSON.stringify(summary)},
        item_results=${JSON.stringify(redact(items))},completed_at=${at} WHERE id=${attempt.receipt}`)
      return { batchId: batch.id, status, summary, items, error, ...(result.candidateTaskIds?.length ? { candidateTaskIds: result.candidateTaskIds } : {}) }
    })
  } catch (error) {
    await db.execute(sql`UPDATE import_receipt SET status='failed',completed_at=${new Date().toISOString()} WHERE id=${attempt.receipt}`)
    throw error
  }
}
