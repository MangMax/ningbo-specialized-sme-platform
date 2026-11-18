import { and, desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../../db/schema'

type Db = BetterSQLite3Database<typeof s>
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]
type Scope = { enterpriseId: number; titleCode: string; direction: 'missing_in_miit' | 'extra_in_miit' }

export const whereDecisionScope102 = (scope: Scope) => and(eq(s.differenceReason.enterpriseId, scope.enterpriseId), eq(s.differenceReason.titleCode, scope.titleCode), eq(s.differenceReason.direction, scope.direction))

/** Read on the caller's executor/snapshot, including withdrawal heads; never open a transaction. */
export function readLatestDecisionHead102(db: Executor, scope: Scope) {
  return db.select({ id: s.differenceReason.id, recordedAt: s.differenceReason.recordedAt, lifecycleAction: s.differenceReason.lifecycleAction, status: s.differenceReason.status }).from(s.differenceReason).where(whereDecisionScope102(scope)).orderBy(desc(s.differenceReason.recordedAt), desc(s.differenceReason.id)).limit(1).get()
}
