import { requireSqliteLeadOperation } from '../../../utils/postgres-versions'
import { useDb } from '@db'
import { requestLogContext } from '#core/lib/logging'
import { requireTaskCenterAccess } from '#core/server/utils/task-center-access'
import { ensureJobRunnerReady, submitJob } from '#core/server/utils/job-runner'
import { LEAD_LIST_EXPORT, leadListExportInput } from '../../../../lib/export-contract'

defineRouteMeta({ openAPI: {
  tags: ['线索名单'], summary: '提交名单版本导出任务', security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['versionId', 'clientRequestId'],
    properties: { versionId: { type: 'integer' }, clientRequestId: { type: 'string', format: 'uuid' } },
  } } } },
  responses: { 202: { description: '已受理，按任务编号查看进度' } },
} })

export default defineEventHandler(async event => {
  requireTaskCenterAccess(event)
  const parsed = leadListExportInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: '请提交版本编号和请求 UUID' })
  requireSqliteLeadOperation()
  const db = useDb()
  ensureJobRunnerReady(db)
  const task = submitJob(db, { kind: LEAD_LIST_EXPORT, params: parsed.data, filesDir: useRuntimeConfig(event).filesDir, logContext: requestLogContext(event) })
  setResponseStatus(event, 202)
  setHeader(event, 'location', `/api/jobs/${task.id}`)
  return { jobId: task.id }
})
