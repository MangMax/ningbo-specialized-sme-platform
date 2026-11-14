import { createLoggingRoute } from '../../utils/logging-route'
defineRouteMeta({ openAPI: { tags: ['日志'], summary: '确认范围清理运行日志', description: 'API token 或同源日志页面请求。JSON {from,to,confirm:true}，可带摘要精确筛选；时间范围必填。每次最多1000条，hasMore提示继续；清理结果另记事件。不触碰业务库/审计/文件。请求最大4096字节。', security: [{ bearerAuth: [] }], responses: { 200: { description: 'deleted,hasMore' }, 400: { description: '范围或确认缺失' }, 401: { description: '未授权请求拒绝' } } } })
export default createLoggingRoute('clear')
