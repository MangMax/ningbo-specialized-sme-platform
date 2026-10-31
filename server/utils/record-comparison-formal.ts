import type { useDb } from '../../db/client'
import type * as schema from '../../db/schema'
import type { RecordComparisonInput } from '../../lib/roster/record-comparison'

type Event = Omit<typeof schema.recordEvent.$inferSelect, 'formalValidity'>
type RecordRow = Pick<typeof schema.record.$inferSelect, 'id' | 'enterpriseId' | 'titleCode' | 'source' | 'usccRaw' | 'nameRaw'>
interface FormalRow {
  eventId: number; recordId: number; eventType: Event['eventType']; year: number | null; batchSeq: number | null
  sortKey: number; revision: number; reviewOutcome: Event['reviewOutcome']; decidedYear: number | null
  enterpriseId: number; titleCode: string; source: RecordRow['source']; usccRaw: string | null; nameRaw: string | null; uscc: string | null
  inSelectedSource: number
}
/** Global counts include every formal event, even outside the row/source scope.
 * Aggregate these scalars in SQLite rather than allocating unrelated identities. */
export function* comparisonFormalCounts(db: ReturnType<typeof useDb>) {
  // record_identity_uq guarantees one jxj record per enterprise/title. The
  // existing source and event-record indexes stream groups without a temp sort.
  const counts = db.$client.prepare(`select count(*) from record r
    join record_event e on e.record_id = r.id
    where r.source = 'jxj' and e.event_type in ('award', 'review')
    group by r.id`).pluck().iterate() as Iterable<number>
  let events = 0, enterpriseTitles = 0
  for (const n of counts) {
    events += n
    if (++enterpriseTitles % 256 === 0) yield
  }
  return { events, enterpriseTitles }
}
/** Events outside selected documents are uniformly unresolved. Only hydrate
 * them when row filters or later-process counts require their facts. No name or
 * USCC lookup collapses distinct official record/enterprise identities. */
export function* iterateComparisonFormalEvents(db: ReturnType<typeof useDb>, documentPaths: string[], input: RecordComparisonInput, laterOwners: Array<{ enterpriseId: number | null; titleCode: string }>) {
  const params: Array<number | string> = [JSON.stringify(documentPaths)]
  const rowScope: string[] = []
  if (input.enterpriseId != null) { rowScope.push('r.enterprise_id = ?'); params.push(input.enterpriseId) }
  if (input.titleCode) { rowScope.push('r.title_code = ?'); params.push(input.titleCode) }
  params.push(JSON.stringify(laterOwners))
  const rows = db.$client.prepare(`
    with selected_events as (
      select evidence.record_event_id as id from record_evidence evidence
      where evidence.source_file in (select value from json_each(?))
    ), relevant_records as (
      select r.id from record r where ${rowScope.join(' and ') || '1'}
      union select r.id from json_each(?) later join record r
        on r.enterprise_id = json_extract(later.value, '$.enterpriseId')
        and r.title_code = json_extract(later.value, '$.titleCode')
    ), relevant_events as (
      select id from selected_events
      union select id from record_event where record_id in (select id from relevant_records)
    )
    select e.id as eventId, e.record_id as recordId, e.event_type as eventType,
      e.year, e.batch_seq as batchSeq, e.sort_key as sortKey,
      e.review_outcome as reviewOutcome, e.decided_year as decidedYear, e.revision,
      r.enterprise_id as enterpriseId, r.title_code as titleCode, r.source,
      r.uscc_raw as usccRaw, r.name_raw as nameRaw, owner.uscc_norm as uscc,
      e.id in (select id from selected_events) as inSelectedSource
    from record_event e join record r on e.record_id = r.id
    left join enterprise owner on r.enterprise_id = owner.id
    where e.id in (select id from relevant_events) and r.source = 'jxj' and e.event_type in ('award', 'review')
    order by e.id
  `).iterate(...params) as Iterable<FormalRow>
  for (const row of rows) yield {
    event: { id: row.eventId, recordId: row.recordId, eventType: row.eventType, year: row.year, batchSeq: row.batchSeq, sortKey: row.sortKey, reviewOutcome: row.reviewOutcome, decidedYear: row.decidedYear, revision: row.revision } satisfies Event,
    record: { id: row.recordId, enterpriseId: row.enterpriseId, titleCode: row.titleCode, source: row.source, usccRaw: row.usccRaw, nameRaw: row.nameRaw } satisfies RecordRow,
    uscc: row.uscc,
    inSelectedSource: Boolean(row.inSelectedSource),
  }
}
