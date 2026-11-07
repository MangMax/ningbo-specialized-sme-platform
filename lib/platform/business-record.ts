import type { ApplyProjectionFields } from './apply-record'
import type { BusinessProjectionFields } from './business-projection'
import type { RecognizedProjectionFields } from './recognized-projection'

/** Storage/write seam for #244. Consumers must scope original observations before grouping. */
export interface PlatformObservationProjection {
  relationId: number
  recordId: number | null
  versionId: number | null
  identityState: 'resolved' | 'missing_key' | 'conflict'
  contentState: 'verified' | 'unverifiable'
  keySource: 'relation_key' | 'raw_id' | 'both' | 'none'
  projectionRuleVersion: string
  inputFingerprint: string
}
/** Planned typed apply_list row. Never includes raw bytes or a client-supplied hash. */
export interface PlatformApplyProjectionPreview extends ApplyProjectionFields {
  ruleVersion: string
}
/** Planned typed business_list row. Never includes raw bytes, query title scope or a client-supplied hash. */
export interface PlatformBusinessProjectionPreview extends BusinessProjectionFields {
  ruleVersion: string
}
/** Planned typed recognized_list row. Never includes raw bytes, query title scope or a client-supplied hash. */
export interface PlatformRecognizedProjectionPreview extends RecognizedProjectionFields {
  ruleVersion: string
}
export interface PlatformProjectionResult extends PlatformObservationProjection {
  syncRequested?: boolean
  recordCreated: boolean
  versionCreated: boolean
  observationCreated: boolean
  /** Present only when an apply_list typed projection was required. */
  applyProjectionCreated?: boolean
  applyProjectionReused?: boolean
  /** Present only when a business_list typed projection was required. */
  businessProjectionCreated?: boolean
  businessProjectionReused?: boolean
  /** Present only when a recognized_list typed projection was required. */
  recognizedProjectionCreated?: boolean
  recognizedProjectionReused?: boolean
}
export interface PlatformProjectionSummary {
  recordsCreated: number
  versionsCreated: number
  observationsCreated: number
  observationsReused: number
  missingKey: number
  conflict: number
  unverifiable: number
  /** Present only when the batch contained typed apply_list projections. */
  applyProjectionsCreated?: number
  applyProjectionsReused?: number
  /** Present only when the batch contained typed business_list projections. */
  businessProjectionsCreated?: number
  businessProjectionsReused?: number
  /** Present only when the batch contained typed recognized_list projections. */
  recognizedProjectionsCreated?: number
  recognizedProjectionsReused?: number
}

/** Read-side DTOs. All references belong to the caller's selected observation scope. */
export type PlatformBusinessGroupState = 'verified' | 'not_indexed' | 'missing_key' | 'conflict' | 'unverifiable'
export interface PlatformBusinessMetadata {
  recordId: number | null
  versionId: number | null
  interface: string
  platformKey: string | null
  groupState: PlatformBusinessGroupState
  identityState: PlatformObservationProjection['identityState'] | 'not_indexed'
  contentState: PlatformObservationProjection['contentState'] | 'not_indexed'
  keySource: PlatformObservationProjection['keySource'] | null
  projectionRuleVersion: string | null
  hashAlgorithm: string | null
  contentHash: string | null
}
export interface PlatformCorrespondenceRef {
  id: number
  relationId: number | null
  exportRowId: number | null
  eventId: number | null
  predecessorEventId: number | null
  enterpriseId: number | null
  titleCode: string
  type: string
  role: string
  status: 'candidate' | 'confirmed' | 'rejected' | 'unlinked'
  revision: number
  ruleId: string
  ruleVersion: string
  createdAt: string
  decidedAt: string | null
  endedAt: string | null
}
export interface PlatformBusinessTarget {
  eventId: number | null
  enterpriseId: number
  titleCode: string
  type: string
  role: string
}
/** Input is already filtered by query/time/owner/title/role and original business rules. */
export interface ScopedPlatformObservation {
  relationId: number
  queryId: number
  sequenceNo: number
  interface: string
  relationKey: string | null
  queriedAt: string
  queryStatus: string
  queryKey: string
  rdjb: string
  queryTitleCode: string | null
  titleCode: string
  enterpriseId: number | null
  usccRaw: string | null
  nameRaw: string | null
  verificationStatus: string
  matchBasis: string
  target: PlatformBusinessTarget
  evidence: Record<string, unknown>
  conflicts: string[]
}
export interface PlatformBusinessObservationRef extends ScopedPlatformObservation {
  businessRecord: PlatformBusinessMetadata
  existingCorrespondenceIds: number[]
  existingCorrespondences: PlatformCorrespondenceRef[]
}
export interface PlatformBusinessGroup {
  businessRecord: PlatformBusinessMetadata
  representativeRelationId: number
  observationRefs: PlatformBusinessObservationRef[]
  existingCorrespondenceIds: number[]
  existingCorrespondences: PlatformCorrespondenceRef[]
  conflicts: string[]
}
