import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import type { PlatformFactInterface,PlatformObservationFact } from '../../lib/platform/observation-facts'
import type { PlatformStoredRelation } from '../../lib/platform/read'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import type { RosterPlatformQueryRow } from '../../lib/roster/enterprise-roster'
import type { PlatformDetailObservation } from '../../lib/roster/platform-business-detail'
import { groupPlatformBusinessDetails } from '../../lib/roster/platform-business-detail'
import { readCandidateTargetPositions } from './candidate-target-sources'
import { readTargetBusinessProcessFacts } from './platform-business-processes-target'
import { readPlatformBusinessGroups } from './platform-business-record-read'
import { readTargetDeclarationFacts } from './platform-declarations-target'
import { readTargetRecognizedFacts } from './platform-recognized-target'

type Db = BetterSQLite3Database<typeof schema>

/** Source-owned typed facts only. This function never reads projection tables directly:
 * each source module owns its projection layout and captured archive facts. */
export function readPlatformDetailFacts(db: Db, queries: RosterPlatformQueryRow[], relations: PlatformStoredRelation[]) {
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
    const facts = interfaceName === 'apply_list' ? readTargetDeclarationFacts(db, ids, { scope: 'selected' })
      : interfaceName === 'business_list' ? readTargetBusinessProcessFacts(db, ids, { scope: 'selected' })
      : readTargetRecognizedFacts(db, ids)
    for (const [relationId, fact] of facts) {
      // Preserve the enterprise DTO's historical identity-first field order.
      // The accepted source owner still defines field membership and values.
      result.set(relationId, interfaceName === 'recognized_list' ? { ...fact, modeledFields: [
        ...fact.modeledFields.filter(field => field === 'nameRaw' || field === 'usccRaw'),
        ...fact.modeledFields.filter(field => field !== 'nameRaw' && field !== 'usccRaw'),
      ] } : fact)
    }
  }
  return result
}

/** Caller supplies only displayed enterprise-scoped archives, inside its existing read transaction. */
export function readPlatformBusinessDetails(db: Db, enterpriseId: number, queries: RosterPlatformQueryRow[], relations: PlatformStoredRelation[]) {
  const typedFields = readPlatformDetailFacts(db, queries, relations)
  const byQuery = new Map(queries.map(q => [q.id, q]))
  const positions = readCandidateTargetPositions(db, relations.map(row => row.id))
  const groups = readPlatformBusinessGroups(db, relations.map(archived => {
    const query = byQuery.get(archived.queryId)!
    const fact = typedFields.get(archived.id)
    if (!fact?.archiveProcessFacts) throw new Error(`missing_archive_process_facts:${archived.id}`)
    const row = { ...archived, ...fact.archiveProcessFacts, normalizationConflicts: fact.normalizationConflicts }
    const rdjb = query.interface === 'recognized_list' ? positions.get(row.id)?.sourceRdjb ?? '' : query.rdjb.trim() || fact.titleRaw || ''
    const titleCode = (query.interface === 'recognized_list' ? RDJB_TITLE_CODES[rdjb] ?? query.titleCode : query.titleCode ?? RDJB_TITLE_CODES[rdjb]) ?? ''
    const conflicts: string[] = row.normalizationConflicts.length ? ['platform_field_conflict'] : []
    const rawRdjb = fact.titleRaw ?? ''
    if (rawRdjb && RDJB_TITLE_CODES[rawRdjb] && titleCode && RDJB_TITLE_CODES[rawRdjb] !== titleCode) conflicts.push('title_conflict')
    const rawUscc = normalizeUscc(fact.usccRaw)
    if (rawUscc && normalizeUscc(row.usccRaw) && rawUscc !== normalizeUscc(row.usccRaw)) conflicts.push('identity_conflict')
    return { relationId: row.id, queryId: row.queryId, sequenceNo: row.sequenceNo, interface: query.interface, relationKey: row.relationKey, queriedAt: query.queriedAt, queryStatus: query.status, queryKey: query.queryKey, rdjb, queryTitleCode: query.titleCode ?? null, titleCode, enterpriseId: row.enterpriseId, usccRaw: row.usccRaw, nameRaw: row.nameRaw, verificationStatus: row.verificationStatus, matchBasis: row.matchBasis,
      // Archive grouping has no event/title-role selection. Actual query title is kept above for conflicts.
      target: { eventId: null, enterpriseId, titleCode: '', type: 'archive', role: 'archive' }, evidence: {}, conflicts }
  }))
  const observations = groups.flatMap(g => g.observationRefs).map((o): PlatformDetailObservation => ({ relationId: o.relationId, queryId: o.queryId, queriedAt: o.queriedAt, businessRecord: o.businessRecord, existingCorrespondenceIds: o.existingCorrespondenceIds, existingCorrespondences: o.existingCorrespondences, conflicts: o.conflicts, titleCode: o.titleCode, enterpriseId: o.enterpriseId, usccRaw: o.usccRaw, nameRaw: o.nameRaw, typedFields: typedFields.get(o.relationId)?.projectionVersionId != null ? typedFields.get(o.relationId)! : null })).sort((a, b) => a.relationId - b.relationId)
  return groupPlatformBusinessDetails(observations)
}
