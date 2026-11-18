import type Database from 'better-sqlite3'
import { readCurrentQualificationAssessment, type CurrentTitle } from './lib/roster/current-qualification'

export { getStats as readRosterStatistics } from './lib/query'
export type { Stats as RosterStatistics } from './lib/query'

export interface EffectiveQualification {
  titleCode: CurrentTitle
  basis: string
  supportingTitle?: CurrentTitle
}

/** Evaluate the stored qualification facts for one enterprise at the given time (epoch milliseconds). */
export function readEffectiveQualifications(db: Database.Database, enterpriseId: number, asOf: number): EffectiveQualification[] {
  return readCurrentQualificationAssessment(db, enterpriseId, asOf).titles.flatMap(({ titleCode, effectiveQualification }) => {
    if (effectiveQualification?.status !== 'effective') return []
    const { basis, supportingTitle } = effectiveQualification
    return [{ titleCode, basis, ...(supportingTitle ? { supportingTitle } : {}) }]
  })
}
