import { createPlatformBatchRoute } from '../../../utils/platform-batch-route'
defineRouteMeta({ openAPI: {
  tags: ['平台实时查询'], summary: '批次状态、真实进度和逐项结果（no-store）',
  parameters: [{ in: 'path', name: 'batchId', required: true, schema: { type: 'string' } }],
  responses: { 200: { description: '状态独立于完整性；failed保留成功项，重启后不得视作运行中。segments按原查询时间保留多关系和页状态。rows 为业务字符串投影，dataRows 存在时保留业务字段类型。', content: { 'application/json': { schema: {
    type: 'object', required: ['batchId', 'itemIds', 'state', 'progress', 'completeness', 'attempt', 'items', 'limits', 'usage'], properties: {
      batchId: { type: 'string' }, itemIds: { type: 'array', items: { type: 'string' } }, state: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
      progress: { type: 'object', properties: { done: { type: 'integer' }, total: { type: 'integer' } } }, completeness: { type: 'string', enum: ['complete', 'partial'] }, attempt: { type: 'integer' },
      items: { type: 'array', items: { type: 'object', required: ['itemId', 'status', 'completeness', 'segments', 'unfinished'], properties: {
        itemId: { type: 'string' }, status: { type: 'string', enum: ['success', 'no_record', 'auth_failed', 'failed', 'partial', 'not_queried'] }, completeness: { type: 'string', enum: ['complete', 'partial', 'not_queried'] },
        segments: { type: 'array', items: { type: 'object', allOf: [
          { $ref: '#/paths/~1api~1platform~1query/post/responses/200/content/application~1json/schema' },
          { type: 'object', not: { required: ['rawData'] }, properties: { dataRows: { type: 'array', items: { type: 'object', additionalProperties: {} } } } } as { type: 'object' },
        ] } },
        unfinished: { type: 'array', items: { type: 'object', properties: { source: { type: 'string' }, rdjb: { type: ['string', 'null'] }, page: { type: 'integer' } } } },
      } } },
      limits: { $ref: '#/paths/~1api~1platform~1batches/post/requestBody/content/application~1json/schema/properties/limits' }, usage: { type: 'object', properties: { requests: { type: 'integer' }, rows: { type: 'integer' } } },
      createdAt: { type: 'string' }, startedAt: { type: ['string', 'null'] }, finishedAt: { type: ['string', 'null'] }, error: { type: ['string', 'null'] },
    },
  } } } }, 400: { description: '非法ID' }, 404: { description: '批次不存在' } },
} })
export default createPlatformBatchRoute('status')
