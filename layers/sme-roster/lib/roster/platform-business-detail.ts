import type { PlatformBusinessMetadata, PlatformBusinessObservationRef } from '../platform/business-record'
import type { PlatformObservationFact } from '../platform/observation-facts'
import { normalizeName, normalizeUscc } from '../domain'

/** Lightweight archive references. No raw body or derived authoritative decision. */
export type PlatformDetailObservation = Pick<PlatformBusinessObservationRef,
  'relationId' | 'queryId' | 'queriedAt' | 'businessRecord' | 'conflicts' | 'titleCode' | 'enterpriseId' | 'usccRaw' | 'nameRaw'> & {
  /** Source-owned typed fact for this observation's content version. `null` means the
   * historical observation has no projection and display must fall back to the legacy
   * relation/raw columns. A present fact's `modeledFields` is authoritative: a modeled
   * field set to null means the archived source value is unknown and must not be backfilled. */
  typedFields?: PlatformObservationFact | null
}
export interface PlatformDetailVersion {
  businessRecord: PlatformBusinessMetadata
  representativeRelationId: number
  observationRefs: PlatformDetailObservation[]
}
export interface PlatformBusinessDetail extends PlatformDetailVersion {
  versions: PlatformDetailVersion[]
  versionCount: number
  observationCount: number
  /** Unverifiable/unindexed content observations; not additional content versions. */
  unknownContentObservationCount: number
  conflicts: string[]
}

function newestFirst(a: PlatformDetailObservation, b: PlatformDetailObservation) {
  return ((Date.parse(b.queriedAt) || 0) - (Date.parse(a.queriedAt) || 0)) || b.relationId - a.relationId
}
function latest(observations: PlatformDetailObservation[]) {
  // Version IDs/indexing time are not chronology. Ties use original relation ID.
  return [...observations].sort(newestFirst)[0]!
}
function version(observationRefs: PlatformDetailObservation[]): PlatformDetailVersion {
  const representative = latest(observationRefs)
  return { businessRecord: representative.businessRecord, representativeRelationId: representative.relationId, observationRefs }
}

export function hasKnownPlatformBusiness(metadata: PlatformBusinessMetadata) {
  return metadata.identityState === 'resolved' && metadata.recordId != null
}

/** Reusable after observation-level filters. Identity and content knowledge are independent. */
export function groupPlatformBusinessDetails(observations: PlatformDetailObservation[]): PlatformBusinessDetail[] {
  const groups = new Map<string, PlatformDetailObservation[]>()
  for (const observation of observations) {
    const m = observation.businessRecord
    const key = JSON.stringify([m.interface, hasKnownPlatformBusiness(m) ? ['record', m.recordId] : ['relation', observation.relationId]])
    const group = groups.get(key) ?? []
    group.push(observation); groups.set(key, group)
  }
  return [...groups.values()].map(observationRefs => {
    const versions = [...Map.groupBy(observationRefs.filter(o => o.businessRecord.groupState === 'verified' && o.businessRecord.versionId != null), o => o.businessRecord.versionId).values()].map(version)
      .sort((a, b) => newestFirst(latest(a.observationRefs), latest(b.observationRefs)))
    const conflicts = new Set(observationRefs.flatMap(o => o.conflicts))
    if (new Set(observationRefs.map(o => normalizeUscc(o.usccRaw)).filter(Boolean)).size > 1 || new Set(observationRefs.map(o => o.enterpriseId).filter(id => id != null)).size > 1 || new Set(observationRefs.map(o => normalizeName(o.nameRaw)).filter(Boolean)).size > 1) conflicts.add('identity_conflict')
    if (new Set(observationRefs.map(o => o.titleCode).filter(Boolean)).size > 1) conflicts.add('title_conflict')
    if (observationRefs.some(o => o.businessRecord.identityState === 'conflict')) conflicts.add('platform_key_conflict')
    return { ...version(observationRefs), versions, versionCount: versions.length, observationCount: observationRefs.length, unknownContentObservationCount: observationRefs.filter(o => o.businessRecord.contentState !== 'verified').length, conflicts: [...conflicts] }
  })
}
