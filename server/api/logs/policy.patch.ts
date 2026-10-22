import { createLoggingRoute } from '../../utils/logging-route'
defineRouteMeta({ openAPI: { tags: ['日志'], summary: '修改独立日志保留策略', description: '必须 API token。JSON {retentionDays:1..365,maxBytes:1048576..4294967296}，完整替换策略，保存在日志库；不修改业务审计。请求最大4096字节。', security: [{ bearerAuth: [] }], responses: { 200: { description: '实际策略和计量' }, 400: { description: '无效策略' }, 401: { description: '默认拒绝' }, 409: { description: 'policy_capacity_pending：有界清理未完成缩容，旧策略仍生效；可显式重试' } } } })
export default createLoggingRoute('setPolicy')
