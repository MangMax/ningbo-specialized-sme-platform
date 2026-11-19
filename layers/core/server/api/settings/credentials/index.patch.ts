import { createCredentialsHandler } from '../../../utils/credentials-route'

defineRouteMeta({ openAPI: {
  tags: ['Settings'],
  summary: '保存已登记凭据；省略字段保持不变，空白拒绝',
  description: '配置接口无需 API 管理 token。响应 Cache-Control: no-store。', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: false } } } },
  security: [],
  responses: {
    200: {
      description: '凭据遮罩状态，不含原值',
      content: { 'application/json': { schema: { type: 'object' } } },
    },
    400: { description: '输入无效' },
    503: { description: '外置配置存储不可用' },
  },
} })
export default createCredentialsHandler()
