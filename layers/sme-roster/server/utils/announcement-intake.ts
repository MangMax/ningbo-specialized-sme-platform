import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '../../../../db/schema'
import {
  applyReviewedEnterprise, enterpriseFieldsSchema, EnterpriseKernelError, registerEnterpriseSource, type LogContext,
} from '../../../core/server/public'
import type { RosterAnnouncementIntake, RosterAnnouncementIntakeFailure, RosterImportItemResult, RosterImportRequest, SupplementAnnouncementPreflightRequest, SupplementAnnouncementPreflightResult, SupplementAnnouncementRequest, SupplementAnnouncementResponse, SupplementAnnouncementResult } from '../../lib/roster-import-client'
import { normalizeReviewedUscc } from '../../../core/public'
import { normalizeName } from '../../lib/domain'
import { canonicalEnterpriseId } from '../../lib/roster/enterprise-identity'
import { captureIdentityRevision113, identityMaterial113 } from './evidence-impact-113'
import { commitRosterImport, hasOfficialFactInput, planRosterImport, validateAnnouncementIdentityAndEvidence } from './roster-import'
import { ImportReceiptError } from './import-receipts'
import { canonicalImportJson, recordImportReceipt } from './import-receipt-ledger'
import { ensureBatchRow, findBatchByKey } from './roster-batch-ledger'
import { validateRosterImportPageCounts } from './roster-import-page-validation'
import { readOfficialFile } from './official-evidence-plan'

type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database }
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const supplementSchema = z.strictObject({
  sourceDigest: hash,
  basis: z.string().trim().min(1).max(4000),
  preflight: z.literal(true).optional(),
  officialEvidencePlanHash: hash.optional(),
  rows: z.array(z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create'), fields: enterpriseFieldsSchema.required({ name: true }) }),
    z.strictObject({ action: z.literal('attach'), enterpriseId: id, expectedRevision: id, fields: enterpriseFieldsSchema.optional() }),
    z.strictObject({ action: z.literal('same_subject'), row: z.number().int().nonnegative() }),
  ])).min(1),
}).refine(input => !input.preflight || input.officialEvidencePlanHash === undefined, 'A supplement preflight cannot include its own plan hash')

const digestOf = (value: unknown) => createHash('sha256').update(canonicalImportJson(value)).digest('hex')
export type IntakeRow = { id: number; digest: string; request: string; removed_reason: string | null; supplement_digest: string | null; reviewed_request: string | null; receipt: string | null }

function loadIntake(db: Db, id: number) {
  const row = db.$client.prepare('SELECT * FROM roster_announcement_intake WHERE id=?').get(id) as IntakeRow | undefined
  if (!row) throw new ImportReceiptError(404, 'intake_not_found', 'Announcement intake not found')
  return row
}

export function stageAnnouncement(db: Db, request: RosterImportRequest, pageErrors: readonly RosterImportItemResult[]) {
  const announcement = request.payload.announcement!
  if (!Array.isArray(announcement.records)
    || !['jxj', 'miit'].includes(announcement.sourceDocument?.source)) {
    throw new ImportReceiptError(400, 'invalid_intake', 'Provide an announcement version with its original rows')
  }
  if (announcement.records.some(row => !row?.enterprise || typeof row.enterprise.name !== 'string' || !normalizeName(row.enterprise.name))) {
    throw new ImportReceiptError(400, 'invalid_intake', 'Every announcement row needs its original enterprise name')
  }
  const items = [...validateAnnouncementIdentityAndEvidence(announcement), ...pageErrors]
  if (items.length) return { batchId: null, error: 'Original announcement rows failed validation', status: 'failed' as const, items, summary: { written: 0, skipped: 0, failed: items.length, evidenceRepointed: 0 } }
  const digest = digestOf(request)
  return db.$client.transaction(() => {
    const previous = db.$client.prepare('SELECT * FROM roster_announcement_intake WHERE idempotency_key=?').get(request.idempotencyKey) as IntakeRow | undefined
    if (previous && previous.digest !== digest) throw new ImportReceiptError(409, 'idempotency_conflict', 'The key already identifies different source rows')
    const batch = findBatchByKey(db, request.idempotencyKey)
    if (batch && (batch.sourceKind !== request.sourceKind || batch.sourceIdentity !== request.sourceIdentity || batch.sourceSha256 !== (request.sourceSha256 ?? null))) {
      throw new ImportReceiptError(409, 'idempotency_conflict', 'Idempotency key belongs to a different source')
    }
    // Already committed historical commands can only replay their durable receipt.
    if (!previous && batch?.status === 'committed') return null
    const { id } = previous ?? db.$client.prepare(`INSERT INTO roster_announcement_intake(idempotency_key,digest,request)
      VALUES (?,?,?) RETURNING id`).get(request.idempotencyKey, digest, JSON.stringify(request)) as { id: number }
    return { status: 'staged' as const, intakeId: id, sourceDigest: digest, rowCount: announcement.records.length,
      ...(hasOfficialFactInput(request) ? { officialEvidencePreflightRequired: true as const } : {}) }
  }).immediate()
}

