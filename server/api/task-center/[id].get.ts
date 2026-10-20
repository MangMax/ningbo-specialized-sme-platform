import { createTaskCenterRoute } from '../../utils/task-center-route'
defineRouteMeta({ openAPI: { tags: ['任务'], summary: '后台任务安全详情与操作能力', description: '白名单摘要、进度、错误类别、结果入口及capabilities；不返回原始参数、错误或结果。', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'TaskSummary；no-store' }, 400: { description: '非法ID' }, 404: { description: '任务不存在' } } } })
export default createTaskCenterRoute('detail')
