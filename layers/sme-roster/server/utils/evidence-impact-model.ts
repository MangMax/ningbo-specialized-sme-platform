import type * as s from '../../../../db/schema'
import { evidenceDigest113 } from './evidence-digest'

export type EvidenceScope113 = { enterpriseId: number; titleCode: string; direction: 'missing_in_miit' | 'extra_in_miit' }

export interface RevisionInput {
  sourceKind: string; sourceKey: string; sourceVersion: string
  enterpriseId?: number | null; titleCode?: string | null; direction?: string | null; eventId?: number | null
  coverageDigest?: string; factDigest: string; beforeFactDigest?: string; queryExecuted?: boolean; preserveFacts?: boolean
  metadata?: Record<string, unknown>
}

export const scopeKey113 = (enterpriseId: number | null, titleCode: string | null, direction: string | null) => JSON.stringify([enterpriseId, titleCode, direction])

export function evidenceKeys113(scope: EvidenceScope113) {
  return [scope.enterpriseId, null].flatMap(e => [scope.titleCode, null].flatMap(t => [scope.direction, null].map(d => scopeKey113(e, t, d))))
}
export function evidenceToken113(scope: EvidenceScope113, decisionId: number | null, versions: Array<typeof s.evidenceScopeVersion113.$inferSelect>) {
  return { ...scope, decisionId, latestRevisionId: Math.max(0, ...versions.map(v => v.latestRevisionId)), projectionReady: versions.every(v => v.pendingCount === 0) }
}

type QueryRevision = Pick<typeof s.platformCollection.$inferSelect, 'interface' | 'queryKey' | 'titleCode' | 'rdjb' | 'status' | 'pageSize' | 'fullRange'>
  & { id: number; conditions: string; pages: string; completeness: string | null; unfinished: string }
export function projectQueryEvidenceRevisions(q: QueryRevision, exactOwner: number | null,
  originalRelations: Iterable<{ id: number; enterpriseId: number | null; sequenceNo: number; material: unknown[] }>): RevisionInput[] {
  const queryId = q.id
  const titleFor: Record<string, string> = { '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' }
  type Page = { rdjb: string | null; page: number; status: string; fetchedCount: number; declaredTotal: number | null; maxPage?: number | null }
  const pages: Page[] = JSON.parse(q.pages ?? '[]'), conditions = JSON.parse(q.conditions ?? '{}')
  const titles = [...new Set([...(q.titleCode ? [q.titleCode] : []), ...q.rdjb.split(',').flatMap(r => titleFor[r] ? [titleFor[r]!] : []), ...pages.flatMap(p => p.rdjb && titleFor[p.rdjb] ? [titleFor[p.rdjb]!] : [])])]
  // queryList has no title partition. Preserve unknown scope without claiming title coverage.
  const partitions: Array<string | null> = q.interface === 'apply_list' ? [null] : titles.length ? titles : [null]
  const facts = new Map<string, { enterpriseId: number; titleCode: string | null; hashes: string[] }>()
  const get = (enterpriseId: number, titleCode: string | null) => {
    const key = `${enterpriseId}:${titleCode ?? '*'}`
    if (!facts.has(key)) facts.set(key, { enterpriseId, titleCode, hashes: [] })
    return facts.get(key)!
  }
  if (exactOwner) for (const title of partitions) get(exactOwner, title)
  let lastRelationId = 0
  for (const row of originalRelations) {
    lastRelationId = row.id
    if (row.enterpriseId == null) continue
    let title: string | null = partitions.length === 1 ? partitions[0]! : null
    if (pages.length) {
      let offset = 0
      for (const page of pages) { if (page.status !== 'success') continue; offset += page.fetchedCount; if (row.sequenceNo <= offset) { title = page.rdjb ? titleFor[page.rdjb] ?? null : null; break } }
    }
    // An unpartitioned multi-title relation is not attributed to every requested title.
    if (partitions.length > 1 && title === null) continue
    get(row.enterpriseId, title).hashes.push(evidenceDigest113(row.material))
  }
  return [...facts.values()].map(group => {
    const rdjb = Object.keys(titleFor).find(r => titleFor[r] === group.titleCode)
    const ownPages = pages.filter(p => p.rdjb == null || p.rdjb === rdjb).map(p => ({ rdjb: p.rdjb, page: p.page, status: p.status, fetchedCount: p.fetchedCount, declaredTotal: p.declaredTotal, maxPage: p.maxPage ?? null }))
    const unfinished = (JSON.parse(q.unfinished ?? '[]') as Array<{ rdjb: string | null; page: number }>).filter(p => p.rdjb == null || p.rdjb === rdjb)
    // Page positions and explicit filters/time windows are part of scope; occurrence time is history only.
    const partition = { interface: q.interface, queryKey: q.queryKey, title: group.titleCode, conditions, positions: ownPages.map(p => [p.rdjb, p.page]), pageSize: q.pageSize }
    const ownStatus = ownPages.length ? ownPages.some(p => p.status === 'success') ? 'executed' : 'failed' : q.status
    const coverage = { status: ownStatus, queryStatus: q.status, pages: ownPages, completeness: q.completeness, fullRange: q.fullRange, unfinished }
    const completeEmpty = q.completeness === 'complete' && q.fullRange === 1 && ownPages.length > 0 && ownPages.every(p => p.status === 'success' && p.fetchedCount === 0 && (p.declaredTotal ?? 0) === 0)
    return { sourceKind: 'query_archive', sourceKey: `${group.enterpriseId}:${evidenceDigest113(partition)}`, sourceVersion: `${queryId}:${lastRelationId}`, enterpriseId: group.enterpriseId, titleCode: group.titleCode,
      factDigest: evidenceDigest113(group.hashes.length ? [...new Set(group.hashes)].sort() : completeEmpty ? ['complete_no_record'] : []), preserveFacts: group.hashes.length === 0 && !completeEmpty, coverageDigest: evidenceDigest113(coverage),
      queryExecuted: group.titleCode != null && q.status !== 'not_queried' && (group.hashes.length > 0 || !q.queryKey.startsWith('name:') && group.enterpriseId === exactOwner),
      metadata: { queryId, interface: q.interface, titleCode: group.titleCode, conditions, pagePositions: ownPages.map(p => p.page), fullRange: q.fullRange, coverageOnly: group.hashes.length === 0 },
    }
  })
}

export function queryImpactRelevant113(metadata: Record<string, unknown>, titleCode: string, old: {
  interface: string; conditions: Record<string, unknown>; pages: Array<{ rdjb: string | null; page: number | null }>; fullRange: number | null
} | null) {
  if (!old || old.interface !== metadata.interface) return true
  const before = old.conditions, after = metadata.conditions as Record<string, unknown>
  for (const field of ['whpcyear','whpc','szq','sqsj','rddqrq']) if (before[field] != null && after[field] != null && before[field] !== after[field]) return false
  if (old.fullRange === 0 && metadata.fullRange === 0) {
    const rdjb = ({ innovative_sme: '1', specialized_sme: '2', little_giant: '3' } as Record<string, string>)[titleCode]
    const pages = old.pages.filter(p => p.rdjb === rdjb || p.rdjb == null)
    const positions = metadata.pagePositions as number[]
    if (pages.length && positions.length && !pages.some(p => p.page !== null && positions.includes(p.page))) return false
  }
  return true
}