export function readAnnouncementIntake(db: Db, id: number): RosterAnnouncementIntake {
  return projectAnnouncementIntake(loadIntake(db, id))
}

export function projectAnnouncementIntake(row: IntakeRow): RosterAnnouncementIntake {
  const request = JSON.parse(row.request) as RosterImportRequest
  return { intakeId: row.id, sourceDigest: row.digest, status: row.removed_reason ? 'removed' : row.receipt ? 'supplemented' : 'staged',
    removedReason: row.removed_reason, sourceIdentity: request.sourceIdentity, sourceSha256: request.sourceSha256,
    announcement: request.payload.announcement!, ...(hasOfficialFactInput(request) ? { officialEvidencePreflightRequired: true as const } : {}),
    review: row.reviewed_request ? JSON.parse(row.reviewed_request) : null,
    receipt: row.receipt ? JSON.parse(row.receipt) : null }
}

export function checkAnnouncementRemoval(row: IntakeRow, sourceDigest: string, reason: string) {
  if (row.digest !== sourceDigest) throw new ImportReceiptError(409, 'source_changed', 'Announcement version changed')
  if (row.removed_reason !== null && row.removed_reason !== reason) throw new ImportReceiptError(409, 'already_removed', 'Announcement intake was already removed')
  return { intakeId: row.id, status: 'removed', removedReason: reason }
}

export function removeAnnouncementIntake(db: Db, id: number, sourceDigest: string, reason: string) {
  return db.$client.transaction(() => {
    const row = loadIntake(db, id)
    const removed = checkAnnouncementRemoval(row, sourceDigest, reason)
    db.$client.prepare('UPDATE roster_announcement_intake SET removed_reason=? WHERE id=?').run(reason, id)
    return removed
  }).immediate()
}

function attachSources(db: Db, intakeId: number, batchId: number, request: RosterImportRequest, owners: ReadonlyMap<number, number>, filesDir?: string) {
  const announcement = request.payload.announcement!
  const sha = request.sourceSha256
  const file = db.$client.prepare(`SELECT f.id,f.sha256,c.source FROM stored_file f
    JOIN roster_file_classification c ON c.file_id=f.id
    WHERE f.rel_path=? AND c.kind='announcement' AND f.removed_at IS NULL`).get(request.sourceIdentity) as
    { id: number; sha256: string; source: string } | undefined
  if (file && ((sha && sha !== file.sha256) || (filesDir && readOfficialFile(filesDir, request.sourceIdentity).sha256 !== file.sha256))) {
    throw new ImportReceiptError(409, 'source_changed', 'Registered announcement bytes differ')
  }
  const sourceIds = new Set<number>()
  const capturedOwners = new Set<string>()
  const captures = db.$client.prepare(`SELECT d.id,d.source,d.title,h.stored_file_id AS fileId,h.sha256,r.enterprise_id AS owner
    FROM official_evidence_row_revision h JOIN source_document d ON d.id=h.source_document_id
    JOIN record_event e ON e.id=h.event_id JOIN record r ON r.id=e.record_id
    WHERE h.import_batch_id=? AND h.source_binding_known=1`).all(batchId) as
    { id: number; source: string; title: string; fileId: number | null; sha256: string; owner: number }[]
  for (const row of captures) {
    const owner = canonicalEnterpriseId(db, row.owner) ?? row.owner
    sourceIds.add(registerEnterpriseSource(db, { module: 'sme-roster', businessTable: 'source_document',
      versionKey: `${row.id}:${row.sha256}`, channel: row.source, listType: 'announcement',
      series: row.title, acquiredOn: null, fileId: row.fileId, sha256: row.sha256 }, [owner]))
    capturedOwners.add(`${owner}:${row.source}`)
  }
  const title = announcement.sourceDocument.title ?? request.sourceIdentity
  for (const [index, owner] of owners) {
    const record = announcement.records[index]!
    const enterpriseId = canonicalEnterpriseId(db, owner) ?? owner
    const channel = record.source ?? announcement.sourceDocument.source
    if (capturedOwners.has(`${enterpriseId}:${channel}`)) continue
    const registeredFile = file?.source === channel ? file : undefined
    if (registeredFile) {
      const candidates = db.$client.prepare('SELECT id FROM source_document WHERE path=? AND source=? AND title=?').pluck().all(request.sourceIdentity, channel, title) as number[]
      if (candidates.length === 1) {
        sourceIds.add(registerEnterpriseSource(db, { module: 'sme-roster', businessTable: 'source_document',
          versionKey: `${candidates[0]}:${registeredFile.sha256}`, channel, listType: 'announcement', series: title,
          acquiredOn: null, fileId: registeredFile.id, sha256: registeredFile.sha256 }, [enterpriseId]))
        continue
      }
    }
    // A reused declaration may keep its older file path. This intake still
    // identifies the new file and its bytes independently of that path.
    sourceIds.add(registerEnterpriseSource(db, { module: 'sme-roster', businessTable: 'roster_announcement_intake',
      versionKey: `${intakeId}:${channel}`, channel, listType: 'announcement', series: title,
      acquiredOn: null, fileId: registeredFile?.id ?? null,
      sha256: registeredFile?.sha256 ?? (sha && hash.safeParse(sha).success ? sha : null) }, [enterpriseId]))
  }
  return [...sourceIds].sort((a, b) => a - b)
}

