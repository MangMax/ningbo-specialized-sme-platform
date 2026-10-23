import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import type { RosterPlatformQueryRow } from '../../lib/roster/enterprise-roster'
import type { PlatformDetailObservation } from '../../lib/roster/platform-business-detail'
import { groupPlatformBusinessDetails } from '../../lib/roster/platform-business-detail'
import { sourcePositionForSequence } from '../../lib/platform/recognized-evidence'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { readPlatformBusinessGroups } from './platform-business-record-read'
import { normalizeUscc } from '../../lib/domain'

/** Caller supplies only displayed enterprise-scoped archives, inside its existing read transaction. */
export function readPlatformBusinessDetails(db: BetterSQLite3Database<typeof schema>, enterpriseId: number, queries: RosterPlatformQueryRow[], relations: (typeof schema.platformRelation.$inferSelect)[]) {
  const byQuery = new Map(queries.map(q => [q.id, q]))
  const groups = readPlatformBusinessGroups(db, relations.map(archived => {
    const query = byQuery.get(archived.queryId)!
    const row = normalizePlatformRelation(query.interface, archived)
    const rdjb = query.interface === 'recognized_list' ? sourcePositionForSequence(query.collectionEvidence, row.sequenceNo).sourceRdjb ?? '' : query.rdjb
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
  const observations = groups.flatMap(g => g.observationRefs).map((o): PlatformDetailObservation => ({ relationId: o.relationId, queryId: o.queryId, queriedAt: o.queriedAt, businessRecord: o.businessRecord, existingCorrespondenceIds: o.existingCorrespondenceIds, existingCorrespondences: o.existingCorrespondences, conflicts: o.conflicts, titleCode: o.titleCode, enterpriseId: o.enterpriseId, usccRaw: o.usccRaw, nameRaw: o.nameRaw })).sort((a, b) => a.relationId - b.relationId)
  return groupPlatformBusinessDetails(observations)
}
