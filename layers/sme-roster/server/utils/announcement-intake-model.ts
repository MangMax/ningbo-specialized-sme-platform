import { createHash } from 'node:crypto'
import { z } from 'zod'
import { enterpriseFieldsSchema } from '../../../core/server/public'
import type { RosterAnnouncementIntake, RosterImportItemResult, RosterImportRequest } from '../../lib/roster-import-client'
import { normalizeName } from '../../lib/domain'
import { hasOfficialFactInput, validateAnnouncementIdentityAndEvidence } from './roster-import-model'
import { ImportReceiptError } from './import-receipt-model'
import { canonicalImportJson } from './import-request-canonical'

export const hash = z.string().regex(/^[0-9a-f]{64}$/)

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

export const announcementIntakeDigest = (value: unknown) => createHash('sha256').update(canonicalImportJson(value)).digest('hex')

export type IntakeRow = { id: number; digest: string; request: string; removed_reason: string | null; supplement_digest: string | null; reviewed_request: string | null; receipt: string | null }

export function validateAnnouncementIntakeRows(request: RosterImportRequest, pageErrors: readonly RosterImportItemResult[]) {
  const announcement = request.payload.announcement
  if (!Array.isArray(announcement?.records)
    || !['jxj', 'miit'].includes(announcement.sourceDocument?.source)) {
    throw new ImportReceiptError(400, 'invalid_intake', 'Provide an announcement version with its original rows')
  }
  if (announcement.records.some(row => !row?.enterprise || typeof row.enterprise.name !== 'string' || !normalizeName(row.enterprise.name))) {
    throw new ImportReceiptError(400, 'invalid_intake', 'Every announcement row needs its original enterprise name')
  }
  const items = [...validateAnnouncementIdentityAndEvidence(announcement), ...pageErrors]
  if (items.length) return { batchId: null, error: 'Original announcement rows failed validation', status: 'failed' as const, items, summary: { written: 0, skipped: 0, failed: items.length, evidenceRepointed: 0 } }
}

export function stagedAnnouncement(request: RosterImportRequest, id: number, digest: string) {
  return { status: 'staged' as const, intakeId: id, sourceDigest: digest, rowCount: request.payload.announcement!.records.length,
    ...(hasOfficialFactInput(request) ? { officialEvidencePreflightRequired: true as const } : {}) }
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
