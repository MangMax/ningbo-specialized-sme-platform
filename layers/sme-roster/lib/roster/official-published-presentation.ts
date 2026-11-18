import type { ReceiptRuntimeContext } from '../../../../server/utils/receipt-runtime-context'
import { publishedNameText, type PublishedPresentation } from './correspondence-view'
import { listEventsOfficialEvidencePages, OfficialEvidenceError } from '../../server/utils/official-evidence'
import { importReceiptRedactor, type OfficialPublishedNameInput, type ReceiptRedactor } from '../../../../server/utils/import-receipt-redaction'

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

/** Same caller snapshot across bounded event chunks and active cursor waves. */
export function readOfficialPublishedPresentation(db: Parameters<typeof importReceiptRedactor>[0], scope: readonly OfficialPublishedScope[], redactor?: ReceiptRedactor, receiptRuntime?: ReceiptRuntimeContext): ReadonlyMap<number, OfficialPublishedFact> {
  const facts = new Map<number, OfficialPublishedFact>(), events = new Set<number>()
  try {
    for (const item of scope) {
      if (![item.eventId, item.evidenceId].every(id => Number.isSafeInteger(id) && id > 0)
        || facts.has(item.evidenceId) && facts.get(item.evidenceId)!.eventId !== item.eventId) throw new OfficialPublishedPresentationError('invalid_scope')
      facts.set(item.evidenceId, { evidenceId: item.evidenceId, eventId: item.eventId, revision: null, availability: 'unknown_legacy', nameRaw: null, sourceBindingKnown: null })
      events.add(item.eventId)
      assertOfficialPublishedBudget(facts.values())
    }
    const redact = events.size ? redactor ?? importReceiptRedactor(db, {}, receiptRuntime) : undefined
    type Entry = { fact: OfficialPublishedFact } | { error: DisplayErrorCode }
    type Pending = { eventId: number; afterEvidenceId?: number; done: boolean; bytes: number; entries: Entry[] }
    const eventIds = [...events]
    for (let start = 0; start < eventIds.length; start += 40) {
      const pending: Pending[] = eventIds.slice(start, start + 40).map(eventId => ({ eventId, done: false, bytes: 2, entries: [] }))
      const byEvent = new Map(pending.map(item => [item.eventId, item]))
      while (pending.some(item => !item.done)) {
        const requests = pending.filter(item => !item.done).map(({ eventId, afterEvidenceId }) => ({ eventId, ...(afterEvidenceId === undefined ? {} : { afterEvidenceId }) }))
        // A validates each complete page, including unselected/private fields.
        // Infrastructure exceptions still fail the entire call immediately.
        const results = listEventsOfficialEvidencePages(db, requests, { pageSize: 50, maxBytes: 65536 })
        for (const result of results) {
          const item = byEvent.get(result.eventId)!
          if (result.error !== undefined) {
            item.entries.push({ error: result.error }); item.done = true
            continue
          }
          const page = result.page
          for (const row of page.rows) {
            if (facts.get(row.evidenceId)?.eventId !== item.eventId) continue
            let fact: OfficialPublishedFact
            try {
              const captured: OfficialPublishedNameInput = { evidenceId: row.evidenceId, eventId: item.eventId, revision: row.revision, availability: 'captured', nameRaw: row.nameRaw, sourceBindingKnown: row.sourceBindingKnown }
              const nameRaw = redact!(captured, 'official_published_name')
              if (nameRaw !== null && typeof nameRaw !== 'string') throw new OfficialPublishedPresentationError('read_failed')
              // Identity, discriminators and flags come from verified storage,
              // while only the display name crosses the redaction capability.
              fact = { ...captured, nameRaw }
            } catch {
              item.entries.push({ error: 'read_failed' }); item.done = true; break
            }
            const bytes = Buffer.byteLength(JSON.stringify(fact)) + 1
            // Retain only a bounded final-fact prefix and the first error's
            // position. Full rows/pages never survive a wave.
            if (item.bytes + bytes > 65536) {
              item.entries.push({ error: 'response_limit' }); item.done = true; break
            }
            item.entries.push({ fact }); item.bytes += bytes
          }
          if (item.done) continue
          const next = page.nextAfterEvidenceId
          if (next !== null && (next <= (item.afterEvidenceId ?? 0) || !page.rows.length)) {
            item.entries.push({ error: 'read_failed' }); item.done = true
          } else {
            item.afterEvidenceId = next ?? undefined; item.done = next === null
          }
        }
      }
      // Event-major/page-major order is deliberate: a later event's first-page
      // error cannot hide an earlier event's later-page or cumulative error.
      for (const item of pending) for (const entry of item.entries) {
        if ('error' in entry) throw new OfficialPublishedPresentationError(entry.error)
        facts.set(entry.fact.evidenceId, entry.fact)
        assertOfficialPublishedBudget(facts.values())
      }
    }
    return facts
  } catch (error) {
    if (error instanceof OfficialPublishedPresentationError) throw error
    const code = error instanceof OfficialEvidenceError && ['source_limit', 'field_limit', 'response_limit'].includes(error.code) ? error.code as DisplayErrorCode : 'read_failed'
    // Never expose SQL, credentials or raw capture envelopes through future public callers.
    throw new OfficialPublishedPresentationError(code)
  }
}

/** Final display projection only; never supplies qualification/assessment input.
 * Source ownership/full-page validation must already have run through the existing
 * reader. The current assessment owns that read; no preloaded-data read option exists.
 */
export function projectOfficialPublishedNames(facts: readonly OfficialPublishedFact[], copies: readonly OfficialPublishedScope[], envelopeCount = 1, textCopies = 1): PublishedPresentation {
  const byEvidence = new Map(facts.map(fact => [fact.evidenceId, fact]))
  const projected = copies.map(item => byEvidence.get(item.evidenceId)!)
  const texts = projected.map(publishedNameText)
  // Moved unchanged from readPublicPublishedNames: final redacted UTF8/escaping.
  const bytes = Buffer.byteLength(JSON.stringify(projected)) + Buffer.byteLength(JSON.stringify(texts)) * textCopies
    + envelopeCount * Buffer.byteLength(JSON.stringify({ publishedPresentation: { availability: 'available', error: null, facts: [] } }))
    + projected.length * Buffer.byteLength(JSON.stringify({ publishedName: null }))
  if (bytes > 65536) throw new OfficialPublishedPresentationError('response_limit')
  return { availability: 'available', error: null, facts: [...facts] }
}

/** Anonymous name sidecar only, after the caller has selected and verified ownership.
 * DTO copies and rendered text copies are budgeted separately; no request data is cached. */
export function readPublicPublishedNames(db: Parameters<typeof readOfficialPublishedPresentation>[0], scope: readonly OfficialPublishedScope[], copies: readonly OfficialPublishedScope[] = scope, envelopeCount = 1, textCopies = 1, redactor?: ReceiptRedactor): PublishedPresentation {
  try {
    const facts = readOfficialPublishedPresentation(db, scope, redactor)
    return projectOfficialPublishedNames([...facts.values()], copies, envelopeCount, textCopies)
  } catch (error) {
    return { availability: 'unavailable', error: error instanceof OfficialPublishedPresentationError ? error.code : 'read_failed', facts: [] }
  }
}
