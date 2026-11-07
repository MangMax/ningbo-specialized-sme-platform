import { countBy, groupBy } from 'es-toolkit'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { TITLE_ORDER } from '../labels'
import { adjudicateQualificationCycles, factTime, type QualificationEvent } from './qualification-cycles'
import { formalValiditySchema } from './formal-validity'
import { readStatisticsEffectiveSnapshot, hydrateStatisticsRows } from './statistics-effective-snapshot'

type Event = QualificationEvent & { enterpriseId: number; titleCode: string; source: string; rawValidity: string | null; revision: number }
type Evidence = { enterpriseId: number; titleCode: string; eventId: number; evidenceId: number; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }
type Fact = { enterpriseId: number; factId: number; revision: number; status: string; fact: string; basis: string }
export type AnnualFilter = { year?: number; title?: string; status: 'effective' | 'pending'; page: number; pageSize: number }

// Match v10 validity validation: source/version gaps are diagnostics, invalid
// cycle links remove linkage/continuation but retain recorded business intervals.
function loadEvents(db: Database.Database, evidence: Evidence[]) {
  const events = db.prepare(`select e.id,e.record_id recordId,r.enterprise_id enterpriseId,r.title_code titleCode,r.source,e.event_type eventType,e.year,e.decided_year decidedYear,e.batch_seq batchSeq,e.review_outcome reviewOutcome,e.revision,e.formal_validity rawValidity from record_event e join record r on r.id=e.record_id order by e.id`).all() as Event[]
  const eventById = new Map(events.map(event => [event.id, event]))
  const evidenceById = new Map(evidence.map(row => [row.evidenceId, row]))
  const files = new Map((db.prepare('select rel_path path,sha256,removed_at removedAt from stored_file').all() as { path: string; sha256: string; removedAt: string | null }[]).map(file => [file.path, file]))
  for (const event of events) {
    if (!event.rawValidity) continue
    try {
      const parsed = formalValiditySchema.safeParse(JSON.parse(event.rawValidity))
      if (!parsed.success) { event.validityInvalid = true; continue }
      const fact = parsed.data
      const candidate = evidenceById.get(fact.evidenceId)
      const ref = candidate?.eventId === event.id ? candidate : undefined
      const file = ref && files.get(ref.sourceFile)
      const origin = fact.originAwardEventId == null ? undefined : eventById.get(fact.originAwardEventId)
      const validLink = fact.originAwardEventId == null || !!origin && origin.recordId === event.recordId && origin.eventType === 'award' && origin.year != null && origin.year === event.year && !(origin.batchSeq != null && event.batchSeq != null && origin.batchSeq !== event.batchSeq)
      event.validityInvalid = !file || !!file.removedAt || file.sha256 !== fact.sourceSha256 || !validLink
      event.formalValidity = validLink ? fact : { ...fact, originAwardEventId: undefined, continuation: undefined }
    } catch { event.validityInvalid = true }
  }
  return events
}

/** Precision intervals describe when an event could have happened, never its
 * ingestion date. End is exclusive for coarse dates; an instant is exact. */
function occurrence(value: { precision?: string; value?: string }) {
  const v = value.value ?? ''
  if (value.precision === 'instant') { const time = Date.parse(v); return { start: time, end: time } }
  if (value.precision === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const start = Date.parse(v + 'T00:00:00+08:00'); return { start, end: start + 86400000 } }
  if (value.precision === 'month' && /^\d{4}-\d{2}$/.test(v) || value.precision === 'year' && /^\d{4}$/.test(v)) {
    const [y, m = 1] = v.split('-').map(Number) as [number, number?]
    if (m < 1 || m > 12) return { start: NaN, end: NaN }
    return { start: Date.UTC(y, m - 1, 1) - 28800000, end: Date.UTC(value.precision === 'year' ? y + 1 : y, value.precision === 'year' ? 0 : m, 1) - 28800000 }
  }
  return { start: NaN, end: NaN }
}
function historicalExclusion(facts: Fact[], cutoff: number) {
  let excluded = false, pending = false
  const references: string[] = []
  if (process.env.ENTERPRISE_FACT_CONSUMER_SOURCE === 'legacy') return { excluded, pending, references }
  for (const row of facts) {
    if (['withdrawn', 'replaced'].includes(row.status)) continue
    try {
      const f = JSON.parse(row.fact)
      // Preserve effectiveOnly: moved_in never grants or repairs moved_out.
      if (!['cancelled', 'moved_out'].includes(f?.kind)) continue
      const interval = occurrence(f.effective ?? {})
      if (interval.start >= cutoff) continue
      references.push(`enterprise:${row.enterpriseId}/fact:${row.factId}/revision:${row.revision}`)
      if (row.status !== 'confirmed' || !row.basis.trim() || !f.source?.reference?.trim() || !f.source?.statement?.trim() || !Number.isFinite(interval.end) || interval.end > cutoff) pending = true
      else excluded = true
    } catch { pending = true }
  }
  return { excluded, pending, references }
}

