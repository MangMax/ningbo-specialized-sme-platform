import { insertEnterpriseMerge } from '../../../core/server/public'
import { eq } from 'drizzle-orm'
import type { Executor } from './roster-import'
import { targetSchema as s } from '../../lib/platform/target-schema'
import { currentDifferenceAssignment } from '../../lib/platform/difference-sources'
import { hasEnterpriseMergeIdentity, canonicalEnterpriseId } from '../../lib/roster/enterprise-identity'

/** The merge command changes current attribution by appending revisions; source facts stay intact. */
export function mergeTargetEnterpriseIdentity(db: Executor, input: { fromEnterpriseId: number; intoEnterpriseId: number; basis: string }) {
  if (!hasEnterpriseMergeIdentity(db)) throw new Error('Enterprise identity merge requires the explicit offline target upgrade')
  const into = canonicalEnterpriseId(db, input.intoEnterpriseId)
  if (into === null || into === input.fromEnterpriseId) throw new Error('Invalid enterprise identity merge target')
  if (canonicalEnterpriseId(db, input.fromEnterpriseId) !== input.fromEnterpriseId) throw new Error('Enterprise identity was already merged')
  const a = s.platformObservationAssignment, o = s.platformBusinessObservation
  const assignments = db.select({ assignment: a }).from(o).innerJoin(a, currentDifferenceAssignment(db))
    .where(eq(a.enterpriseId, input.fromEnterpriseId)).all()
  const recordedAt = new Date().toISOString()
  for (const { assignment } of assignments) {
    db.insert(a).values({ ...assignment, revision: assignment.revision + 1, enterpriseId: into,
      origin: 'command', actor: null, basis: input.basis, commandReceiptId: null, recordedAt }).run()
  }
  insertEnterpriseMerge(db, { ...input, intoEnterpriseId: into, recordedAt })
  return assignments.length
}
