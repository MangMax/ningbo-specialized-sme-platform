import { useDb } from '@db'
import { snapshotOperation } from '../../../../layers/sme-roster/server/utils/difference-snapshot'
import { requireApiToken } from '../../../../layers/core/server/utils/api-guard'
defineRouteMeta({ openAPI: { tags: ['任务'], summary: '读取公布名单快照进度与结果摘要', security: [{ bearerAuth: [] }] } })
export default defineEventHandler(async event => {
  requireApiToken(event)
  return snapshotOperation(useDb(), useRuntimeConfig(event).filesDir, { action: 'read', jobId: getRouterParam(event, 'id') })
})
