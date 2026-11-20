import type { useApplicationDb } from '../../../../db/client'
import type { LogContext } from '../../../core/lib/logging'
import { operationLogContext } from '../../../core/server/utils/operation-log-context'
import { isJobId } from '../../../core/lib/job'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import {
  CANDIDATE_JOB_KIND,
  submitCandidateDiscovery,
} from './jobs/candidate-discovery'
import { submitPostgresCandidateDiscovery, retryPostgresCandidateDiscovery } from './jobs/candidate-discovery-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'
import { cancelPostgresJob, getPostgresJobSummary } from '../../../core/server/utils/job-store-postgres'
import { postgresJobsEnabled } from '../../../core/server/utils/postgres-jobs'
import { readPostgresTaskCenterEntry } from '../../../core/server/utils/task-center-postgres'
import { getJobSummary } from '../../../core/server/utils/job-store'
import { handleTaskCenterRequest } from './task-center-http'
import { ensureJobRunnerReady } from '../../../core/server/utils/job-runner'
import { registerJobSpecs } from '../../../../server/utils/job-specs'
export type CandidateJobAction = 'submit' | 'detail' | 'cancel' | 'retry'
type Context = {
  db: ReturnType<typeof useApplicationDb>
  filesDir: string
  apiToken?: string | null
  browserAuthorized?: boolean
  logContext?: LogContext
}
type Request = {
  method: string
  path: string
  headers?: Record<string, string | undefined>
  body?: unknown
  id?: unknown
}
export async function handleCandidateJobRequest(
  action: CandidateJobAction,
  req: Request,
  ctx: Context,
) {
  const headers = { 'cache-control': 'no-store' }
  const error = (status: number, message: string) => ({
    status,
    headers,
    body: { message },
  })
  if (req.method !== (action === 'detail' ? 'GET' : 'POST'))
    return error(405, 'Method not allowed')
  const authorized =
    ctx.browserAuthorized === true ||
    resolveApiAuth({
      given: readApiToken(req.headers),
      configured: ctx.apiToken,
    }).writeAuthorized
  if (action !== 'detail' && !authorized) return error(401, '任务操作需要授权')
  try {
    registerJobSpecs()
    const postgres = usePostgresRosterDb()
    if (postgres) {
      const writable = postgresJobsEnabled() && process.env.NUXT_POSTGRES_DIRECTORY_WRITE === '1'
      if (action !== 'detail' && !writable) return error(403, '当前数据库只读')
      if (action === 'submit') {
        const receipt = await submitPostgresCandidateDiscovery(req.body, ctx.filesDir, ctx.logContext)
        return { status: 202, headers: { ...headers, location: `/api/task-center/${receipt.jobId}` }, body: receipt }
      }
      const id = req.id
      if (!isJobId(id)) return error(400, '无效任务编号')
      if ((await getPostgresJobSummary(postgres, id))?.kind !== CANDIDATE_JOB_KIND) return error(404, '候选任务不存在')
      if (action === 'detail') {
        const body = await readPostgresTaskCenterEntry(postgres, id, () => authorized && writable)
        return body ? { status: 200, headers, body } : error(404, '候选任务不存在')
      }
      if (action === 'retry') return { status: 202, headers, body: await retryPostgresCandidateDiscovery(postgres, id) }
      const cancelled = await cancelPostgresJob(postgres, id, ctx.logContext)
      const task = await readPostgresTaskCenterEntry(postgres, id, () => authorized && writable)
      if (!cancelled || !task) return error(404, '候选任务不存在')
      return { status: cancelled.cancelRequested ? 202 : 200, headers, body: { task, cancelRequested: cancelled.cancelRequested } }
    }
    ensureJobRunnerReady(ctx.db)
    if (action === 'submit') {
      const receipt = submitCandidateDiscovery(ctx.db, req.body, ctx.filesDir, ctx.logContext)
      return {
        status: 202,
        headers: { ...headers, location: `/api/task-center/${receipt.jobId}` },
        body: receipt,
      }
    }
    const id = req.id
    if (!isJobId(id)) return error(400, '无效任务编号')
    if (getJobSummary(ctx.db, id)?.kind !== CANDIDATE_JOB_KIND)
      return error(404, '候选任务不存在')
    return await handleTaskCenterRequest(
      action,
      {
        ...req,
        path: `/api/task-center/${id}${action === 'detail' ? '' : `/${action}`}`,
      },
      { ...ctx, apiToken: ctx.apiToken ?? undefined },
    )
  } catch (cause) {
    const status = (cause as { statusCode?: number }).statusCode
    return error(
      status && status < 500 ? status : 503,
      status === 409
        ? '请求或任务状态冲突，请刷新核对'
        : status === 400
          ? '候选任务范围或请求标识无效'
          : '候选任务未受理，原结果保留',
    )
  }
}
export async function dispatchCandidateJobMcp(
  action: CandidateJobAction,
  args: Record<string, unknown>,
  ctx: Omit<Context, 'apiToken' | 'browserAuthorized'> & {
    authorized?: boolean
  },
) {
  try {
    const result = await handleCandidateJobRequest(
      action,
      {
        method: action === 'detail' ? 'GET' : 'POST',
        path: '',
        body: args,
        id: args.id,
        headers: ctx.authorized
          ? { authorization: 'Bearer internal-task-authorized' }
          : undefined,
      },
      { get db() { return ctx.db }, filesDir: ctx.filesDir, apiToken: 'internal-task-authorized', logContext: ctx.logContext ?? operationLogContext.getStore() },
    )
    return result.status < 300
      ? { ...result.body }
      : {
          isError: true,
          content: [
            { type: 'text' as const, text: JSON.stringify(result.body) },
          ],
        }
  } catch {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ message: '候选任务操作失败' }),
        },
      ],
    }
  }
}
