import { and, inArray, lt } from 'drizzle-orm'
import { z } from 'zod'
import { job } from '../../../../../db/postgresql/job-tables'
import type { JobSpec, PostgresJobContext } from '../../../../core/server/public'

const params = z.strictObject({ clientRequestId: z.string().trim().min(1).max(128) })
const retentionMs = 7 * 24 * 60 * 60 * 1000
const historicalKinds = ['event-archive-candidates', 'event-annual-correspondence'] as const
const terminalStates = ['done', 'failed', 'cancelled'] as const

export async function pruneRosterTaskHistory(ctx: Pick<PostgresJobContext, 'db' | 'cancelled'>, now = Date.now()) {
  const cutoff = new Date(now - retentionMs).toISOString()
  const eligible = and(inArray(job.kind, historicalKinds), inArray(job.state, terminalStates), lt(job.finishedAt, cutoff))
  let removed = 0
  while (!await ctx.cancelled()) {
    const oldest = ctx.db.select({ id: job.id }).from(job).where(eligible)
      .orderBy(job.finishedAt, job.id).limit(1000)
    const result = await ctx.db.delete(job).where(and(eligible, inArray(job.id, oldest)))
    const count = result.rowCount ?? 0
    removed += count
    if (count < 1000) return { result: { removed } }
  }
  return { result: { removed }, cancelled: true }
}

export const rosterTaskHistoryCleanupSpec: JobSpec = {
  kind: 'roster_task_history_cleanup',
  status: 'ready',
  summary: '清理超过七天的候选发现和年度核对任务',
  deduplicateRequest: true,
  parse(raw) {
    const parsed = params.safeParse(raw)
    return parsed.success ? { ok: true, params: parsed.data } : { ok: false, message: '需要有效的 clientRequestId' }
  },
  postgres: { run: ctx => pruneRosterTaskHistory(ctx) },
}
