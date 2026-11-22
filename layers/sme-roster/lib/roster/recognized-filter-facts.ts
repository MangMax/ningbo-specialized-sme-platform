/** Observed queryBusList innovative_sme projection; predicates never supply facts.
 * See lib/platform/recognized-evidence.ts for the empirical contract and limits.
 */
export function recognizedFilterFacts(
  context: { titleCode: string; schema: 'queryBusList' },
  raw: { rddqrq: unknown; maintenanceYearAbsent: boolean; whpc: unknown },
  conditions: { rddqrq: unknown; whpcyear: unknown },
): { validYear: number | null; maintenance: { year: number; batch: number | null } | null } {
  if (context.titleCode !== 'innovative_sme' || context.schema !== 'queryBusList') return { validYear: null, maintenance: null }
  const year = (value: unknown) => typeof value === 'string' && /^[1-9]\d{3}$/.test(value) ? Number(value) : null
  const dateYear = (value: unknown) => {
    if (typeof value !== 'string') return null
    const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return null
    const [, y, m, d] = match
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
    if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d)) return null
    return Number(y)
  }
  const rawValid = dateYear(raw.rddqrq)
  const validYear = rawValid != null && (conditions.rddqrq == null || year(conditions.rddqrq) === rawValid) ? rawValid : null
  const composite = typeof raw.whpc === 'string' ? /^([1-9]\d{3})-([1-9]|1[0-5])$/.exec(raw.whpc) : null
  // Only the year prefix with an absent returned whpcyear is observed. Neither
  // the suffix nor a submitted batch predicate establishes a positive batch.
  const compositeYear = composite ? Number(composite[1]) : null
  const maintenance = raw.maintenanceYearAbsent && compositeYear != null
    && (conditions.whpcyear == null || year(conditions.whpcyear) === compositeYear)
    ? { year: compositeYear, batch: null } : null
  return { validYear, maintenance }
}
