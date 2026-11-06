import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { TITLE_ORDER } from '../labels'
import { readStatisticsEffectiveSnapshot } from './statistics-effective-snapshot'
export type DistrictFilter = { title?: string; district?: string; page: number; pageSize: number }
export function readDistrictStatistics(db: BetterSQLite3Database<typeof schema>, filter: DistrictFilter, asOf = Date.now()) {
  return db.transaction(() => {
    const client = (db as typeof db & { $client: Database.Database }).$client
    const { rows, ...metadata } = readStatisticsEffectiveSnapshot(client, asOf)
    const effective = rows.filter(r => r.status === 'effective').map(r => ({ ...r, district: r.district?.trim() ? r.district : null }))
    const districts = [...new Set(effective.map(r => r.district))].sort((a,b) => a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'zh-CN')).map(district => ({ district, titles: TITLE_ORDER.map(titleCode => ({ titleCode, effective: effective.filter(r => r.district === district && r.titleCode === titleCode).length })) }))
    const selected = effective.filter(r => (!filter.title || r.titleCode === filter.title) && (filter.district === undefined || r.district === (filter.district === 'unknown' ? null : filter.district)))
    const evidence = client.prepare(`select r.enterprise_id enterpriseId,r.title_code titleCode,v.id evidenceId,v.source_file sourceFile,v.attachment,v.list_no listNo,v.page from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id order by v.id`).all() as { enterpriseId: number; titleCode: string; evidenceId: number; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[]
    return { ...metadata, districtBasis: 'current_enterprise' as const, ...filter, total: selected.length, districts,
      rows: selected.slice((filter.page-1)*filter.pageSize,filter.page*filter.pageSize).map(r => ({ ...r, evidence: evidence.filter(e => e.enterpriseId === r.enterpriseId && e.titleCode === r.titleCode) })) }
  })
}
export type DistrictStatistics = ReturnType<typeof readDistrictStatistics>
