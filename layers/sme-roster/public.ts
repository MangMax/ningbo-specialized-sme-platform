import { projectEffectiveQualifications, type EffectiveQualification } from './lib/roster/effective-qualifications'
import type Database from 'better-sqlite3'
import { applyReviewedEnterprise, type ReviewedSubject } from '../core/server/public'
import { readCurrentQualificationAssessment } from './lib/roster/current-qualification'
import { captureIdentityRevision113, identityMaterial113 } from './server/utils/evidence-impact-113'

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

export type { EffectiveQualification } from './lib/roster/effective-qualifications'
export { readPostgresCurrentQualification, readPostgresEffectiveQualifications, type PostgresQualificationTransaction } from './lib/roster/current-qualification-postgres'

/** Returns null for a missing enterprise, or its effective qualifications at the given time (epoch milliseconds). */
export function readEffectiveQualifications(db: Database.Database, enterpriseId: number, asOf: number): EffectiveQualification[] | null {
  if (!db.prepare('select 1 from enterprise where id = ?').get(enterpriseId)) return null
  return projectEffectiveQualifications(readCurrentQualificationAssessment(db, enterpriseId, asOf).titles)
}