export function readAnnualStatistics(db: BetterSQLite3Database<typeof schema>, filter: AnnualFilter, asOf = Date.now()) {
  return db.transaction(() => {
    const client = (db as typeof db & { $client: Database.Database }).$client
    const current = readStatisticsEffectiveSnapshot(client, asOf)
    const currentYear = Number(current.evaluationDay.slice(0, 4))
    const evidence = client.prepare(`select r.enterprise_id enterpriseId,r.title_code titleCode,e.id eventId,v.id evidenceId,v.source_file sourceFile,v.attachment,v.list_no listNo,v.page from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id order by v.id`).all() as Evidence[]
    const events = loadEvents(client, evidence)
    const facts = client.prepare('select enterprise_id enterpriseId,fact_id factId,revision,status,fact,basis from enterprise_fact_revision order by id').all() as Fact[]
    const heads = [...new Map(facts.map(f => [`${f.enterpriseId}/${f.factId}`, f])).values()]
    const pairKey = (row: { enterpriseId: number; titleCode: string }) => `${row.enterpriseId}/${row.titleCode}`
    const formalEvents = events.filter(e => e.source === 'jxj' && ['award', 'review'].includes(e.eventType))
    const formalByPair = groupBy(formalEvents, pairKey)
    const evidenceByPair = groupBy(evidence, pairKey)
    const factsByEnterprise = groupBy(heads, f => f.enterpriseId)
    const knownYears = formalEvents.flatMap(e => [factTime(e), e.formalValidity?.interval ? Number(e.formalValidity.interval.validFrom.slice(0, 4)) : null]).filter((y): y is number => y != null && y >= 1900 && y <= currentYear)
    const start = Math.min(currentYear, ...knownYears)
    const selectedYear = filter.year ?? currentYear
    const project = (year: number) => {
      const day = year === currentYear ? current.evaluationDay : `${year}-12-31`
      // Historical year-end includes the whole final Shanghai calendar day.
      const cutoff = Date.parse(`${year + 1}-01-01T00:00:00+08:00`)
      const rows = current.rows.flatMap(pair => {
        const formal = formalByPair[pairKey(pair)] ?? []
        const judgment = adjudicateQualificationCycles(formal.map(e => ({ ...e, validityInvalid: false })), year, day, true)
        const exclusion = historicalExclusion(factsByEnterprise[pair.enterpriseId] ?? [], cutoff)
        const applicable = formal.filter(e => (factTime(e) == null || factTime(e)! <= year) && (e.year == null || e.year <= year) && (!e.formalValidity?.publishedOn || e.formalValidity.publishedOn <= day))
        const witnesses = formal.filter(e => applicable.includes(e) || e.eventType === 'review' && e.formalValidity?.continuation === 'until_this_review_results' && e.formalValidity.publishedOn && e.formalValidity.publishedOn > day && applicable.some(a => a.id === e.formalValidity?.originAwardEventId))
        // Only temporal/conclusion gaps can create annual uncertainty. Let the
        // adjudicator decide whether later definite facts already resolved them;
        // source/batch diagnostics alone still do not override v10 periods.
        const hasTemporalGap = applicable.some(e => factTime(e) == null || e.eventType === 'review' && !e.reviewOutcome)
        const unknownQualification = hasTemporalGap && adjudicateQualificationCycles(
          applicable.map(e => ({ ...e, validityInvalid: false })), year, day,
        ).group === 'pending'
        const status = year === currentYear ? pair.status === 'effective' ? 'effective' : ['terminated', 'moved_out'].includes(pair.status) ? null : unknownQualification ? 'pending' : null
          : exclusion.excluded ? null : judgment.group === 'eligible' ? exclusion.pending ? 'pending' : 'effective' : unknownQualification ? 'pending' : null
        if (!status) return []
        return [{ ...pair, status, evaluationDay: day,
          notes: year === currentYear ? pair.notes : [...judgment.notes, ...(exclusion.pending ? ['排除事实发生时点或证据不足，历史状态待核'] : []), ...(formal.some(e => e.validityInvalid) ? ['来源版本或周期引用待核；沿用 v10 已录入业务期间'] : [])],
          references: year === currentYear ? pair.references : [...witnesses.map(e => `event:${e.id}@${e.revision}`), ...exclusion.references],
          witnessIds: witnesses.map(e => e.id),
        }]
      })
      const counts: Record<string, number> = countBy(rows, row => `${row.titleCode}/${row.status}`)
      return { year, evaluationDay: day, rows, titles: TITLE_ORDER.map(titleCode => ({ titleCode, effective: counts[`${titleCode}/effective`] ?? 0, pending: counts[`${titleCode}/pending`] ?? 0 })) }
    }
    const projections = Array.from({ length: currentYear - start + 1 }, (_, i) => project(start + i))
    const selected = (projections.find(p => p.year === selectedYear) ?? project(selectedYear)).rows.filter(r => (!filter.title || r.titleCode === filter.title) && r.status === filter.status)
    const pageRows = selected.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize)
    const detailed = selectedYear === currentYear ? hydrateStatisticsRows(client, pageRows, asOf) : pageRows
    const { rows: _, titles: __, ...metadata } = current
    return { ...metadata, reconstruction: 'current_recorded_evidence' as const, projectionVersion: 'annual-stock-514-v1',
      years: projections.map(({ rows: _, ...summary }) => summary), ...filter, year: selectedYear,
      total: selected.length, rows: detailed.map(({ witnessIds, ...row }) => {
        const included = new Set(witnessIds)
        return { ...row, evidence: (evidenceByPair[pairKey(row)] ?? []).filter(e => included.has(e.eventId)) }
      }) }
  })
}
export type AnnualStatistics = ReturnType<typeof readAnnualStatistics>
