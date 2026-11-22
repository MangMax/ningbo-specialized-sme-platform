import { resolvePlatformCookie } from '../platform-credential'
import { runPlatformReconcile } from '../platform-reconcile-sqlite'
import type { JobCompletion, JobContext, JobSpec } from '../../../../core/server/public'
import { reconcileSpec, reconcileOptions, reconcileCompletion } from './reconcile'

export const sqliteReconcileSpec: JobSpec = { ...reconcileSpec,
  prepare: (_params, db) => {
    const cookie = resolvePlatformCookie(undefined, { db })
    return (ctx, params) => runReconcile(ctx, params, cookie)
  },
  run: (ctx, params) => runReconcile(ctx, params, resolvePlatformCookie(undefined, { db: ctx.db })),
}

async function runReconcile(ctx: JobContext, params: Record<string, unknown>, cookie: string): Promise<JobCompletion> {
  const report = await runPlatformReconcile({
    ...reconcileOptions(params),
    db: ctx.db,
    cookie,
    onProgress: (done, total) => ctx.progress(done, total),
    shouldCancel: () => ctx.cancelled(),
  })

  return reconcileCompletion(report)
}
