export { PlatformProjectionError } from '../../lib/platform/projection-error'
import type { PlatformObservationProjection, PlatformApplyProjectionPreview, PlatformBusinessProjectionPreview, PlatformRecognizedProjectionPreview } from '../../lib/platform/business-record'
import { APPLY_PROJECTION_RULE, type ApplyProjectionFields } from '../../lib/platform/apply-record'
import { BUSINESS_PROJECTION_RULE, type BusinessProjectionFields } from '../../lib/platform/business-projection'
import { RECOGNIZED_PROJECTION_RULE, type RecognizedProjectionFields } from '../../lib/platform/recognized-projection'
export { PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE, canonicalPlatformJson, platformObservationPayload, planPlatformObservation } from '../../lib/platform/observation-plan'

export function projectionPreview(plan: Omit<PlatformObservationProjection, 'recordId' | 'versionId'>) {
  return { relationId: plan.relationId, identityState: plan.identityState, contentState: plan.contentState, keySource: plan.keySource, projectionRuleVersion: plan.projectionRuleVersion, inputFingerprint: plan.inputFingerprint }
}

/** Planned apply_list fields for preflight only. Raw bytes and hashes stay server-side. */
export function applyProjectionPreview(plan: { applyRecord: ApplyProjectionFields | null }): PlatformApplyProjectionPreview | null {
  return plan.applyRecord ? { ...plan.applyRecord, ruleVersion: APPLY_PROJECTION_RULE } : null
}

/** Planned business_list fields for preflight only. Query title scope and raw bytes stay server-side. */
export function businessProjectionPreview(plan: { businessProjection: BusinessProjectionFields | null }): PlatformBusinessProjectionPreview | null {
  return plan.businessProjection ? { ...plan.businessProjection, ruleVersion: BUSINESS_PROJECTION_RULE } : null
}

/** Planned recognized_list fields for preflight only. Query title scope and raw bytes stay server-side. */
export function recognizedProjectionPreview(plan: { recognizedProjection: RecognizedProjectionFields | null }): PlatformRecognizedProjectionPreview | null {
  return plan.recognizedProjection ? { ...plan.recognizedProjection, ruleVersion: RECOGNIZED_PROJECTION_RULE } : null
}
