import { createLoggingRoute } from '../../utils/logging-route'
defineRouteMeta({ openAPI: { tags: ['日志'], summary: '受保护脱敏日志详情', description: '必须 API token；按事件 UUID 精确读取，no-store。无原始错误消息/栈。', security: [{ bearerAuth: [] }], responses: { 200: { description: '单事件白名单投影' }, 401: { description: '默认拒绝' }, 404: { description: '不存在或已保留期清理' } } } })
export default createLoggingRoute('detail')
