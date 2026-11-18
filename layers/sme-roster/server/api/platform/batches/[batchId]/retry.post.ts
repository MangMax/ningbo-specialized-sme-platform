import { createPlatformBatchRoute } from '../../../../utils/platform-batch-route'
defineRouteMeta({ openAPI: {
  tags: ['平台实时查询'], summary: '显式补查指定未完成项/页，保留batchId/itemId', security: [{ bearerAuth: [] }],
  description: '仅终态批次可重试；指定itemIds必须属于本批且未完成。最多10次执行；完成项拒绝重查。使用本次重试提交时的新内存凭据快照。保留之前segments/时间，仅查询unfinished。',
  parameters: [{ in: 'path', name: 'batchId', required: true, schema: { type: 'string' } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['itemIds'], properties: { itemIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } } } } } } },
  responses: { 202: { description: '已受理', content: { 'application/json': { schema: { $ref: '#/paths/~1api~1platform~1batches/post/responses/202/content/application~1json/schema' } } } }, 400: { description: '非法参数' }, 401: { description: '需任务token' }, 404: { description: '批次不存在' }, 409: { description: '仍运行/已完成项/未知项/重试次数上限' } },
} })
export default createPlatformBatchRoute('retry')
