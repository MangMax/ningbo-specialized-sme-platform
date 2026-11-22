import type { sourcePositionForSequence } from './recognized-evidence'

export type RelationEvidenceDisplaySelection = Readonly<{ relationId: number; queryId?: number }>
/** Original display presentation, deliberately not a PlatformObservationFact or decision input.
 * Callers render it or attach separately authorized links; no correspondences property is fabricated.
 */
export type RelationEvidenceDisplay = (Record<string, unknown> & ReturnType<typeof sourcePositionForSequence>) | null
