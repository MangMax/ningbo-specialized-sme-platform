/**
 * #452: apply_list (upstream queryList) source-specific typed projection.
 *
 * Only fields actually present on the archived row are projected. Unknown strings
 * (including non-dictionary sblx/cszt values) are preserved; missing or blank
 * values stay null. A declaration year is accepted only as an explicit positive
 * integer (JSON number or a decimal-integer string): it is never inferred from
 * sqsj, queriedAt, batch or a title.
 */
export const APPLY_PROJECTION_RULE = 'platform-apply-v1'

export interface ApplyProjectionFields {
  /** Raw sblx after trimming; unknown dictionary values are retained. */
  declareKind: string | null
  /** Explicit positive integer source year only. */
  declarationYear: number | null
  /** Raw sqsj after trimming. */
  appliedAt: string | null
  /** Raw cszt after trimming. */
  status: string | null
  nameRaw: string | null
  usccRaw: string | null
  province: string | null
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/** The source returns year as either a JSON number or a decimal-integer string.
 * Empty/blank, booleans, fractions, negatives and non-numeric strings are unknown,
 * never coerced into a year. */
function year(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** Pure parser: callers pass the archived raw JSON object as-is. */
export function parseApplyRecord(raw: unknown): ApplyProjectionFields {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return {
    declareKind: text(row.sblx),
    declarationYear: year(row.year),
    appliedAt: text(row.sqsj),
    status: text(row.cszt),
    nameRaw: text(row.qymc),
    usccRaw: text(row.tyshxydm),
    province: text(row.szsfmc),
  }
}
