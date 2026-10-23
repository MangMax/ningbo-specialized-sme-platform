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
export interface PlatformProjectionResult extends PlatformObservationProjection {
  recordCreated: boolean
  versionCreated: boolean
  observationCreated: boolean
}
export interface PlatformProjectionSummary {
  recordsCreated: number
  versionsCreated: number
  observationsCreated: number
  observationsReused: number
  missingKey: number
  conflict: number
  unverifiable: number
}