class SupplementRejected extends Error {
  constructor(readonly result: RosterAnnouncementIntakeFailure) { super(result.error ?? 'Announcement supplement rejected') }
}

class SupplementPreview extends Error {
  constructor(readonly result: SupplementAnnouncementPreflightResult) { super('Roll back announcement supplement preview') }
}

function applyReviewedAnnouncementOwners(db: Db, id: number, decision: string, rows: NonNullable<RosterImportRequest['payload']['announcement']>['records'], input: z.infer<typeof supplementSchema>) {
  const owners = new Map<number, number>()
  const created = new Set<number>()
  for (const [index, subject] of input.rows.entries()) {
    const source = rows[index]!.enterprise
    const sourceUscc = typeof source.uscc === 'string' ? normalizeReviewedUscc(source.uscc) : ''
    const name = normalizeName(source.name)
    const matchesSource = (owner: number) => {
      const target = db.$client.prepare('SELECT name_norm,uscc_norm FROM enterprise WHERE id=?').get(owner) as
        { name_norm: string; uscc_norm: string | null } | undefined
      if (!target) return false
      if (sourceUscc) return target.uscc_norm !== null && normalizeReviewedUscc(target.uscc_norm) === sourceUscc
      return target.name_norm === name || !!db.$client.prepare(`SELECT 1 FROM enterprise_alias
        WHERE enterprise_id=? AND name_norm=? AND verification_status='confirmed'`).get(owner, name)
    }
    const matchedBefore = subject.action === 'attach' && matchesSource(subject.enterpriseId)
    let owner: number | undefined
    if (subject.action === 'same_subject') {
      owner = owners.get(subject.row)
    } else if (subject.action === 'create') {
      owner = applyReviewedEnterprise(db, subject).id
      created.add(owner)
    } else {
      const identityBefore = subject.fields?.name === undefined && subject.fields?.uscc === undefined
        ? null : identityMaterial113(db, subject.enterpriseId)
      const applied = applyReviewedEnterprise(db, { ...subject, audit: {
        idempotencyKey: `announcement-intake:${id}:${index}:${decision}`, requestHash: decision,
        actor: { type: 'agent', id: 'roster-announcement-supplement' }, basis: input.basis,
      } })
      owner = applied.id
      if (applied.auditId !== null && identityBefore !== null) captureIdentityRevision113(db, {
        enterpriseId: owner, sourceKey: `enterprise:${owner}`, sourceVersion: `profile:${applied.auditId}`,
        before: identityBefore, after: identityMaterial113(db, owner),
      })
    }
    if (!owner) throw new ImportReceiptError(422, 'invalid_subject_reference', 'Choose an earlier reviewed row')
    if (!matchedBefore && !matchesSource(owner)) throw new EnterpriseKernelError(409, 'reviewed_identity_mismatch', 'The reviewed enterprise no longer matches the source identity')
    owners.set(index, owner)
  }
  return { owners, created }
}

