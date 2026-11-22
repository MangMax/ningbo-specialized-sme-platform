import { createHash } from 'node:crypto'
import { z } from 'zod'
import { normalizeEnterpriseName } from '../../lib/enterprise-name'
import { normalizeReviewedUscc, usccFormatVerdict } from '../../lib/enterprise-uscc'
import type { enterpriseProfileAudit } from '../../../../db/schema'

type ProfileAuditContext = Pick<typeof enterpriseProfileAudit.$inferInsert, 'idempotencyKey' | 'requestHash' | 'actor' | 'basis'>

export class EnterpriseKernelError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message) }
}

const text = (length: number) => z.string().trim().min(1).max(length).refine(s => s.isWellFormed() && !s.includes('\0'))
const regionalCode = z.string().regex(/^\d+$/).nullable().optional()
export const enterpriseFieldsSchema = z.strictObject({
  name: text(300).refine(value => normalizeEnterpriseName(value).length > 0).optional(),
  uscc: text(80).transform(normalizeReviewedUscc).refine(value => usccFormatVerdict(value) === 'ok', 'Invalid USCC checksum or format').nullable().optional(),
  districtCode: regionalCode,
  townshipCode: regionalCode,
  industryCode: z.string().regex(/^\d{4}$/).nullable().optional(),
})
export type EnterpriseFields = z.infer<typeof enterpriseFieldsSchema>

export interface EnterpriseProfile { enterpriseId: number; name: string; city: string | null; district: string | null }

export function enterpriseProfileVersion({ profile, row, key }: {
  profile: EnterpriseProfile; row: { usccNorm: string | null; nameNorm: string }; key: string | null
}) {
  return createHash('sha256').update(JSON.stringify({ profile, uscc: row.usccNorm, nameNorm: row.nameNorm, lastWrite: key })).digest('hex')
}

export type ReviewedSubject =
  | { action: 'create'; fields: EnterpriseFields & { name: string } }
  | { action: 'attach'; enterpriseId: number; expectedRevision: number; fields?: EnterpriseFields; audit: ProfileAuditContext }

export const enterpriseDetailsSchema = enterpriseFieldsSchema.pick({ districtCode: true, townshipCode: true, industryCode: true }).extend({
  expectedRevision: z.number().int().positive(),
  registeredAddress: text(500).nullable(),
  operatingAddress: text(500).nullable(),
})

export type EnterpriseSource = {
  module: string; businessTable: string; versionKey: string; channel: string; listType: string;
  acquiredOn: string | null; series: string; fileId: number | null; sha256: string | null;
}
