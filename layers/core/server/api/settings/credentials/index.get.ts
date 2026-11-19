import { createCredentialsHandler } from '../../../utils/credentials-route'

defineRouteMeta({ openAPI: {
  tags: ['Settings'],
  summary: '读取配置状态，仅返回遮罩',
  description: '配置接口无需 API 管理 token。响应 Cache-Control: no-store。',
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
