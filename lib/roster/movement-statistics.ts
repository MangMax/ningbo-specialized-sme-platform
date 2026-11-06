import type { Database } from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
export const MOVEMENT_KINDS = ['moved_in', 'moved_out', 'cancelled'] as const
export type MovementKind = typeof MOVEMENT_KINDS[number]
export interface MovementFilter { kind?: MovementKind; year?: string; status: string; page: number; pageSize: number }
interface Evidence { factId: number; revision: number; source: { reference: string; statement: string }; basis: string; effective: { precision: string; value: string | null }; year: string | null; pending: boolean }
/** Independent occurrence statistics: never a qualification or mutually exclusive status reader. */
export function readMovementStatistics(db: BetterSQLite3Database<typeof schema>, filter: MovementFilter) {
  return db.transaction(() => {
    const client = (db as typeof db & { $client: Database }).$client
    const heads = client.prepare(`select r.enterprise_id enterpriseId,e.name,r.fact_id factId,r.revision,r.status,r.fact,r.basis
      from enterprise_fact_revision r join enterprise e on e.id=r.enterprise_id
      where not exists(select 1 from enterprise_fact_revision n where n.enterprise_id=r.enterprise_id and n.fact_id=r.fact_id and n.revision>r.revision)
      order by r.enterprise_id,r.fact_id`).all() as { enterpriseId: number; name: string; factId: number; revision: number; status: string; fact: string; basis: string }[]
    const groups = new Map<string, { enterpriseId: number; name: string; kind: MovementKind; evidence: Evidence[] }>()
    for (const r of heads) {
      if (['withdrawn', 'replaced'].includes(r.status)) continue
      let f
      try { f = JSON.parse(r.fact) } catch { continue }
      if (!f || !MOVEMENT_KINDS.includes(f.kind)) continue
      const effective = f.effective ?? { precision: 'unknown', value: null }
      let year: string | null = null
      if (effective.precision === 'instant' && Number.isFinite(Date.parse(effective.value))) year = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Shanghai' }).format(new Date(effective.value))
      else if (['year', 'month', 'day'].includes(effective.precision) && /^\d{4}(?:-\d{2}){0,2}$/.test(effective.value ?? '')) year = effective.value.slice(0, 4)
      const pending = r.status !== 'confirmed' || !r.basis?.trim() || !f.source?.reference?.trim() || !f.source?.statement?.trim()
      const key = `${r.enterpriseId}/${f.kind}`
      if (!groups.has(key)) groups.set(key, { enterpriseId: r.enterpriseId, name: r.name, kind: f.kind, evidence: [] })
      groups.get(key)!.evidence.push({ factId: r.factId, revision: r.revision, source: f.source ?? { reference: '', statement: '' }, basis: r.basis, effective, year, pending })
    }
    // Overlapping opposite location intervals cannot establish an ordered move.
    // Disjoint moves remain independent historical facts, including out then in.
    const interval = (e: Evidence): [number, number] | null => {
      const { precision, value } = e.effective
      if (!value || !e.year) return null
      if (precision === 'instant') { const t = Date.parse(value); return [t, t + 1] }
      const [y, m = 1, d = 1] = value.split('-').map(Number)
      const start = Date.UTC(y!, m - 1, d) - 28800000
      const end = precision === 'year' ? Date.UTC(y! + 1, 0, 1) - 28800000 : precision === 'month' ? Date.UTC(y!, m, 1) - 28800000 : start + 86400000
      return [start, end]
    }
    for (const r of groups.values()) {
      if (r.kind === 'cancelled') continue
      const opposite = groups.get(`${r.enterpriseId}/${r.kind === 'moved_in' ? 'moved_out' : 'moved_in'}`)
      for (const e of r.evidence) {
        const a = interval(e)
        if (a && opposite?.evidence.some(other => { const b = interval(other); return b && a[0] < b[1] && b[0] < a[1] })) e.pending = true
      }
    }
    const years = [...new Set([...groups.values()].flatMap(r => r.evidence.flatMap(e => e.year ? [e.year] : [])))].sort().reverse()
    const scoped = [...groups.values()].map(r => ({ ...r, evidence: r.evidence.filter(e => !filter.year || (filter.year === 'unknown' ? e.year === null : e.year === filter.year)) })).filter(r => r.evidence.length)
    const matches = (e: Evidence, status: string) => status === 'pending' ? e.pending : !e.pending && (status !== 'unknown' || e.year === null)
    const count = (kind: MovementKind, status: string) => scoped.filter(r => r.kind === kind && r.evidence.some(e => matches(e, status))).length
    const kinds = MOVEMENT_KINDS.map(kind => ({ kind, confirmed: count(kind, 'confirmed'), unknown: count(kind, 'unknown'), pending: count(kind, 'pending') }))
    const selected = scoped.filter(r => (!filter.kind || r.kind === filter.kind) && r.evidence.some(e => matches(e, filter.status))).map(r => ({ ...r, evidence: r.evidence.filter(e => matches(e, filter.status)) }))
    return { scope: 'all_entered_enterprises' as const, grain: 'enterprise_kind' as const, kinds, years, rows: selected.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize), total: selected.length, ...filter }
  })
}
export type MovementStatistics = ReturnType<typeof readMovementStatistics>
