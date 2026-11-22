import type { RecognizedFilterSourceRow } from './recognized-filter-source'

export type RecognizedWitnessResult = { kind: 'available'; source: RecognizedFilterSourceRow } | {
  kind: 'unavailable'
  reason: 'missing' | 'owner' | 'unconfirmed' | 'unverified' | 'fidelity_uncaptured' | 'evidence_uncaptured' | 'not_applicable' | 'position_rejected'
}

export interface RecognizedWitnessReader {
  readMany(input: { enterpriseId: number; uscc: string | null; relationIds: readonly number[] }): ReadonlyMap<number, RecognizedWitnessResult>
}
