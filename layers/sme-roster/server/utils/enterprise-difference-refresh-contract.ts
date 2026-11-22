import { createHash } from 'node:crypto'
import type { platformCollection } from '../../../../db/postgresql/platform-tables'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}

const sortedRows = (rows: unknown[]) => rows.map(canonical).sort()

const setRows = (rows: unknown[]) => [...new Set(sortedRows(rows))]

const scopeFields = (value: unknown): unknown => Array.isArray(value) ? value.map(scopeFields).sort((a,b)=>canonical(a).localeCompare(canonical(b))) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scopeFields(v)])) : value

// Freeze the original refresh inputs from before the observation-owner expansion.
// Internal projection IDs, archive references and reconciliation columns were
// added later and must not change a business fingerprint.
export const refreshProjectionColumns = {
  platform_apply_projection: ['declare_kind','declaration_year','applied_at','status','name_raw','uscc_raw'],
  platform_business_projection: ['declare_kind','business_year','applied_at','status','batch','award_batch_label','province','name_raw','uscc_raw'],
  platform_recognized_projection: ['validity_date_raw','maintenance_year','maintenance_batch','source_validity_date','source_maintenance_batch','source_maintenance_year_absent','district','award_note','title_raw','name_raw','uscc_raw'],
} satisfies Record<string, string[]>

type RefreshCollection = Pick<typeof platformCollection.$inferSelect,
  'id' | 'interface' | 'queryKey' | 'rdjb' | 'titleCode' | 'queriedAt' | 'status'>

type RefreshMaterials = {
  relations: Record<string, unknown>[]
  typed: Record<string, unknown>[][]
  metadata: string | null
}

export function projectRefreshObservation(q: RefreshCollection, { relations, typed, metadata: metadataText }: RefreshMaterials) {
  let metadata: Record<string, unknown> | null = null
  if (metadataText) {
    try {
      const m = JSON.parse(metadataText)
      metadata = { source: m.source ?? null, status: m.status ?? null,
        effectiveConditions: scopeFields(m.effectiveConditions ?? null), titleScope: scopeFields(m.titleScope ?? null),
        completeness: m.completeness ?? null, fullRange: m.fullRange ?? null,
        pageCoverage: Array.isArray(m.pages) ? setRows(m.pages.map((p: Record<string, unknown>) => ({
          rdjb: p.rdjb ?? null, status: p.status ?? null, declaredTotal: p.declaredTotal ?? null,
        }))) : null }
    } catch { metadata = { malformed: true } }
  }
  return { interface: q.interface, rdjb: q.rdjb, title: q.titleCode, status: q.status,
    metadata, relations: sortedRows(relations), typed: typed.map(sortedRows) }
}

export function hashRefreshInputs({ enterprise, aliases, formal, evidence, correspondences, observations }: {
  enterprise: unknown; aliases: unknown[]; formal: unknown[]; evidence: unknown[]; correspondences: unknown[]; observations: unknown[]
}, version?: string) {
  const hash = createHash('sha256')
  if (version !== undefined) hash.update(version + '\n')
  return hash.update(canonical({ enterprise, aliases: setRows(aliases), formal: sortedRows(formal),
    evidence: sortedRows(evidence), correspondences: setRows(correspondences), observations: setRows(observations) })).digest('hex')
}
