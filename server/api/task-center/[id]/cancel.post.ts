import { createTaskCenterRoute } from '../../../utils/task-center-route'
defineRouteMeta({ openAPI: { tags: ['任务'], summary: '请求取消任务（返回安全摘要）', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: '排队任务已取消或任务已结束' }, 202: { description: '仅请求取消，后续查询真实终态' }, 401: { description: '无API授权' }, 400: { description: '非法ID' }, 404: { description: '任务不存在' } } } })
export default createTaskCenterRoute('cancel')
