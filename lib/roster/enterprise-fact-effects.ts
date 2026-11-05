import type Database from 'better-sqlite3'
/** Whole-consumer rollback leaves all assertion writes and audit history intact. */
export function readEnterpriseFactEffects(db: Database.Database, enterpriseId: number, asOf: number, prepare: (sql: string) => Database.Statement = sql => db.prepare(sql), effectiveOnly = false) {
  if (process.env.ENTERPRISE_FACT_CONSUMER_SOURCE === 'legacy') return null
  const rows = prepare(`select fact_id as factId,revision,status,fact,basis from enterprise_fact_revision where enterprise_id=? order by id`).all(enterpriseId) as {factId:number;revision:number;status:string;fact:string;basis:string}[]
  if (!rows.length) return null
  const heads = new Map(rows.map(r => [r.factId,r]))
  const refs: string[] = [], locations: {kind:string;start:number;end:number}[] = []
  let terminated = false, pending = false
  for (const r of heads.values()) {
    let f: any
    try { f = JSON.parse(r.fact) } catch { pending = true; continue }
    if (!f || typeof f !== 'object') { pending = true; continue }
    if (effectiveOnly && !['cancelled','moved_out'].includes(f.kind)) continue
    refs.push(`enterprise:${enterpriseId}/fact:${r.factId}/revision:${r.revision}`)
    if (r.status === 'withdrawn' || r.status === 'replaced') continue
    // Unknown registration text never implies cancellation.
    if (f.kind === 'registration_status') { pending = true; continue }
    const p = f.effective ?? {}
    let start = NaN, end = NaN
    if (p.precision === 'instant') start = end = Date.parse(p.value)
    if (p.precision === 'day') { start = Date.parse(p.value + 'T00:00:00+08:00'); end = start + 86400000 }
    if (p.precision === 'month' || p.precision === 'year') {
      const [y,m=1] = p.value.split('-').map(Number)
      start = Date.UTC(y,m-1,1)-28800000
      end = Date.UTC(p.precision === 'year' ? y+1 : y,p.precision === 'year' ? 0 : m,1)-28800000
    }
    if (r.status !== 'confirmed' || !r.basis?.trim() || !f.source?.reference?.trim() || !f.source?.statement?.trim() || !Number.isFinite(end) || end > asOf) { pending = true; continue }
    if (f.kind === 'cancelled') terminated = true
    else locations.push({kind:f.kind,start,end})
  }
  // Only a definitely later nonoverlapping interval can supersede another.
  const latest = locations.filter(a => !locations.some(b => b !== a && b.start >= a.end && b.end > a.end))
  const conflict = new Set(latest.map(l => l.kind)).size > 1
  return { refs, terminated, pending: pending || conflict, region: conflict || pending && !effectiveOnly ? 'unresolved' as const : latest[0]?.kind === 'moved_out' ? 'outside_ningbo' as const : latest[0]?.kind === 'moved_in' ? 'ningbo' as const : 'not_established' as const }
}
