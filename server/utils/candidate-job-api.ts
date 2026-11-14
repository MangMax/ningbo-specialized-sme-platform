import type { useApplicationDb } from '../../db/client'
import type { LogContext } from '../../lib/logging'
import { operationLogContext } from './operation-log-context'
import { isJobId } from '../../lib/job'
import { readApiToken, resolveApiAuth } from './api-auth'
import {
  CANDIDATE_JOB_KIND,
  submitCandidateDiscovery,
} from './jobs/candidate-discovery'
import { getJobSummary } from './job-store'
import { handleTaskCenterRequest } from './task-center-http'
import { ensureJobRunnerReady } from './job-runner'
import { registerJobSpecs } from './job-specs'
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
      { ...ctx, apiToken: 'internal-task-authorized', logContext: ctx.logContext ?? operationLogContext.getStore() },
    )
    return result.status < 300
      ? result.body
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
