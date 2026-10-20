import { createTaskCenterRoute } from '../../../utils/task-center-route'
defineRouteMeta({ openAPI: { tags: ['任务'], summary: '请求取消任务（返回安全摘要）', description: '页面操作仅在 browserTasksEnabled 显式开启并通过同源浏览器检查时可免传凭据；此部署能力不识别用户。', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: '排队任务已取消或任务已结束' }, 202: { description: '仅请求取消，后续查询真实终态' }, 401: { description: '无API授权' }, 400: { description: '非法ID' }, 404: { description: '任务不存在' } } } })
export default createTaskCenterRoute('cancel')
