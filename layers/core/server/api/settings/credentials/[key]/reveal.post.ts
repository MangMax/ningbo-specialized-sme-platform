import { credentialRevealHandler } from '../../../../utils/credentials-route'

defineRouteMeta({ openAPI: {
  tags: ['Settings'],
  summary: '按需读取一个已登记凭据的当前有效原值',
  description: '仅 POST；无需 API 管理 token。无值时 value 为空字符串。Cache-Control: no-store。仅供显式查看或复制，响应不得记录或持久化。',
  security: [],
  parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
  responses: {
    200: { description: '已登记凭据的当前有效原值', content: { 'application/json': { schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } } } } },
    404: { description: '未登记的凭据' },
    503: { description: '配置存储不可用' },
  },
} })
export default credentialRevealHandler
