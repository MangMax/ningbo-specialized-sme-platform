import type { PlatformBusinessMetadata, PlatformBusinessObservationRef, PlatformCorrespondenceRef } from '../platform/business-record'
import { normalizeName, normalizeUscc } from '../domain'

/** Source-specific typed projection values for one observation's content version.
 * `null` typedFields means the historical observation has no typed row and readers keep
 * the legacy normalizePlatformRelation path. A present object with a null field means the
 * archived source field is empty/unknown and must not be backfilled from raw or import columns.
 * Fields missing from the object are not modeled by that source projection (for example
 * apply_list has no batch/province column), so display keeps the legacy column. */
export interface PlatformDetailTypedFields {
  interface: 'apply_list' | 'business_list' | 'recognized_list'
  ruleVersion: string
  nameRaw: string | null
  usccRaw: string | null
  declareKind?: string | null
  year?: number | null
  appliedAt?: string | null
  status?: string | null
  batch?: string | null
  province?: string | null
  validityDateRaw?: string | null
  maintenanceYear?: number | null
  maintenanceBatch?: string | null
  district?: string | null
  awardNote?: string | null
}

/** Lightweight archive references. No raw body or derived authoritative decision. */
export type PlatformDetailObservation = Pick<PlatformBusinessObservationRef,
  'relationId' | 'queryId' | 'queriedAt' | 'businessRecord' | 'existingCorrespondenceIds' | 'existingCorrespondences' | 'conflicts' | 'titleCode' | 'enterpriseId' | 'usccRaw' | 'nameRaw'> & {
  /** Keyed by relationId but sourced from its versionId; null for unprojected history. */
  typedFields?: PlatformDetailTypedFields | null
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
  existingCorrespondenceIds: number[]
  existingCorrespondences: PlatformCorrespondenceRef[]
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
    const existingCorrespondences = [...new Map(observationRefs.flatMap(o => o.existingCorrespondences).map(c => [c.id, c])).values()].sort((a, b) => a.id - b.id)
    const conflicts = new Set(observationRefs.flatMap(o => o.conflicts))
    if (new Set(observationRefs.map(o => normalizeUscc(o.usccRaw)).filter(Boolean)).size > 1 || new Set(observationRefs.map(o => o.enterpriseId).filter(id => id != null)).size > 1 || new Set(observationRefs.map(o => normalizeName(o.nameRaw)).filter(Boolean)).size > 1) conflicts.add('identity_conflict')
    if (new Set(observationRefs.map(o => o.titleCode).filter(Boolean)).size > 1) conflicts.add('title_conflict')
    if (observationRefs.some(o => o.businessRecord.identityState === 'conflict')) conflicts.add('platform_key_conflict')
    for (const priors of Map.groupBy(existingCorrespondences.filter(c => c.status !== 'candidate'), c => JSON.stringify([c.type, c.role])).values()) {
      if (new Set(priors.map(c => c.status)).size > 1 || new Set(priors.map(c => JSON.stringify([c.eventId, c.predecessorEventId, c.exportRowId, c.enterpriseId, c.titleCode]))).size > 1) conflicts.add('correspondence_decision_conflict')
    }
    return { ...version(observationRefs), versions, versionCount: versions.length, observationCount: observationRefs.length, unknownContentObservationCount: observationRefs.filter(o => o.businessRecord.contentState !== 'verified').length, existingCorrespondenceIds: existingCorrespondences.map(c => c.id), existingCorrespondences, conflicts: [...conflicts] }
  })
}
