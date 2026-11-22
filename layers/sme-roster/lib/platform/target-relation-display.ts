import type { sourcePositionForSequence } from './recognized-evidence'

export type RelationEvidenceDisplaySelection = Readonly<{ relationId: number; queryId?: number }>
/** Original display presentation, deliberately not a PlatformObservationFact or decision input.
 * Callers can render it or attach authorized links.
 */
export type RelationEvidenceDisplay = (Record<string, unknown> & ReturnType<typeof sourcePositionForSequence>) | null
