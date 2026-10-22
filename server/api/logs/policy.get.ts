import { createLoggingRoute } from '../../utils/logging-route'
defineRouteMeta({ openAPI: { tags: ['日志'], summary: '受保护日志策略与故障计数', description: '必须 API token。默认7天/512MiB。storageBytes含独立SQLite及journal/WAL/SHM；collection返回11来源与6已接集成的完整有效规则，缺省enabled/debug；catalog区分已接/未接入；revision随成功修改递增。过滤filtered与队列丢弃、持久轮转/清理分开。', security: [{ bearerAuth: [] }], responses: { 200: { description: 'retentionDays,maxBytes,collection,catalog,revision,storageBytes,pruned,cleared,accounting,status' }, 401: { description: '默认拒绝' } } } })
export default createLoggingRoute('policy')
