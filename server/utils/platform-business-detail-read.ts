import { platformRowTitle } from '../../lib/platform/row-title'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import type { RosterPlatformQueryRow } from '../../lib/roster/enterprise-roster'
import type { PlatformDetailObservation } from '../../lib/roster/platform-business-detail'
import { groupPlatformBusinessDetails } from '../../lib/roster/platform-business-detail'
import type { PlatformFactInterface, PlatformObservationFact } from '../../lib/platform/observation-facts'
import { sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { readPlatformBusinessGroups } from './platform-business-record-read'
import { readPlatformObservationFacts } from './platform-source-facts'
import { normalizeUscc } from '../../lib/domain'

type Db = BetterSQLite3Database<typeof schema>

export type PlatformDetailTypedReadSource = 'typed' | 'legacy'
export const PLATFORM_DETAIL_TYPED_READ_ENV = 'ROSTER_ENTERPRISE_DETAIL_TYPED_READ'

/** Explicit #455 slice-2 rollback. Only the exact value `legacy` disables typed fields;
 * absent/other values keep the typed-first read. */
export function resolvePlatformDetailTypedReadSource(explicit?: PlatformDetailTypedReadSource): PlatformDetailTypedReadSource {
  if (explicit) return explicit
  return process.env[PLATFORM_DETAIL_TYPED_READ_ENV] === 'legacy' ? 'legacy' : 'typed'
}

/** Source-owned typed facts only. This function never reads projection tables directly:
 * each source module owns its projection layout and returns a legacy fallback too. */
function readPlatformDetailFacts(db: Db, queries: RosterPlatformQueryRow[], relations: (typeof schema.platformRelation.$inferSelect)[]) {
  const byQuery = new Map(queries.map(query => [query.id, query]))
  const byInterface = new Map<PlatformFactInterface, number[]>()
  for (const relation of relations) {
    const interfaceName = byQuery.get(relation.queryId)?.interface as PlatformFactInterface | undefined
    if (!interfaceName) continue
    const ids = byInterface.get(interfaceName) ?? []
    ids.push(relation.id); byInterface.set(interfaceName, ids)
  }
  const result = new Map<number, PlatformObservationFact>()
  for (const [interfaceName, ids] of byInterface) {
    for (const [relationId, fact] of readPlatformObservationFacts(db, interfaceName, ids)) result.set(relationId, fact)
  }
  return result
}

/** Caller supplies only displayed enterprise-scoped archives, inside its existing read transaction. */
export function readPlatformBusinessDetails(db: Db, enterpriseId: number, queries: RosterPlatformQueryRow[], relations: (typeof schema.platformRelation.$inferSelect)[], options: { typedReadSource?: PlatformDetailTypedReadSource } = {}) {
  const typedFields = resolvePlatformDetailTypedReadSource(options.typedReadSource) === 'legacy'
    ? new Map<number, PlatformObservationFact>()
    : readPlatformDetailFacts(db, queries, relations)
  const byQuery = new Map(queries.map(q => [q.id, q]))
  const groups = readPlatformBusinessGroups(db, relations.map(archived => {
    const query = byQuery.get(archived.queryId)!
    const row = normalizePlatformRelation(query.interface, archived)
    const rdjb = query.interface === 'recognized_list' ? sourcePositionForSequence(query.collectionEvidence, row.sequenceNo).sourceRdjb ?? '' : platformRowTitle(query.rdjb, row.rawFields)
    const titleCode = (query.interface === 'recognized_list' ? RDJB_TITLE_CODES[rdjb] ?? query.titleCode : query.titleCode ?? RDJB_TITLE_CODES[rdjb]) ?? ''
    const conflicts: string[] = row.normalizationConflicts.length ? ['platform_field_conflict'] : []
    const rawRdjb = typeof row.rawFields?.rdjb === 'string' ? row.rawFields.rdjb : ''
    if (rawRdjb && RDJB_TITLE_CODES[rawRdjb] && titleCode && RDJB_TITLE_CODES[rawRdjb] !== titleCode) conflicts.push('title_conflict')
    const rawUscc = typeof row.rawFields?.tyshxydm === 'string' ? normalizeUscc(row.rawFields.tyshxydm) : ''
    if (rawUscc && normalizeUscc(row.usccRaw) && rawUscc !== normalizeUscc(row.usccRaw)) conflicts.push('identity_conflict')
    return { relationId: row.id, queryId: row.queryId, sequenceNo: row.sequenceNo, interface: query.interface, relationKey: row.relationKey, queriedAt: query.queriedAt, queryStatus: query.status, queryKey: query.queryKey, rdjb, queryTitleCode: query.titleCode ?? null, titleCode, enterpriseId: row.enterpriseId, usccRaw: row.usccRaw, nameRaw: row.nameRaw, verificationStatus: row.verificationStatus, matchBasis: row.matchBasis,
      // Archive grouping has no event/title-role selection. Actual query title is kept above for conflicts.
      target: { eventId: null, enterpriseId, titleCode: '', type: 'archive', role: 'archive' }, evidence: {}, conflicts }
  }))
  const observations = groups.flatMap(g => g.observationRefs).map((o): PlatformDetailObservation => ({ relationId: o.relationId, queryId: o.queryId, queriedAt: o.queriedAt, businessRecord: o.businessRecord, existingCorrespondenceIds: o.existingCorrespondenceIds, existingCorrespondences: o.existingCorrespondences, conflicts: o.conflicts, titleCode: o.titleCode, enterpriseId: o.enterpriseId, usccRaw: o.usccRaw, nameRaw: o.nameRaw, typedFields: typedFields.get(o.relationId)?.projectionVersionId != null ? typedFields.get(o.relationId)! : null })).sort((a, b) => a.relationId - b.relationId)
  return groupPlatformBusinessDetails(observations)
}
