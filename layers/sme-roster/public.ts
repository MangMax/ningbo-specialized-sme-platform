import type Database from 'better-sqlite3'
import { readCurrentQualificationAssessment, type CurrentTitle } from './lib/roster/current-qualification'

export { readRosterWorkbenchCounts, type RosterWorkbenchCounts } from './lib/query'

export interface EffectiveQualification {
  titleCode: CurrentTitle
  basis: string
  supportingTitle?: CurrentTitle
}

/** Returns null for a missing enterprise, or its effective qualifications at the given time (epoch milliseconds). */
export function readEffectiveQualifications(db: Database.Database, enterpriseId: number, asOf: number): EffectiveQualification[] | null {
  if (!db.prepare('select 1 from enterprise where id = ?').get(enterpriseId)) return null
  return readCurrentQualificationAssessment(db, enterpriseId, asOf).titles.flatMap(({ titleCode, effectiveQualification }) => {
    if (effectiveQualification?.status !== 'effective') return []
    const { basis, supportingTitle } = effectiveQualification
    return [{ titleCode, basis, ...(supportingTitle ? { supportingTitle } : {}) }]
  })
}
