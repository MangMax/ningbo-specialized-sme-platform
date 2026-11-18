import { countBy } from 'es-toolkit'
import type { Database } from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { TITLE_ORDER } from '../labels'

/** Formal award history only. Current qualification, platform maintenance and reviews
 * cannot create or remove a published enterprise. Identity follows stored IDs;
 * ambiguous identities are retained in a separate pending rowset. */
export function readPublishedStatistics(db: BetterSQLite3Database<typeof schema>, filter: { title?: string; status: string; page: number; pageSize: number }) {
  return db.transaction(() => {
    const client = (db as BetterSQLite3Database<typeof schema> & { $client: Database }).$client
    const predicate = `v.event_type='award' and exists (select 1 from record_evidence ev where ev.record_event_id=v.id)`
    const pairs = client.prepare(`select e.id enterpriseId,e.name,e.uscc_norm uscc,r.title_code titleCode,
      case when exists(select 1 from json_each(coalesce(e.quality_flags,'[]')) where value='name_ambiguous')
      or (e.uscc_norm is null and exists(select 1 from enterprise other where other.name_norm=e.name_norm and other.id!=e.id))
      or exists(select 1 from record rr,json_each(coalesce(rr.quality_flags,'[]')) f where rr.enterprise_id=e.id and rr.title_code=r.title_code and f.value='name_ambiguous') then 'pending' else 'confirmed' end status
      from enterprise e join record r on r.enterprise_id=e.id join record_event v on v.record_id=r.id
      where ${predicate} group by e.id,r.title_code order by e.id,r.title_code`).all() as { enterpriseId: number; name: string; uscc: string | null; titleCode: string; status: string }[]
    const counts = countBy(pairs, row => `${row.titleCode}/${row.status}`)
    const titles = TITLE_ORDER.map(titleCode => ({ titleCode,
      confirmed: counts[`${titleCode}/confirmed`] ?? 0,
      pending: counts[`${titleCode}/pending`] ?? 0,
    }))
    const selected = pairs.filter(r => (!filter.title || r.titleCode === filter.title) && r.status === filter.status)
    const evidenceQuery = client.prepare(`select v.id eventId,ev.id evidenceId,ev.source_file sourceFile,ev.attachment,ev.list_no listNo,ev.page
        from record r join record_event v on v.record_id=r.id join record_evidence ev on ev.record_event_id=v.id
        where r.enterprise_id=? and r.title_code=? and v.event_type='award' order by ev.id`)
    const rows = selected.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize).map(row => ({ ...row,
      evidence: evidenceQuery.all(row.enterpriseId, row.titleCode) as { eventId: number; evidenceId: number; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[],
    }))
    return { grain: 'enterprise_title' as const, basis: 'formal_award_evidence' as const, titles, rows, total: selected.length, ...filter }
  })
}
export type PublishedStatistics = ReturnType<typeof readPublishedStatistics>
