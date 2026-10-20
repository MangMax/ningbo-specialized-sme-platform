import { realpathSync, statSync } from 'node:fs'
import type { RosterDifferenceFilter } from './enterprise-roster'
import type { RosterRecognitionFilter } from './recognitions'

/** Physical identity is conservative evidence, not an atomic ABA guarantee. */
export interface ReadOwnerIdentity { dbPath: string; realpath: string; dev: number; ino: number }
export function readOwnerIdentity(dbPath: string): ReadOwnerIdentity | undefined {
  try {
    const realpath = realpathSync(dbPath), stat = statSync(realpath)
    if (!stat.isFile() || !Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) return
    return { dbPath, realpath, dev: stat.dev, ino: stat.ino }
  } catch { return }
}
export function sameReadOwner(a: ReadOwnerIdentity | undefined, b: ReadOwnerIdentity | undefined): boolean {
  return !!a && !!b && a.realpath === b.realpath && a.dev === b.dev && a.ino === b.ino
}
export type RecognitionReadInput = { operation: 'recognitions'; dbPath: string; owner: ReadOwnerIdentity; filter: RosterRecognitionFilter }
export type DifferenceReadInput = { operation: 'differences'; dbPath: string; owner: ReadOwnerIdentity; filter: RosterDifferenceFilter }
type Json = null | string | number | boolean | Json[] | { [key: string]: Json }
const fields = ['name', 'message', 'statusCode', 'status', 'statusMessage', 'statusText', 'code', 'fatal', 'unhandled', 'data'] as const
export type ReaderError = { h3: boolean; fields: Partial<Record<typeof fields[number], Json | undefined>> }
export type OffmainReadOutcome = { type: 'complete'; body: Buffer } | { type: 'reader-error'; error?: ReaderError }
  | { type: 'fallback' } | { type: 'cancelled' }

function jsonSafe(value: unknown, seen = new Set<object>()): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false
  seen.add(value)
  const safe = Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d && jsonSafe(d.value, seen))
  seen.delete(value)
  return safe
}
/** Finite current native/Drizzle/JS inventory only. Unrepresentable reader
 * exceptions remain terminal; they must never turn into infrastructure replay. */
export function captureReaderError(error: unknown): ReaderError | undefined {
  try {
    if (!(error instanceof Error)) return
    const source = error as Error & Record<string, unknown>
    const result: ReaderError = { h3: (error.constructor as { __h3_error__?: boolean }).__h3_error__ === true, fields: {} }
    for (const field of fields) if (field in source) {
      const value = source[field]
      if (value !== undefined && !jsonSafe(value)) return
      result.fields[field] = value as Json | undefined
    }
    return result
  } catch { return }
}
export function restoreReaderError(error?: ReaderError): Error {
  if (!error) return new Error('Off-main reader error fidelity unavailable')
  // Ordinary errors MUST remain ordinary at H3 ingress (unhandled provenance).
  // The marker is necessary if a marked H3 error ever reaches this boundary,
  // particularly for data:false/0/null, which createError would otherwise drop.
  class MarkedError extends Error { static __h3_error__ = true }
  const result = error.h3 ? new MarkedError() : new Error()
  return Object.assign(result, error.fields)
}
