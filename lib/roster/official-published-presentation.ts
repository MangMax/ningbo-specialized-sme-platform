import { listEventOfficialEvidence, OfficialEvidenceError } from '../../server/utils/official-evidence'
import { importReceiptRedactor } from '../../server/utils/import-receipt-redaction'

/** Minimal display facts only. Locators stay on the caller's existing evidence. */
export type OfficialPublishedFact = {
  evidenceId: number; eventId: number
} & (
  | { availability: 'captured'; revision: number; nameRaw: string | null; sourceBindingKnown: boolean }
  | { availability: 'unknown_legacy' | 'unavailable'; revision: null; nameRaw: null; sourceBindingKnown: null }
)
export type OfficialPublishedScope = { evidenceId: number; eventId: number }
type DisplayErrorCode = 'invalid_scope' | 'source_limit' | 'field_limit' | 'response_limit' | 'read_failed'
export class OfficialPublishedPresentationError extends Error {
  constructor(readonly code: DisplayErrorCode) { super('Official published display unavailable: ' + code) }
}

/** Includes the final redacted DTO and all additional formatted text, without truncation. */
export function assertOfficialPublishedBudget(facts: Iterable<OfficialPublishedFact>, texts: readonly string[] = []) {
  if (Buffer.byteLength(JSON.stringify([...facts])) + Buffer.byteLength(JSON.stringify(texts)) > 65536) {
    throw new OfficialPublishedPresentationError('response_limit')
  }
}

/** Caller-scoped, request-local event pagination; no cross-event SQL or shared cache. */
export function readOfficialPublishedPresentation(db: Parameters<typeof importReceiptRedactor>[0], scope: readonly OfficialPublishedScope[]): ReadonlyMap<number, OfficialPublishedFact> {
  const facts = new Map<number, OfficialPublishedFact>(), events = new Set<number>()
  try {
    for (const item of scope) {
      if (![item.eventId, item.evidenceId].every(id => Number.isSafeInteger(id) && id > 0)
        || facts.has(item.evidenceId) && facts.get(item.evidenceId)!.eventId !== item.eventId) throw new OfficialPublishedPresentationError('invalid_scope')
      facts.set(item.evidenceId, { evidenceId: item.evidenceId, eventId: item.eventId, revision: null, availability: 'unknown_legacy', nameRaw: null, sourceBindingKnown: null })
      events.add(item.eventId)
      assertOfficialPublishedBudget(facts.values())
    }
    const redact = events.size ? importReceiptRedactor(db) : undefined
    for (const eventId of events) {
      let afterEvidenceId: number | undefined
      do {
        // A checks the complete event scope and true latest before projecting this page.
        // A large 50-row page may fail 64KiB; never shrink/retry or label unread rows legacy.
        const page = listEventOfficialEvidence(db, eventId, { pageSize: 50, maxBytes: 65536, ...(afterEvidenceId === undefined ? {} : { afterEvidenceId }) })
        for (const row of page.rows) {
          if (facts.get(row.evidenceId)?.eventId !== eventId) continue
          const fact = redact!({ evidenceId: row.evidenceId, eventId, revision: row.revision, availability: 'captured', nameRaw: row.nameRaw, sourceBindingKnown: row.sourceBindingKnown }) as OfficialPublishedFact
          facts.set(row.evidenceId, fact)
          assertOfficialPublishedBudget(facts.values())
        }
        afterEvidenceId = page.nextAfterEvidenceId ?? undefined
      } while (afterEvidenceId !== undefined)
    }
    return facts
  } catch (error) {
    if (error instanceof OfficialPublishedPresentationError) throw error
    const code = error instanceof OfficialEvidenceError && ['source_limit', 'field_limit', 'response_limit'].includes(error.code) ? error.code as DisplayErrorCode : 'read_failed'
    // Never expose SQL, credentials or raw capture envelopes through future public callers.
    throw new OfficialPublishedPresentationError(code)
  }
}
