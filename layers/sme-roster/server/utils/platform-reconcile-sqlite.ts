import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { getComparison, type ComparisonDirection } from '../../lib/comparison'
import { sqliteConnection } from '../../lib/platform/target-connection'
import type { ReconcileTarget } from '../../lib/platform/reconcile'
import { commitRosterImport, preflightRosterImport } from './roster-import'
import { createReconcileTargetSlotReader, type ReconcileTargetSlotReader } from './platform-reconcile-target-slots'
import { isFreshReconcileDecision, projectReconcileTargets, runPlatformReconcileWithStore, type CollectedTargets, type ReconcileRunOptions, type ReconcileReport, type ReconcileWriter } from './platform-reconcile'

type Db = BetterSQLite3Database<typeof schema>
export type SqliteReconcileOptions = ReconcileRunOptions & { db: Db; targetSlots?: ReconcileTargetSlotReader; writer?: ReconcileWriter }

export function inProcessReconcileWriter(db: Db): ReconcileWriter {
  return {
    async preflight(request) {
      return preflightRosterImport(db, request)
    },
    async commit(request) {
      const result = commitRosterImport(db, request)
      if (result.status !== 'committed') {
        const detail = result.items
          .filter((item) => !item.ok)
          .map((item) => `${item.kind}${item.ref ? ` ${item.ref}` : ''}:${item.error?.code ?? '?'} ${item.error?.message ?? ''}`)
          .join(';')
        throw new Error(`名录导入批次未提交(${result.status}):${result.error ?? ''} ${detail}`.trim())
      }
      return result
    },
  }
}

function getComparisonAllDirections(
  db: Db,
  filter: { titles?: string[]; directions?: ComparisonDirection[] },
): ReturnType<typeof getComparison>['rows'] {
  const directions: (ComparisonDirection | undefined)[] = filter.directions?.length
    ? filter.directions
    : [undefined]
  const rows: ReturnType<typeof getComparison>['rows'] = []
  const seen = new Set<string>()
  for (const direction of directions) {
    for (const row of getComparison(db, { title: filter.titles, direction }).rows) {
      const signature = `${row.enterpriseId}|${row.titleCode}|${row.direction}`
      if (seen.has(signature)) continue
      seen.add(signature)
      rows.push(row)
    }
  }
  return rows
}

export function collectReconcileTargets(
  db: Db,
  filter: { titles?: string[]; directions?: ComparisonDirection[]; usccs?: string[]; limit?: number; offset?: number } = {},
): CollectedTargets {
  const comparison = getComparisonAllDirections(db, filter)
  const enterprises = db
    .select({
      id: schema.enterprise.id,
      name: schema.enterprise.name,
      nameNorm: schema.enterprise.nameNorm,
      uscc: schema.enterprise.usccNorm,
    })
    .from(schema.enterprise)
    .all()
  return projectReconcileTargets(comparison, enterprises, filter)
}

function hasFreshDecision(db: Db, target: ReconcileTarget, cutoffIso: string, complete = true): boolean {
  const matching = db
    .select()
    .from(schema.differenceReason)
    .where(eq(schema.differenceReason.enterpriseId, target.enterpriseId))
    .all()
    .filter((row) => row.titleCode === target.titleCode && row.direction === target.direction)
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
  const latest = matching[matching.length - 1]

  return isFreshReconcileDecision(latest, cutoffIso, complete)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runPlatformReconcile(options: SqliteReconcileOptions): Promise<ReconcileReport> {
  const { db } = options
  const connection = sqliteConnection(db)
  const targetSlots = options.targetSlots ?? createReconcileTargetSlotReader(connection)
  targetSlots.assertConnection(db)
  return runPlatformReconcileWithStore(options, {
    async prepare(filter, cutoffIso) {
      const collected = collectReconcileTargets(db, filter)
      return { collected, reused: new Map([...collected.byUscc.keys()].map(uscc => [uscc,targetSlots.read(db,uscc,cutoffIso)])) }
    },
    freshDecision: (target,cutoffIso,complete) => hasFreshDecision(db,target,cutoffIso,complete),
    writer: () => options.writer ?? inProcessReconcileWriter(db),
  })
}
