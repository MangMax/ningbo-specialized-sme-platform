import { sourceDate, type PlatformQualificationFact } from '../../../../lib/roster/platform-qualification'
import type { RosterEventRow, RosterPlatformQueryRow } from './enterprise-roster'
import type { FormalValidity } from '../../../../lib/roster/formal-validity'

type PublicationEvent = RosterEventRow & { formalValidity?: FormalValidity | null }
type BusinessEvent = Pick<PlatformQualificationFact, 'platformName' | 'title' | 'matter' | 'matterRaw' | 'conclusion' | 'statusRaw' | 'businessTimeKind' | 'businessYear' | 'period'> & {
  collectedAt: string | null
  key: string
  businessTime: PlatformQualificationFact['businessTime'] | { value: string; precision: 'year'; raw: string }
}

/** Detail-only presentation: source facts remain owned by the qualification reader.
 * No observation/version or correspondence is a business event. */
export function enterpriseBusinessTimeline(
  enterpriseId: number,
  records: readonly { id: number; titleCode: string }[],
  publications: readonly PublicationEvent[],
  facts: readonly PlatformQualificationFact[],
  queries: readonly Pick<RosterPlatformQueryRow, 'interface' | 'status' | 'queriedAt' | 'id'>[],
) {
  const published: BusinessEvent[] = publications.map(e => {
    const title = records.find(r => r.id === e.recordId)?.titleCode as PlatformQualificationFact['title'] ?? null
    const year = e.eventType === 'review' ? e.decidedYear : e.decidedYear ?? e.year
    const interval = e.formalValidity?.interval
    return {
      key: `publication:${e.id}`, platformName: null, title, matter: e.eventType, matterRaw: e.eventType,
      conclusion: e.eventType === 'award' || e.reviewOutcome === 'passed' ? 'passed' : e.reviewOutcome === 'failed' ? 'invalid' : 'unknown',
      statusRaw: e.reviewOutcome, businessTimeKind: 'recognition', businessYear: year,
      businessTime: year == null ? sourceDate(null) : { raw: String(year), value: String(year), precision: 'year' },
      period: { from: sourceDate(interval?.validFrom ?? null), until: sourceDate(interval?.validThrough ?? null) },
      collectedAt: null,
    }
  })
  const latest = new Map<number, PlatformQualificationFact>()
  for (const f of facts) {
    if (f.enterpriseId !== enterpriseId) continue
    const previous = latest.get(f.recordId)
    if (!previous || f.collectedAt > previous.collectedAt || f.collectedAt === previous.collectedAt && f.observationId > previous.observationId) latest.set(f.recordId, f)
  }
  return { sources: (['publication', 'recognized_list', 'business_list', 'apply_list'] as const).map(source => {
    const query = queries.filter(q => q.interface === source).sort((a, b) => b.queriedAt.localeCompare(a.queriedAt) || b.id - a.id)[0]
    const events: BusinessEvent[] = source === 'publication' ? published : [...latest.values()].filter(f => f.source === source).map(f => ({
      key: `${source}:${f.recordId}`, platformName: f.platformName, title: f.title, matter: f.matter, matterRaw: f.matterRaw, conclusion: f.conclusion, statusRaw: f.statusRaw,
      businessTime: f.businessTime, businessTimeKind: f.businessTimeKind, businessYear: f.businessYear,
      period: f.period, collectedAt: f.collectedAt,
    }))
    events.sort((a, b) => (b.businessTime.value ?? '').localeCompare(a.businessTime.value ?? '') || a.key.localeCompare(b.key))
    return { source, collectionStatus: source === 'publication' ? 'not_applicable' : query?.status ?? 'not_collected', collectedAt: query?.queriedAt ?? null, events }
  }) }
}
