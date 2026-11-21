import { and, eq, isNull } from 'drizzle-orm'
import { importBatch, importReceipt } from '../../../../db/postgresql/import-tables'
import { rosterAnnouncementIntake, rosterAnnouncementMember } from '../../../../db/postgresql/roster-selection-tables'
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
import { applyPostgresOfficialImport, createPostgresOfficialImportState, finishPostgresOfficialImport } from './official-evidence-import-postgres'
import { validateRosterImportPageCounts } from './roster-import-page-validation'
import { runPostgresCorrespondenceTransaction } from './record-correspondence-write-postgres'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { publicRosterImportItems } from './roster-import'
import { createPostgresImportSteps, executePostgresImportSteps } from './roster-mixed-import-postgres'
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
  const [owner] = await tx.select({ id: importReceipt.id }).from(importReceipt).where(and(
    eq(importReceipt.batchId, batchId), eq(importReceipt.requestHash, requestHash),
    isNull(importReceipt.bodyReceiptId), eq(importReceipt.requestBody, requestBody),
  )).orderBy(importReceipt.id).limit(1)
  await tx.insert(importReceipt).values({
    bodyReceiptId: owner?.id ?? null, batchId, operation: 'commit', requestHash, requestBody: owner ? '' : requestBody,
    status, summary: JSON.stringify(summary), itemResults: JSON.stringify(items), createdAt: startedAt, completedAt,
  })
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
    const previous = await lockPostgresRosterImportBatch(tx, request.idempotencyKey)
    if (previous && (previous.kind !== request.sourceKind || previous.identity !== request.sourceIdentity ||
      previous.sha256 !== (request.sourceSha256 ?? null) || previous.status === 'committed')) {
      throw new ImportReceiptError(409, 'idempotency_conflict', 'Idempotency key belongs to a different source')
    }
    const startedAt = new Date().toISOString()
    const operation = preflight ? 'preflight' : 'commit'
    const steps = createPostgresImportSteps(operation,request,filesDir,true)
    const createBatch = async (connection: Tx) => {
      const [batch] = await connection.insert(importBatch).values({
        idempotencyKey: request.idempotencyKey, sourceKind: request.sourceKind, sourceIdentity: request.sourceIdentity,
        sourceSha256: request.sourceSha256 ?? null, status: 'preflight', createdAt: startedAt,
      }).returning({ id: importBatch.id })
      return batch!.id
    }
    const batchId = preflight ? null : previous?.id ?? await createBatch(tx)
    try {
      return await tx.transaction(async nested => {
        const { owners, created } = await reviewPostgresAnnouncementSubjects(nested, id, decision, raw, input)
        const plan = await planPostgresAnnouncement(nested, request, owners, created, decision, filesDir)
        if (preflight && (!steps.length || plan.errors.length)) throw new Preview({ status: 'preflighted', conflicts: plan.errors,
          ...(plan.official ? { officialEvidencePlanHash: plan.official } : {}) })
        if (!preflight && plan.official && plan.official !== officialEvidencePlanHash) plan.errors.push({
          ok: false, kind: 'official_evidence', ref: 'payload', error: {
            code: 'plan_mismatch', message: 'Matching opt-in preflight planHash required; sources or final plan changed',
          },
        })
        if (plan.errors.length) throw new Conflicts(plan.errors)
        const activeBatchId = batchId ?? previous?.id ?? await createBatch(nested)
        const evidence = createPostgresOfficialImportState()
        const items = await writePostgresAnnouncement(nested, request, activeBatchId, plan, evidence)
        if (plan.officialPlan) items.push(await applyPostgresOfficialImport(nested, plan.officialPlan, activeBatchId,
          preflight ? plan.official! : officialEvidencePlanHash, evidence))
        await finishPostgresOfficialImport(nested, evidence)
        const sourceIds = await attachPostgresAnnouncementSources(nested, id, activeBatchId, request, owners, filesDir)
        const members = [...new Set(owners.values())].map(enterpriseId => ({ enterpriseId, intakeId: id }))
        for (let offset = 0; offset < members.length; offset += 30_000) {
          await nested.insert(rosterAnnouncementMember).values(members.slice(offset, offset + 30_000)).onConflictDoNothing()
        }
        const extra = steps.length ? await executePostgresImportSteps(nested, {
          id: activeBatchId, status: previous?.status ?? 'preflight', kind: request.sourceKind, identity: request.sourceIdentity,
          sha256: request.sourceSha256 ?? null, items: null, preflight: previous?.preflight ?? null, summary: null,
        }, operation, steps) : undefined
        if (preflight) throw new Preview({ status: 'preflighted', conflicts: extra?.preflight.conflicts ?? [],
          ...(plan.official ? { officialEvidencePlanHash: plan.official } : {}) })
        if (extra?.error) throw new Conflicts([
          ...items.map(item=>({ ...item,ok:false,error:{code:'commit_rolled_back',message:'整批回滚，本项未写入'} })),
          ...extra.items,
        ])
        const readback = await qualification(nested, owners)
        const summary = {
          ...emptySummary, ...extra?.summary,
          written: (extra?.summary?.written ?? 0) + items.reduce((count,item) => count + Number(item.detail?.rowsWritten ?? 0),0),
          skipped: (extra?.summary?.skipped ?? 0) + items.reduce((count,item) => count + Number(item.detail?.skipped ?? 0),0) + plan.rows.filter(row => row.operation === 'skip').length,
          evidenceRepointed: (extra?.summary?.evidenceRepointed ?? 0) + items.reduce((count,item) => count + Number(item.detail?.evidenceRepointed ?? 0),0),
        }
        items.push(...extra?.items ?? [])
        const completedAt = new Date().toISOString()
        await nested.update(importBatch).set({
          status: 'committed', itemResults: JSON.stringify(items),
          summary: JSON.stringify({ ...summary, qualificationReadback: readback }), error: null, committedAt: completedAt,
        }).where(eq(importBatch.id, batchId!))
        const publicItems = publicRosterImportItems(items, batchId!)
        await recordSupplementReceipt(nested, { batchId: batchId!, requestHash, requestBody, status: 'committed',
          summary, items: redactor(publicItems), startedAt, completedAt })
        const candidateTaskIds = extra?.summary ? extra.candidateTaskIds : undefined
        const receipt: SupplementAnnouncementResponse = { batchId: batchId!, status: 'supplemented', summary, items: publicItems, error: null,
          qualificationReadback: readback, intakeId: id, sourceIds, owners: [...owners.values()],
          ...(candidateTaskIds?.length ? { candidateTaskIds } : {}) }
        await nested.update(rosterAnnouncementIntake).set({
          supplementDigest: decision, reviewedRequest: JSON.stringify(input), receipt: JSON.stringify(receipt),
        }).where(eq(rosterAnnouncementIntake.id, id))
        return receipt
      })
    } catch (error) {
      if (error instanceof Preview) return error.result
      if (!(error instanceof Conflicts)) throw error
      const summary = { ...emptySummary, failed: error.items.length }
      const message = '批次校验未通过：' + error.items.length + ' 项有误，未写入任何数据'
      const items = publicRosterImportItems(error.items, batchId!)
      const completedAt = new Date().toISOString()
      await tx.update(importBatch).set({
        status: 'failed', itemResults: JSON.stringify(error.items), summary: JSON.stringify(summary), error: message,
      }).where(eq(importBatch.id, batchId!))
      await recordSupplementReceipt(tx, { batchId: batchId!, requestHash, requestBody, status: 'failed',
        summary, items: redactor(items), startedAt, completedAt })
      return { batchId: batchId!, status: 'failed' as const, summary, items, error: message }
    }
  })
}
