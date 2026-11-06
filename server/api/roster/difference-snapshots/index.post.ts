import { useDb } from '@db'
import { snapshotOperation } from '../../../utils/difference-snapshot'
import { requireApiToken } from '../../../utils/api-guard'
defineRouteMeta({ openAPI: { tags: ['任务'], summary: '创建或重试公布企业业务采集', description: 'action=create/clientRequestId 或 retry/jobId。先校验数据库备份再写任务；新任务对选定 enterpriseIds（可选1..200项，不传为全部）公布企业逐企业新查三个接口；同一 clientRequestId 幂等返回原任务，retry 仅续用本任务成功页；缺失身份、失败与部分分页保持未完成。read/jobId 读取完整摘要。', security: [{ bearerAuth: [] }] } })
export default defineEventHandler(async event => {
  requireApiToken(event)
  const row = await snapshotOperation(useDb(), useRuntimeConfig(event).filesDir, await readBody(event))
  setResponseStatus(event, 202)
  return row
})
