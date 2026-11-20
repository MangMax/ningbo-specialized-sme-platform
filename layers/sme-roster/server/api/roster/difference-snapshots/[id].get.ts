import { useDb } from '@db'
import { snapshotRuntimeOperation } from '../../../utils/difference-snapshot'
import { requireApiToken } from '../../../../../core/server/utils/api-guard'
defineRouteMeta({ openAPI: { tags: ['任务'], summary: '读取公布名单快照进度与结果摘要', security: [{ bearerAuth: [] }] } })
export default defineEventHandler(async event => {
  requireApiToken(event)
  return snapshotRuntimeOperation(useDb, useRuntimeConfig(event).filesDir, { action: 'read', jobId: getRouterParam(event, 'id') })
})
