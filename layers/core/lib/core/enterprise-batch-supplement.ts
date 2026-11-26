import { z } from 'zod'
import type { EnterpriseLibraryDetails, EnterpriseLibraryTableRow } from './enterprise-library'

const nameText = z.string().refine(value => value.isWellFormed() && !value.includes('\0'))

export const batchCandidateMatchInput = z.strictObject({
  rows: z.array(z.strictObject({
    key: z.union([z.string(), z.number()]),
    name: nameText,
    uscc: z.string().nullish(),
  })).min(1).max(200).refine(rows => new Set(rows.map(row => row.key)).size === rows.length, '行标识必须唯一。'),
})

export type BatchCandidateMatchInput = z.infer<typeof batchCandidateMatchInput>
export type BatchMatchReason = 'uscc' | 'name' | 'alias'

export type BatchMatchEnterprise = Pick<EnterpriseLibraryDetails & EnterpriseLibraryTableRow,
  'id' | 'name' | 'uscc' | 'revision' | 'districtCode' | 'townshipCode' | 'industryCode' |
  'districtName' | 'townshipName' | 'industryName'
>

export interface BatchMatchCandidate extends BatchMatchEnterprise {
  matchReasons: BatchMatchReason[]
}

export interface BatchCandidateMatchResponse {
  rows: {
    key: string | number
    status: 'matched' | 'ambiguous' | 'unmatched'
    candidates: BatchMatchCandidate[]
  }[]
}

export interface BatchSupplementRowInput {
  key: string
  label?: string
  name: string
  uscc?: string | null
  district?: string | null
  note?: string | null
  businessSummary?: string | null
}

export interface BatchSupplementFields {
  name?: string
  uscc?: string | null
  districtCode?: string | null
  townshipCode?: string | null
  industryCode?: string | null
}

export type BatchSupplementDecision =
  | { key: string; action: 'create'; fields: BatchSupplementFields & { name: string } }
  | { key: string; action: 'attach'; enterpriseId: number; expectedRevision: number; fields: BatchSupplementFields }
