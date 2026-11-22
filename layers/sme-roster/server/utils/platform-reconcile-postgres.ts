import { and, desc, eq } from 'drizzle-orm'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { getPostgresComparison } from '../../lib/comparison-heads-postgres'
import { createPostgresImportSteps, executePostgresImportSteps } from './roster-mixed-import-postgres'
import { executePostgresRosterImport } from './roster-export-import-postgres'
import {
  isFreshReconcileDecision, projectReconcileTargets, runPlatformReconcileWithStore, type ReconcileRunOptions,
} from './platform-reconcile'

export function runPostgresPlatformReconcile(db: NodePgDatabase, options: ReconcileRunOptions) {
  return runPlatformReconcileWithStore(options,{
    prepare: (filter)=>db.transaction(async tx=>{
      const directions = filter.directions?.length ? filter.directions : [undefined]
      const comparison = []
      for (const direction of directions) comparison.push(...(await getPostgresComparison(tx,{title:filter.titles,direction})).rows)
      const enterprises = await tx.select({ id: enterprise.id, name: enterprise.name, nameNorm: enterprise.nameNorm, uscc: enterprise.usccNorm })
        .from(enterprise).orderBy(enterprise.id)
      return { collected: projectReconcileTargets(comparison, enterprises, filter) }
    },{isolationLevel:'repeatable read',accessMode:'read only'}),
    async freshDecision(target,cutoffIso,complete) {
      const [latest] = await db.select({ verificationStatus: differenceReason.verificationStatus, recordedAt: differenceReason.recordedAt,
        status: differenceReason.status }).from(differenceReason)
        .where(and(eq(differenceReason.enterpriseId, target.enterpriseId), eq(differenceReason.titleCode, target.titleCode),
          eq(differenceReason.direction, target.direction)))
        .orderBy(desc(differenceReason.recordedAt), desc(differenceReason.id)).limit(1)
      return isFreshReconcileDecision(latest,cutoffIso,complete)
    },
    writer:()=>({
      async preflight(request) {
        const result = await executePostgresRosterImport(db,'preflight',request,(tx,batch)=>
          executePostgresImportSteps(tx,batch,'preflight',createPostgresImportSteps('preflight',request)))
        if (result.status !== 'preflight') throw new Error('Reconcile import preflight did not return a plan')
        return result
      },
      async commit(request) {
        const result = await executePostgresRosterImport(db,'commit',request,(tx,batch)=>
          executePostgresImportSteps(tx,batch,'commit',createPostgresImportSteps('commit',request)))
        if (result.status !== 'committed') throw new Error('Reconcile import batch did not commit')
        return result
      },
    }),
  })
}
