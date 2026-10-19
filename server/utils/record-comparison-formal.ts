import type { useDb } from '../../db/client'
import type * as schema from '../../db/schema'

type Event = typeof schema.recordEvent.$inferSelect
type RecordRow = Pick<typeof schema.record.$inferSelect, 'id' | 'enterpriseId' | 'titleCode' | 'source' | 'usccRaw' | 'nameRaw'>
interface FormalRow {
  eventId: number; recordId: number; eventType: Event['eventType']; year: number | null; batchSeq: number | null
  sortKey: number; reviewOutcome: Event['reviewOutcome']; decidedYear: number | null
  enterpriseId: number; titleCode: string; source: RecordRow['source']; usccRaw: string | null; nameRaw: string | null; uscc: string | null
}
/** Global formal counts are contractual. Stream their light facts without an
 * unbounded array of joined ORM rows; no platform archive body participates. */
export function* iterateComparisonFormalEvents(db: ReturnType<typeof useDb>) {
  const rows = db.$client.prepare(`
    select e.id as eventId, e.record_id as recordId, e.event_type as eventType,
      e.year, e.batch_seq as batchSeq, e.sort_key as sortKey,
      e.review_outcome as reviewOutcome, e.decided_year as decidedYear,
      r.enterprise_id as enterpriseId, r.title_code as titleCode, r.source,
      r.uscc_raw as usccRaw, r.name_raw as nameRaw, owner.uscc_norm as uscc
    from record_event e join record r on e.record_id = r.id
    left join enterprise owner on r.enterprise_id = owner.id
    where r.source = 'jxj' and e.event_type in ('award', 'review')
    order by e.id
  `).iterate() as Iterable<FormalRow>
  for (const row of rows) yield {
    event: { id: row.eventId, recordId: row.recordId, eventType: row.eventType, year: row.year, batchSeq: row.batchSeq, sortKey: row.sortKey, reviewOutcome: row.reviewOutcome, decidedYear: row.decidedYear } satisfies Event,
    record: { id: row.recordId, enterpriseId: row.enterpriseId, titleCode: row.titleCode, source: row.source, usccRaw: row.usccRaw, nameRaw: row.nameRaw } satisfies RecordRow,
    uscc: row.uscc,
  }
}
