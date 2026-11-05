import { useDb } from '@db'
import { snapshotOperation } from '../../../utils/difference-snapshot'
import { requireApiToken } from '../../../utils/api-guard'
defineRouteMeta({ openAPI: { tags: ['任务'], summary: '创建或重试公布名单归档快照', description: 'action=create/clientRequestId 或 retry/jobId。先校验数据库备份再写任务；复用完整归档并逐企业补采；缺失身份、失败与部分分页保持未完成。read/jobId 读取完整摘要。', security: [{ bearerAuth: [] }] } })
export default defineEventHandler(async event => {
  requireApiToken(event)
  const row = await snapshotOperation(useDb(), useRuntimeConfig(event).filesDir, await readBody(event))
  setResponseStatus(event, 202)
  return row
})
