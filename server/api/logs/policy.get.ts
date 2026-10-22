import { createLoggingRoute } from '../../utils/logging-route'
defineRouteMeta({ openAPI: { tags: ['日志'], summary: '受保护日志策略与故障计数', description: '必须 API token。默认7天/512MiB。storageBytes含独立SQLite及journal/WAL/SHM；计数区分进程丢弃与持久轮转/清理。', security: [{ bearerAuth: [] }], responses: { 200: { description: 'retentionDays,maxBytes,storageBytes,pruned,cleared,accounting,status' }, 401: { description: '默认拒绝' } } } })
export default createLoggingRoute('policy')
