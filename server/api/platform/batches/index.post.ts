import { createPlatformBatchRoute } from '../../../../layers/sme-roster/server/utils/platform-batch-route'
defineRouteMeta({ openAPI: {
  tags: ['平台实时查询'], summary: '异步提交平台查询批次（不写业务数据）', security: [{ bearerAuth: [] }],
  description: '需要 API 任务 token。仅保存无凭据任务参数和脱敏结果；batchId/itemId 稳定。最多50项，每次执行200请求/120秒，累计5000行/8MiB（默认2MiB），最多10次执行。各项复用单项来源语义和全局max2。状态GET不需token；partial必须显式重试，重启标failed不会自动恢复。完整契约见 server/api/platform/batches/index.post.ts。',
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['items'], properties: {
      items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { $ref: '#/paths/~1api~1platform~1query/post/requestBody/content/application~1json/schema' } } } },
      limits: { type: 'object', additionalProperties: false, properties: {
        maxRequests: { type: 'integer', minimum: 1, maximum: 200, default: 200 }, maxRows: { type: 'integer', minimum: 1, maximum: 5000, default: 5000 }, maxDurationMs: { type: 'integer', minimum: 1, maximum: 120000, default: 120000 }, maxResultBytes: { type: 'integer', minimum: 65536, maximum: 8388608, default: 2097152 },
      } },
    },
  } } } },
  responses: { 202: { description: '已受理；不代表查询完成。', content: { 'application/json': { schema: { type: 'object', required: ['batchId', 'itemIds', 'state'], properties: { batchId: { type: 'string' }, itemIds: { type: 'array', items: { type: 'string' } }, state: { type: 'string' } } } } } }, 400: { description: '参数非法或未知参数/凭据字段。' }, 401: { description: '任务 token 未配置/缺失/无效。' } },
} })
export default createPlatformBatchRoute('submit')
