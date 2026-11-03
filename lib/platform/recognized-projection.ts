/**
 * #461: recognized_list (upstream queryBusList, 平台认定目录) source-specific typed projection.
 *
 * Only fields actually present on the archived row are projected. Query title scope
 * (platform_query.rdjb / platform_query_title_scope) stays a query fact and is never
 * copied onto a content version; a row-level rdjb is retained separately and verbatim.
 *
 * rddqrq is the source 有效期（原值）. It is stored as the verbatim trimmed string:
 * precision and format are preserved and it is never parsed into a date or a year.
 * whpcyear is accepted only as an explicit positive safe integer (JSON number or a
 * decimal-integer string): blank, booleans, fractions, negatives and non-numeric
 * strings are unknown and are never inferred from rddqrq, whpc, id or queriedAt.
 */
export const RECOGNIZED_PROJECTION_RULE = 'platform-recognized-v1'

export interface RecognizedProjectionFields {
  /** Raw rddqrq (有效期/失效日期原值) after trimming; never parsed into a date or year. */
  validityDateRaw: string | null
  /** Explicit positive integer source whpcyear only. */
  maintenanceYear: number | null
  /** Raw whpc (维护批次) after trimming. */
  maintenanceBatch: string | null
  /** Raw szq (属地) after trimming; a returned row value, not the query filter code. */
  district: string | null
  /** Raw rdxx (平台认定说明) after trimming. */
  awardNote: string | null
  /** Raw row-level rdjb (平台称号原值) after trimming; query title scope is stored separately. */
  titleRaw: string | null
  nameRaw: string | null
  usccRaw: string | null
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/** The source returns whpcyear as either a JSON number or a decimal-integer string.
 * Blank, booleans, fractions, negatives, overflow and non-numeric strings are unknown,
 * never coerced into a year. Whitespace is not a decimal integer and is not trimmed. */
function year(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** Pure parser: callers pass the archived raw JSON object as-is. */
export function parseRecognizedRecord(raw: unknown): RecognizedProjectionFields {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return {
    validityDateRaw: text(row.rddqrq),
    maintenanceYear: year(row.whpcyear),
    maintenanceBatch: text(row.whpc),
    district: text(row.szq),
    awardNote: text(row.rdxx),
    titleRaw: text(row.rdjb),
    nameRaw: text(row.qymc),
    usccRaw: text(row.tyshxydm),
  }
}
