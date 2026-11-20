import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { z } from 'zod'
import type {
  RosterImportAfterQualificationReadback, RosterImportItemResult, RosterImportRequest, RosterImportSummary,
  SupplementAnnouncementPreflightResult, SupplementAnnouncementResponse,
} from '../../lib/roster-import-client'
import { readPostgresLegacyQualification } from '../../lib/roster/current-qualification-postgres'
import { lockPostgresRosterImportBatch, lockPostgresRosterImportKey } from './roster-export-import-postgres'
import { announcementIntakeDigest, type supplementSchema } from './announcement-intake'
import { readPostgresIntakeRow } from './announcement-intake-postgres'
import { reviewPostgresAnnouncementSubjects } from './announcement-subjects-postgres'
import { planPostgresAnnouncement } from './announcement-plan-postgres'
import { attachPostgresAnnouncementSources, writePostgresAnnouncement } from './announcement-write-postgres'
import { ImportReceiptError } from './import-receipts'
import { validateRosterImportPageCounts } from './roster-import-page-validation'
import { runPostgresCorrespondenceTransaction } from './record-correspondence-write-postgres'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { publicRosterImportItems } from './roster-import'
import { eventCorrectionCapture, eventCorrectionReadbackScope } from './roster-event-correction'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Review = z.infer<typeof supplementSchema>
const emptySummary: RosterImportSummary = { written: 0, skipped: 0, failed: 0, evidenceRepointed: 0 }

class Preview extends Error {
  constructor(readonly result: SupplementAnnouncementPreflightResult) { super('Announcement preview') }
}
class Conflicts extends Error {
  constructor(readonly items: RosterImportItemResult[]) { super('Announcement conflicts') }
}

async function qualification(tx: Tx, owners: ReadonlyMap<number, number>): Promise<RosterImportAfterQualificationReadback> {
  const scope = eventCorrectionReadbackScope([...owners.values()].map(enterpriseId => ({ enterpriseId })), 'after')
  if (scope.readback) return scope.readback as RosterImportAfterQualificationReadback
  try {
    const snapshot = await tx.transaction(nested => readPostgresLegacyQualification(nested, scope.target.enterpriseId, Date.now()))
    return eventCorrectionCapture(snapshot, 'after', scope.target) as RosterImportAfterQualificationReadback
  } catch { return eventCorrectionCapture(null, 'after', scope.target) as RosterImportAfterQualificationReadback }
}

async function recordSupplementReceipt(tx: Tx, input: {
  batchId: number; requestHash: string; requestBody: string; status: 'committed' | 'failed'
  summary: RosterImportSummary; items: unknown; startedAt: string; completedAt: string
}) {
  const { batchId, requestHash, requestBody, status, summary, items, startedAt, completedAt } = input
  await tx.execute(sql`WITH owner AS (
    SELECT id FROM import_receipt WHERE batch_id=${batchId} AND request_hash=${requestHash}
      AND body_receipt_id IS NULL AND request_body=${requestBody} ORDER BY id LIMIT 1
  ) INSERT INTO import_receipt(body_receipt_id,batch_id,operation,request_hash,request_body,status,summary,item_results,created_at,completed_at)
  SELECT id,${batchId},'commit',${requestHash},CASE WHEN id IS NULL THEN ${requestBody} ELSE '' END,${status},
    ${JSON.stringify(summary)},${JSON.stringify(items)},${startedAt},${completedAt}
  FROM (VALUES(1)) instance(n) LEFT JOIN owner ON true`)
}

