import { taskCenter } from '../../../../../server/task-center'

defineRouteMeta({
  openAPI: {
    tags: ['任务'],
    summary: '后台任务轻量安全摘要列表',
    description: '按模块清单筛选任务。未登记的 kind 只出现在全部任务中，显示 kind 原值。counts 按模块统计，应用状态和称号筛选。摘要不返回原始参数或结果。',
    parameters: [
      { name: 'tab', in: 'query', schema: { type: 'string', default: 'all' }, description: '模块 id，或 all（全部任务）。' },
      { name: 'group', in: 'query', schema: { type: 'string' }, description: '所选模块清单中的子分组 id。' },
      { name: 'state', in: 'query', schema: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] } },
      { name: 'titleCode', in: 'query', schema: { type: 'string' }, description: '仅查看指定称号的名录导出。' },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
    ],
    responses: {
      200: { description: 'rows/total/page/pageSize/counts/exportReady/authorized；每行包含 module（未登记为 null）和 group；no-store' },
    },
  },
})
export default taskCenter.createRoute('list')
