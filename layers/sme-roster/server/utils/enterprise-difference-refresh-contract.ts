import { createError } from 'h3'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { platformCollection } from '../../../../db/postgresql/platform-tables'
import type { PlatformComparison } from '../../lib/roster/platform-comparison'

export const enterpriseDifferenceRefreshInput = z.strictObject({ enterpriseIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(10000).refine(ids => new Set(ids).size === ids.length, 'Duplicate enterprise IDs').optional() })

const fail = (message: string): never => { throw createError({statusCode:400,message}) }

export function parseEnterpriseDifferenceRefreshQuery(raw: Record<string, unknown>) {
  if (Object.keys(raw).some(key => key !== 'enterpriseIds')) return fail('Unknown refresh query parameter')
  if (raw.enterpriseIds === undefined) return {}
  if (typeof raw.enterpriseIds !== 'string' || !/^[1-9]\d*(,[1-9]\d*)*$/.test(raw.enterpriseIds)) return fail('Invalid enterpriseIds')
  return { enterpriseIds: raw.enterpriseIds.split(',').map(Number) }
}

export function parseEnterpriseDifferenceRefreshInput(raw: unknown) {
  const parsed = enterpriseDifferenceRefreshInput.safeParse(raw)
  if (!parsed.success) return fail('Invalid enterpriseIds; provide distinct positive IDs or omit for all published enterprises')
  return parsed.data
}

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

export function latestRefreshCollections<T extends RefreshCollection>(ordered: readonly T[]): T[] {
  const latest = new Map<string, string>()
  return ordered.filter(q => {
    const key = canonical([q.interface, q.queryKey, q.rdjb, q.titleCode])
    if (latest.has(key) && latest.get(key)! > q.queriedAt) return false
    latest.set(key, q.queriedAt)
    return true
  })
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

export function projectRefreshComparison(result: PlatformComparison) {
  return { state: result.comparison.state, reasons: [...new Set(result.comparison.cycles.flatMap(c => c.reasons))], error: null }
}

export function refreshComparisonFailure(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (message !== 'platform_comparison_scope_unavailable' && message !== 'input_resource_limit') throw error
  return { state: 'not_established' as const, reasons: [message === 'input_resource_limit' ? 'metadata_truncated' : 'coverage_incomplete'], error: message }
}
