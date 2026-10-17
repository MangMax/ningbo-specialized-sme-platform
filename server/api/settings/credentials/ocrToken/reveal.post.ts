import { createCredentialsHandler } from '../../../../utils/credentials-route'
defineRouteMeta({ openAPI: { tags: ['Settings'], summary: '按需读取当前有效 OCR token 原值', description: '仅 POST；无需 API 管理 token。返回 { value: string }，Cache-Control: no-store。不得缓存、记录或持久化响应。无值时 value 为空字符串。', security: [], responses: { 200: { description: '当前有效原值，仅供显式查看或复制', content: { 'application/json': { schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } } } } }, 503: { description: '配置存储不可用' } } } })
export default createCredentialsHandler('reveal')
