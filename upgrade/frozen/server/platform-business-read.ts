/** Offline historical oracle from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
import { sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../legacy-schema'
import { normalizeName, normalizeUscc } from '../../../layers/sme-roster/lib/domain'

/** Shared read seams for source-specific platform business projections. */
export type Db = BetterSQLite3Database<typeof schema>

export function fail(statusCode: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { statusCode, code })
}

export function pageOf(filter: { page: number; pageSize: number }) {
  return { page: filter.page, pageSize: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }
}

/** Enterprise assignment is always read through the record's own observations. */
export function businessEnterpriseExists(filter: { enterpriseId?: number; q?: string }): SQL | null {
  if (filter.enterpriseId == null && !filter.q) return null
  const clauses: SQL[] = []
  if (filter.enterpriseId != null) clauses.push(sql`r.enterprise_id = ${filter.enterpriseId}`)
  if (filter.q) {
    const name = `%${normalizeName(filter.q)}%`
    const uscc = `%${normalizeUscc(filter.q)}%`
    clauses.push(sql`(e.name_norm LIKE ${name} OR e.uscc_norm LIKE ${uscc})`)
  }
  return sql`exists (
    select 1 from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    left join enterprise e on e.id = r.enterprise_id
    where o.record_id = b.id and ${sql.join(clauses, sql` and `)}
  )`
}

export function enterpriseAssignments(db: Db, recordIds: number[]) {
  if (!recordIds.length) return new Map<number, { ids: number[]; names: string[] }>()
  const ids = sql.join(recordIds.map(id => sql`${id}`), sql`, `)
  const rows = db.all<{ recordId: number; enterpriseId: number | null; name: string | null }>(sql`
    select distinct o.record_id as recordId, r.enterprise_id as enterpriseId, e.name as name
    from platform_business_observation o
    join platform_relation r on r.id = o.relation_id
    left join enterprise e on e.id = r.enterprise_id
    where o.record_id in (${ids})
    order by o.record_id, r.enterprise_id
  `)
  const grouped = new Map<number, { ids: number[]; names: string[] }>()
  for (const row of rows) {
    const entry = grouped.get(row.recordId) ?? { ids: [], names: [] }
    if (row.enterpriseId != null && !entry.ids.includes(row.enterpriseId)) {
      entry.ids.push(row.enterpriseId)
      if (row.name) entry.names.push(row.name)
    }
    grouped.set(row.recordId, entry)
  }
  return grouped
}

const RDJB_ORDER = ['1', '2', '3']

export function orderedScopes(values: Iterable<string>): string[] {
  const unique = [...new Set(values)].filter(Boolean)
  return unique.sort((a, b) => {
    const ai = RDJB_ORDER.indexOf(a), bi = RDJB_ORDER.indexOf(b)
    return (ai < 0 ? RDJB_ORDER.length : ai) - (bi < 0 ? RDJB_ORDER.length : bi) || a.localeCompare(b)
  })
}

/** Explicit query title scopes keyed by query id. Never a per-row title fact. */
export function titleScopesByQuery(db: Db, queryIds: number[]): Map<number, string[]> {
  const scopes = new Map<number, Set<string>>()
  if (!queryIds.length) return new Map<number, string[]>()
  const ids = sql.join(queryIds.map(id => sql`${id}`), sql`, `)
  const rows = db.all<{ queryId: number; rdjb: string; scoped: string | null }>(sql`
    select q.id as queryId, q.rdjb as rdjb, s.rdjb as scoped
    from platform_query q left join platform_query_title_scope s on s.query_id = q.id
    where q.id in (${ids})
  `)
  for (const row of rows) {
    const set = scopes.get(row.queryId) ?? new Set<string>()
    for (const value of row.rdjb.split(',').map(value => value.trim()).filter(Boolean)) set.add(value)
    if (row.scoped) set.add(row.scoped)
    scopes.set(row.queryId, set)
  }
  return new Map([...scopes.entries()].map(([queryId, set]): [number, string[]] => [queryId, orderedScopes(set)]))
}
