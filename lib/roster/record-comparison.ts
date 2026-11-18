import { z } from 'zod'
import { TITLE_ORDER } from '../../layers/sme-roster/lib/labels'
import type { PlatformBusinessMetadata } from '../../layers/sme-roster/lib/platform/business-record'

// Negative official source refs are existing record_evidence identities, never DB foreign keys.
const officialSourceRef = z.number().int().safe().refine(id => id !== 0)

export const recordComparisonInput = z.object({
  queryIds: z.array(z.number().int().positive()).min(1).max(500),
  exportBatchIds: z.array(z.number().int().positive()).max(100),
  officialSourceDocumentIds: z.array(officialSourceRef).min(1).max(500),
  proofIds: z.array(z.number().int().positive()).max(500).optional(),
  asOf: z.iso.datetime({ offset: true }).optional(),
  enterpriseId: z.number().int().positive().optional(),
  titleCode: z.enum(TITLE_ORDER as [string, ...string[]]).optional(),
  classification: z.enum(['historical_aligned', 'historical_conflict', 'official_without_correspondence', 'unresolved']).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  businessPage: z.number().int().positive().optional(),
  businessPageSize: z.number().int().min(1).max(200).optional(),
}).strict()
export type RecordComparisonInput = z.infer<typeof recordComparisonInput>
export type HistoricalClassification = NonNullable<RecordComparisonInput['classification']>
export const comparisonSourceCatalogInput = z.object({
  kind: z.enum(['query', 'export_batch', 'official_document']).optional(),
  ids: z.array(officialSourceRef).max(500).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
}).strict().refine(input => input.ids === undefined || input.kind !== undefined, { message: 'kind is required for explicit source IDs' }).refine(input => input.kind === 'official_document' || !input.ids?.some(id => id < 0), { message: 'negative references are only valid for official documents' })
export type ComparisonSourceCatalogInput = z.infer<typeof comparisonSourceCatalogInput>

/** Query parameters are repeated or CSV IDs; never silently select every persisted source. */
export function parseRecordComparisonQuery(query: Record<string, unknown>): RecordComparisonInput {
  const ids = (value: unknown): number[] | undefined => {
    if (value === undefined) return undefined
    if (value === '') return []
    const parts = (Array.isArray(value) ? value : [value]).flatMap(item => String(item).split(','))
    if (parts.some(part => !/^-?\d+$/.test(part.trim()))) return [NaN]
    return parts.map(part => Number(part.trim()))
  }
  const integer = (value: unknown): number | undefined => value === undefined ? undefined : /^\d+$/.test(String(value)) ? Number(value) : NaN
  return recordComparisonInput.parse({
    queryIds: ids(query.queryIds), exportBatchIds: ids(query.exportBatchIds),
    officialSourceDocumentIds: ids(query.officialSourceDocumentIds),
    proofIds: ids(query.proofIds),
    asOf: query.asOf, enterpriseId: integer(query.enterpriseId), titleCode: query.titleCode,
    classification: query.classification, page: integer(query.page), pageSize: integer(query.pageSize),
    businessPage: integer(query.businessPage), businessPageSize: integer(query.businessPageSize),
  })
}

export type ComparisonLinkState = 'linked' | 'later_process' | 'unlinked'
interface GroupableComparisonObservation {
  relation: { id: number; interface: string }
  businessRecord: PlatformBusinessMetadata
  linkState: ComparisonLinkState
  correspondences: Array<{ type: string; role: string; eventId: number | null; predecessorEventId: number | null; exportRowId: number | null; status: string; requiresRevalidation: boolean }>
  historicalDecisionUnavailable: Array<{ id: number }>
  currentSource: { qualification: string } | null
  withoutOfficial: { qualification: string } | null
}

/** Comparison-only pure seam: consumes completed observation results, never decides
 * qualification, discovers sources, or copies a representative observation's proof.
 * Canonical IDs are the sole identity keys. Unknown identities are isolated;
 * known records keep each unknown-content observation outside version nodes.
 */
export function groupComparisonBusinessObservations<T extends GroupableComparisonObservation>(observations: T[], page = 1, pageSize = 25) {
  const knownRecord = (row: T) => row.businessRecord.identityState === 'resolved' && row.businessRecord.recordId !== null
  const knownVersion = (row: T) => knownRecord(row) && row.businessRecord.contentState === 'verified' && row.businessRecord.versionId !== null
  const buckets = new Map<string, T[]>()
  const unknownByState = { not_indexed: 0, missing_key: 0, conflict: 0, unverifiable: 0 }
  let unknownContentObservations = 0
  let unknownIdentityObservations = 0
  for (const observation of observations) {
    const meta = observation.businessRecord
    const key = knownRecord(observation) ? JSON.stringify([observation.relation.interface, meta.recordId]) : `observation:${observation.relation.id}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(observation)
    else buckets.set(key, [observation])
    if (!knownRecord(observation)) {
      unknownIdentityObservations++
      unknownByState[meta.identityState === 'resolved' ? 'not_indexed' : meta.identityState]++
    } else if (!knownVersion(observation)) {
      unknownContentObservations++
      unknownByState.unverifiable++
    }
  }
  const state = (rows: T[]) => {
    const links = new Set(rows.map(row => row.linkState))
    const results = new Set(rows.map(row => JSON.stringify([
      row.linkState, row.currentSource?.qualification ?? null, row.withoutOfficial?.qualification ?? null,
      row.historicalDecisionUnavailable.length > 0,
      row.correspondences.map(edge => [edge.type, edge.role, edge.eventId, edge.predecessorEventId, edge.exportRowId, edge.status, edge.requiresRevalidation]).sort(),
    ])))
    return { linkState: links.size === 1 ? rows[0]!.linkState : 'mixed' as const, resultState: results.size === 1 ? 'uniform' as const : 'mixed' as const }
  }
  const groups = [...buckets.entries()].map(([key, rows]) => {
    const sorted = rows.toSorted((a, b) => a.relation.id - b.relation.id)
    const first = sorted[0]!
    const meta = first.businessRecord
    const versions = new Map<number, T[]>()
    const unknownObservations: T[] = []
    for (const row of sorted) {
      if (!knownVersion(row)) { unknownObservations.push(row); continue }
      const id = row.businessRecord.versionId!
      const version = versions.get(id)
      if (version) version.push(row)
      else versions.set(id, [row])
    }
    return {
      key, recordId: meta.recordId, interface: first.relation.interface, platformKey: meta.platformKey,
      groupState: knownRecord(first) ? 'resolved' as const : meta.identityState === 'resolved' ? 'not_indexed' as const : meta.identityState,
      firstRelationId: first.relation.id, observationCount: sorted.length, ...state(sorted),
      versions: [...versions.entries()].map(([versionId, observations]) => ({ versionId, businessRecord: observations[0]!.businessRecord, observationCount: observations.length, ...state(observations), observations })),
      // These are original observations, not a shared unknown-version node.
      unknownObservations,
    }
  }).sort((a, b) => a.firstRelationId - b.firstRelationId)
  const known = groups.filter(group => group.groupState === 'resolved')
  return {
    businessCounts: { records: known.length, versions: known.reduce((n, group) => n + group.versions.length, 0), observations: observations.length, unknownObservations: unknownIdentityObservations + unknownContentObservations, unknownIdentityObservations, unknownContentObservations, unknownByState },
    businessGroups: { rows: groups.slice((page - 1) * pageSize, page * pageSize), total: groups.length, page, pageSize },
  }
}
