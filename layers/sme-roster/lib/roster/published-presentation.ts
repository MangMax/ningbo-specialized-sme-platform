import type { OfficialPublishedFact } from './official-evidence-display'
export type { OfficialPublishedFact }

export type PublishedPresentationError = 'invalid_scope' | 'source_limit' | 'field_limit' | 'response_limit' | 'read_failed'
export type PublishedPresentation =
  | { availability: 'available'; error: null; facts: OfficialPublishedFact[] }
  | { availability: 'unavailable'; error: PublishedPresentationError; facts: [] }

export { eventDecisionText, publishedNameText } from './official-evidence-display'
