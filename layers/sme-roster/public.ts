import type Database from 'better-sqlite3'
import { applyReviewedEnterprise, type ReviewedSubject } from '../core/server/public'
import { readCurrentQualificationAssessment, type CurrentTitle } from './lib/roster/current-qualification'
import { captureIdentityRevision113, identityMaterial113 } from './server/utils/evidence-impact-113'

export { applyPostgresReviewedRosterIdentity } from './server/utils/postgres-identity-evidence'

export function applyReviewedRosterIdentity(db: Parameters<typeof applyReviewedEnterprise>[0], subject: Extract<ReviewedSubject, { action: 'attach' }>) {
  const owner = subject.enterpriseId
  const before = subject.fields?.name === undefined && subject.fields?.uscc === undefined
    ? null : identityMaterial113(db, owner)
  const applied = applyReviewedEnterprise(db, subject)
  if (before !== null && applied.auditId !== null) {
    captureIdentityRevision113(db, {
      enterpriseId: owner, sourceKey: `enterprise:${owner}`, sourceVersion: `profile:${applied.auditId}`,
      before, after: identityMaterial113(db, owner),
    })
  }
  return applied
}

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
