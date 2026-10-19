import { createTaskCenterRoute } from '../../../utils/task-center-route'
defineRouteMeta({ openAPI: { tags: ['任务'], summary: '安全补查平台批次全部未完成项', description: '无通用参数重放。仅终态platform-query-batch且有未完成项、未超过10次执行时委派现有平台retry。使用既有权限、检查点和预算。', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 202: { description: '受理局部重试，保留同任务ID' }, 401: { description: '无API授权' }, 409: { description: '不支持/运行中/无未完成项/次数用尽' }, 400: { description: '非法ID' }, 404: { description: '任务不存在' } } } })
export default createTaskCenterRoute('retry')
