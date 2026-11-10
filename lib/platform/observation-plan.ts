/** Pure source identity/hash planning. Serializer intentionally unchanged. */
import { createHash } from 'node:crypto'
import { parseApplyRecord } from './apply-record'
import { parseBusinessProcess } from './business-projection'
import { parseRecognizedRecord, parseRecognizedSourceFidelity } from './recognized-projection'
export const PLATFORM_PROJECTION_RULE = 'platform-observation-v1'
export const PLATFORM_RAW_HASH_RULE = 'platform-row-json-v1'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** JSON only: do not coerce types, omit values, normalize text or sort arrays. */
export function canonicalPlatformJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from(value, canonicalPlatformJson).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPlatformJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new Error('platform_raw_not_json')
}

const key = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
type Input = { interface: string; relationKey: unknown; rawFields: unknown }
export function platformObservationPayload(input: Input): string {
  return canonicalPlatformJson({ interface: input.interface, relationKey: input.relationKey ?? null, rawFields: input.rawFields ?? null })
}

export function planPlatformObservation(input: Input) {
  const raw = input.rawFields && typeof input.rawFields === 'object' && !Array.isArray(input.rawFields)
    ? input.rawFields as Record<string, unknown> : null
  const relationKey = key(input.relationKey), rawKey = key(raw?.id)
  const identityState = relationKey && rawKey && relationKey !== rawKey ? 'conflict' : relationKey || rawKey ? 'resolved' : 'missing_key'
  const platformKey = identityState === 'resolved' ? relationKey ?? rawKey : null
  const canonicalRawJson = platformKey && raw && Object.keys(raw).length ? canonicalPlatformJson(raw) : null
  return {
    platformKey, identityState,
    contentState: canonicalRawJson ? 'verified' : 'unverifiable',
    keySource: relationKey && rawKey ? 'both' : relationKey ? 'relation_key' : rawKey ? 'raw_id' : 'none',
    canonicalRawJson,
    contentHash: canonicalRawJson ? hash(`${PLATFORM_RAW_HASH_RULE}\n${canonicalRawJson}`) : null,
    // Only a verified single-source version can own typed source fields. Unknown/missing
    // keys stay isolated as observations and never acquire a reusable typed row.
    applyRecord: input.interface === 'apply_list' && canonicalRawJson ? parseApplyRecord(raw) : null,
    businessProjection: input.interface === 'business_list' && canonicalRawJson ? parseBusinessProcess(raw) : null,
    recognizedProjection: input.interface === 'recognized_list' && canonicalRawJson ? parseRecognizedRecord(raw) : null,
    recognizedSourceFidelity: input.interface === 'recognized_list' && canonicalRawJson ? parseRecognizedSourceFidelity(raw!) : null,
  } as const
}

