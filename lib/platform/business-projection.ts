/**
 * #457: business_list (upstream businessList) source-specific typed projection.
 *
 * Only fields actually present on the archived row are projected. Title scope and
 * query metadata stay query facts and are never copied onto a content version.
 * Missing or blank values stay null. A business year is accepted only as an
 * explicit positive integer (JSON number or a decimal-integer string): it is never
 * inferred from sqsj, queriedAt, batch, name or a title.
 */
import { normalizeDeclareKind } from './identity'

export const BUSINESS_PROJECTION_RULE = 'platform-business-v1'

export interface BusinessProjectionFields {
  /** Raw sblx after trimming; unknown dictionary values are retained. */
  declareKind: string | null
  /** Explicit positive integer source year only. */
  businessYear: number | null
  /** Raw sqsj after trimming. */
  appliedAt: string | null
  /** Raw cszt after trimming. */
  status: string | null
  /** Raw whpc (维护批次) after trimming. */
  batch: string | null
  /** Raw personuuid (原认定批次标签) after trimming; never a person identity. */
  awardBatchLabel: string | null
  /** Raw szsfmc (属地) after trimming. */
  province: string | null
  /** Raw row-level rdjb after trimming; never query title scope. */
  titleRaw?: string | null
  nameRaw: string | null
  usccRaw: string | null
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/** The source returns year as either a JSON number or a decimal-integer string.
 * Blank, booleans, fractions, negatives and non-numeric strings are unknown, never
 * coerced into a year. Whitespace is not a decimal integer and is not trimmed. */
function year(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** Pure parser: callers pass the archived raw JSON object as-is. */
export function parseBusinessProcess(raw: unknown): BusinessProjectionFields {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return {
    declareKind: normalizeDeclareKind(row.sblx),
    businessYear: year(row.year),
    appliedAt: text(row.sqsj),
    status: text(row.cszt),
    batch: text(row.whpc),
    awardBatchLabel: text(row.personuuid),
    province: text(row.szsfmc),
    titleRaw: text(row.rdjb),
    nameRaw: text(row.qymc),
    usccRaw: text(row.tyshxydm),
  }
}
