import { createPlatformBatchRoute } from '../../../../../../layers/sme-roster/server/utils/platform-batch-route'
defineRouteMeta({ openAPI: {
  tags: ['平台实时查询'], summary: '按稳定itemId取单项结果（no-store）',
  parameters: [{ in: 'path', name: 'batchId', required: true, schema: { type: 'string' } }, { in: 'path', name: 'itemId', required: true, schema: { type: 'string' } }],
  responses: { 200: { description: '仅返回本批指定项，失败保留完整segments和unfinished。', content: { 'application/json': { schema: { $ref: '#/paths/~1api~1platform~1batches~1{batchId}/get/responses/200/content/application~1json/schema/properties/items/items' } } } }, 400: { description: '非法ID' }, 404: { description: '批次或项不存在' } },
} })
export default createPlatformBatchRoute('item')
