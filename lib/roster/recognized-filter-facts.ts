/** Narrow returned-row projection. Query predicates are only consistency checks. */
export function recognizedFilterFacts(raw: { rddqrq: unknown; whpcyear: unknown; whpc: unknown }, conditions: { rddqrq: unknown; whpcyear: unknown; whpc: unknown }) {
  const year = (value: unknown) => typeof value === 'string' && /^[1-9]\d{3}$/.test(value) ? Number(value) : null
  const batch = (value: unknown) => typeof value === 'string' && /^(?:[1-9]|1[0-5])$/.test(value) ? Number(value) : null
  const dateYear = (value: unknown) => {
    if (typeof value !== 'string') return null
    const match = /^([1-9]\d{3})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(value)
    if (!match) return null
    const [, y, m, d, h = '00', min = '00', sec = '00'] = match
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
    if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d)
      || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59) return null
    return Number(y)
  }
  const rawValid = dateYear(raw.rddqrq)
  const conditionValid = year(conditions.rddqrq)
  const validYear = rawValid != null && (conditions.rddqrq == null || conditionValid === rawValid) ? rawValid : null
  const rawMaintenanceYear = year(raw.whpcyear)
  const composite = typeof raw.whpc === 'string' ? /^([1-9]\d{3})-([1-9]|1[0-5])$/.exec(raw.whpc) : null
  const compositeYear = composite ? Number(composite[1]) : null
  const rawBatch = composite ? Number(composite[2]) : batch(raw.whpc)
  const rawYearMissing = raw.whpcyear == null || raw.whpcyear === ''
  const maintenanceYear = rawMaintenanceYear != null && (compositeYear == null || compositeYear === rawMaintenanceYear)
    ? rawMaintenanceYear : rawMaintenanceYear == null ? compositeYear : null
  const conditionMaintenanceYear = year(conditions.whpcyear)
  const conditionBatch = batch(conditions.whpc)
  const maintenance = maintenanceYear != null && (rawYearMissing || rawMaintenanceYear != null)
    && (conditions.whpcyear == null || conditionMaintenanceYear === maintenanceYear)
    && (conditions.whpc == null || conditionBatch === rawBatch)
    && (raw.whpc == null || raw.whpc === '' || rawBatch != null)
    ? { year: maintenanceYear, batch: rawBatch } : null
  return { validYear, maintenance }
}