export async function supplementPostgresAnnouncement(db: NodePgDatabase, id: number, input: Review, filesDir?: string) {
  const initial = await readPostgresIntakeRow(db, id)
  const request = JSON.parse(initial.request) as RosterImportRequest
  const pageErrors = filesDir ? await validateRosterImportPageCounts(request, filesDir) : []
  const { preflight, officialEvidencePlanHash, ...review } = input
  const decision = announcementIntakeDigest(review)
  const redactor = await importPostgresReceiptRedactor(db)
  const requestHash = announcementIntakeDigest({ ...request, sourceSha256: request.sourceSha256 ?? null })
  const requestBody = JSON.stringify(redactor({ ...request, sourceSha256: request.sourceSha256 ?? null }))
  return runPostgresCorrespondenceTransaction(db, async tx => {
    await lockPostgresRosterImportKey(tx, request.idempotencyKey)
    const row = await readPostgresIntakeRow(tx, id, true)
    if (row.digest !== input.sourceDigest) throw new ImportReceiptError(409, 'source_changed', 'Announcement version changed')
    if (row.supplement_digest !== null) {
      if (row.supplement_digest !== decision) throw new ImportReceiptError(409, 'supplement_conflict', 'Announcement already has a different reviewed supplement')
      if (preflight) throw new ImportReceiptError(409, 'already_supplemented', 'Announcement already has a reviewed supplement')
      return JSON.parse(row.receipt!) as SupplementAnnouncementResponse
    }
    if (row.removed_reason) throw new ImportReceiptError(409, 'intake_removed', 'Announcement is removed from intake')
    const raw = request.payload.announcement!.records
    if (raw.length !== input.rows.length) throw new ImportReceiptError(422, 'unreviewed_rows', 'Supply a decision for each original row')
    if (pageErrors.length) throw new ImportReceiptError(409, 'source_changed', 'Source page cannot be revalidated')
    if (Object.keys(request.payload).some(key => key !== 'announcement' && key !== 'officialEvidencePlanHash')) {
      throw new ImportReceiptError(503, 'native_import_unavailable', 'Mixed announcement imports require the remaining PostgreSQL import handlers')
    }

    const previous = await lockPostgresRosterImportBatch(tx, request.idempotencyKey)
    if (previous && (previous.kind !== request.sourceKind || previous.identity !== request.sourceIdentity ||
      previous.sha256 !== (request.sourceSha256 ?? null) || previous.status === 'committed')) {
      throw new ImportReceiptError(409, 'idempotency_conflict', 'Idempotency key belongs to a different source')
    }
    const startedAt = new Date().toISOString()
    const batchId = preflight ? null : previous?.id ?? (await tx.execute<{ id: number }>(sql`
      INSERT INTO import_batch(idempotency_key,source_kind,source_identity,source_sha256,status,created_at)
      VALUES(${request.idempotencyKey},${request.sourceKind},${request.sourceIdentity},${request.sourceSha256 ?? null},'preflight',${startedAt})
      RETURNING id::float8 AS id`)).rows[0]!.id
    try {
      return await tx.transaction(async nested => {
        const { owners, created } = await reviewPostgresAnnouncementSubjects(nested, id, decision, raw, input)
        const plan = await planPostgresAnnouncement(nested, request, owners, created, decision, filesDir)
        if (preflight) throw new Preview({ status: 'preflighted', conflicts: plan.errors,
          ...(plan.official ? { officialEvidencePlanHash: plan.official } : {}) })
        if (plan.official && plan.official !== officialEvidencePlanHash) plan.errors.push({
          ok: false, kind: 'official_evidence', ref: 'payload', error: {
            code: 'plan_mismatch', message: 'Matching opt-in preflight planHash required; sources or final plan changed',
          },
        })
        if (plan.errors.length) throw new Conflicts(plan.errors)
        const items = await writePostgresAnnouncement(nested, request, batchId!, plan)
        const readback = await qualification(nested, owners)
        const sourceIds = await attachPostgresAnnouncementSources(nested, id, batchId!, request, owners, filesDir)
        await nested.execute(sql`INSERT INTO roster_announcement_member(enterprise_id,intake_id)
          SELECT owner,${id} FROM unnest(${sql.param([...new Set(owners.values())])}::bigint[]) AS input(owner) ON CONFLICT DO NOTHING`)
        const summary = {
          ...emptySummary,
          written: items.reduce((count,item) => count + Number(item.detail?.rowsWritten ?? 0),0),
          skipped: items.reduce((count,item) => count + Number(item.detail?.skipped ?? 0),0) + plan.rows.filter(row => row.operation === 'skip').length,
          evidenceRepointed: items.reduce((count,item) => count + Number(item.detail?.evidenceRepointed ?? 0),0),
        }
        const completedAt = new Date().toISOString()
        await nested.execute(sql`UPDATE import_batch SET status='committed',item_results=${JSON.stringify(items)},
          summary=${JSON.stringify({ ...summary, qualificationReadback: readback })},error=NULL,committed_at=${completedAt} WHERE id=${batchId}`)
        const publicItems = publicRosterImportItems(items, batchId!)
        await recordSupplementReceipt(nested, { batchId: batchId!, requestHash, requestBody, status: 'committed',
          summary, items: redactor(publicItems), startedAt, completedAt })
        const receipt: SupplementAnnouncementResponse = { batchId: batchId!, status: 'supplemented', summary, items: publicItems, error: null,
          qualificationReadback: readback, intakeId: id, sourceIds, owners: [...owners.values()] }
        await nested.execute(sql`UPDATE roster_announcement_intake SET supplement_digest=${decision},reviewed_request=${JSON.stringify(input)},
          receipt=${JSON.stringify(receipt)} WHERE id=${id}`)
        return receipt
      })
    } catch (error) {
      if (error instanceof Preview) return error.result
      if (!(error instanceof Conflicts)) throw error
      const summary = { ...emptySummary, failed: error.items.length }
      const message = '批次校验未通过：' + error.items.length + ' 项有误，未写入任何数据'
      const items = publicRosterImportItems(error.items, batchId!)
      const completedAt = new Date().toISOString()
      await tx.execute(sql`UPDATE import_batch SET status='failed',item_results=${JSON.stringify(error.items)},summary=${JSON.stringify(summary)},
        error=${message} WHERE id=${batchId}`)
      await recordSupplementReceipt(tx, { batchId: batchId!, requestHash, requestBody, status: 'failed',
        summary, items: redactor(items), startedAt, completedAt })
      return { batchId: batchId!, status: 'failed' as const, summary, items, error: message }
    }
  })
}