export function supplementAnnouncement(db: Db, id: number, input: SupplementAnnouncementPreflightRequest, filesDir?: string, context?: LogContext): Promise<SupplementAnnouncementPreflightResult>
export function supplementAnnouncement(db: Db, id: number, input: SupplementAnnouncementRequest & { preflight?: never }, filesDir?: string, context?: LogContext): Promise<SupplementAnnouncementResult>
export function supplementAnnouncement(db: Db, id: number, input: z.infer<typeof supplementSchema>, filesDir?: string, context?: LogContext): Promise<SupplementAnnouncementResult | SupplementAnnouncementPreflightResult>
export async function supplementAnnouncement(db: Db, id: number, input: z.infer<typeof supplementSchema>, filesDir?: string, context?: LogContext): Promise<SupplementAnnouncementResult | SupplementAnnouncementPreflightResult> {
  const { preflight, officialEvidencePlanHash, ...review } = input
  const request = JSON.parse(loadIntake(db, id).request) as RosterImportRequest
  const pageErrors = filesDir ? await validateRosterImportPageCounts(request, filesDir) : []
  const supplement = db.$client.transaction((): SupplementAnnouncementResponse => {
    const row = loadIntake(db, id)
    if (row.digest !== input.sourceDigest) throw new ImportReceiptError(409, 'source_changed', 'Announcement version changed')
    const decision = digestOf(review)
    if (row.supplement_digest !== null) {
      if (row.supplement_digest !== decision) throw new ImportReceiptError(409, 'supplement_conflict', 'Announcement already has a different reviewed supplement')
      if (preflight) throw new ImportReceiptError(409, 'already_supplemented', 'Announcement already has a reviewed supplement')
      return JSON.parse(row.receipt!) as SupplementAnnouncementResponse
    }
    if (row.removed_reason) throw new ImportReceiptError(409, 'intake_removed', 'Announcement is removed from intake')
    const rows = request.payload.announcement!.records
    if (rows.length !== input.rows.length) throw new ImportReceiptError(422, 'unreviewed_rows', 'Supply a decision for each original row')
    if (pageErrors.length) throw new ImportReceiptError(409, 'source_changed', 'Source page cannot be revalidated')
    const { owners, created } = applyReviewedAnnouncementOwners(db, id, decision, rows, review)
    const reviewedAnnouncement = { owners, created, decision, planHash: officialEvidencePlanHash }
    if (preflight) {
      const plan = planRosterImport(db, request, { filesDir, reviewedAnnouncement })
      throw new SupplementPreview({ status: 'preflighted', conflicts: plan.conflicts,
        ...(plan.officialEvidencePlanHash ? { officialEvidencePlanHash: plan.officialEvidencePlanHash } : {}) })
    }
    const result = commitRosterImport(db, request, [], { ...context, filesDir, reviewedAnnouncement, deferCandidateTasks: true })
    if (result.status !== 'committed') {
      throw new SupplementRejected({ status: 'failed', batchId: null, items: result.items, summary: result.summary, error: result.error })
    }
    const sourceIds = attachSources(db, id, result.batchId, request, owners, filesDir)
    const joinVersion = db.$client.prepare(`INSERT INTO roster_announcement_member(enterprise_id,intake_id)
      VALUES (?,?) ON CONFLICT DO NOTHING`)
    for (const owner of new Set(owners.values())) joinVersion.run(canonicalEnterpriseId(db, owner) ?? owner, id)
    const receipt: SupplementAnnouncementResponse = { ...result, status: 'supplemented', intakeId: id, sourceIds, owners: [...owners.values()] }
    db.$client.prepare('UPDATE roster_announcement_intake SET supplement_digest=?, reviewed_request=?, receipt=? WHERE id=?')
      .run(decision, JSON.stringify(input), JSON.stringify(receipt), id)
    return receipt
  })
  return db.$client.transaction(() => {
    try {
      return supplement()
    } catch (error) {
      if (error instanceof SupplementPreview) return error.result
      if (!(error instanceof SupplementRejected)) throw error
      // Keep the failure ledger after rolling back the enterprise and source writes.
      return recordImportReceipt(db, 'commit', request, () => {
        const batch = ensureBatchRow(db, request)
        const { items, summary } = error.result
        db.update(schema.importBatch).set({ status: 'failed', itemResults: items, summary, error: error.result.error })
          .where(eq(schema.importBatch.id, batch.id)).run()
        return { ...error.result, batchId: batch.id }
      }, context)
    }
  }).immediate()
}
