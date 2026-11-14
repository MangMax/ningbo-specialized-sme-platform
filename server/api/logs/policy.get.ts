import { createLoggingRoute } from '../../utils/logging-route'
// Nitro extracts literal metadata; imports/computed expressions cannot define these schemas.
// The HTTP/MCP contract test compares every literal profile/level/field with the live catalog.
defineRouteMeta({ openAPI: {
  tags: ['日志'], summary: '受保护日志策略与故障计数',
  description: '必须API token。默认7天/512MiB。collection与fieldControls返回完整有效规则；HTTP/TUS各四字段按LOG_LEVELS配置，默认全true。catalog.profiles仅列HTTP和TUS；TUS仅匹配file.upload+tus集成+已清洗上下文，phase始终保留。revision是共享修改观测值，无CAS；不同叶合并，同叶最后提交生效。历史不重写。storageBytes含独立SQLite及journal/WAL/SHM；filtered为策略过滤，coalesced为额外汇总的查询尝试，dropped为确定丢弃，writeUnknown为写入结果未知；oversized是dropped的原因分类，fallbackSkipped只表示stdout跳过。均为本进程观测。',
  security: [{ bearerAuth: [] }], responses: {
    200: { description: '完整有效策略、能力目录与观测值', content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false,
      required: ['retentionDays', 'maxBytes', 'collection', 'fieldControls', 'catalog', 'revision'],
      properties: {
        retentionDays: { type: 'integer', minimum: 1, maximum: 365 },
        maxBytes: { type: 'integer', minimum: 1048576, maximum: 4294967296 },
        collection: { type: 'object', description: 'sources/integrations完整有效enabled/minLevel规则' },
        fieldControls: { type: 'object', additionalProperties: false, required: ['http', 'tus'], properties: {
          http: { type: 'object', additionalProperties: false, required: ['debug', 'info', 'warn', 'error'], properties: {
            debug: { type: 'object', additionalProperties: false, required: ['httpMethod', 'httpRoute', 'statusCode', 'durationMs'], properties: { httpMethod: { type: 'boolean' }, httpRoute: { type: 'boolean' }, statusCode: { type: 'boolean' }, durationMs: { type: 'boolean' } } },
            info: { $ref: '#/paths/~1api~1logs~1policy/get/responses/200/content/application~1json/schema/properties/fieldControls/properties/http/properties/debug' },
            warn: { $ref: '#/paths/~1api~1logs~1policy/get/responses/200/content/application~1json/schema/properties/fieldControls/properties/http/properties/debug' },
            error: { $ref: '#/paths/~1api~1logs~1policy/get/responses/200/content/application~1json/schema/properties/fieldControls/properties/http/properties/debug' },
          } },
          tus: { type: 'object', additionalProperties: false, required: ['debug', 'info', 'warn', 'error'], properties: {
            debug: { type: 'object', additionalProperties: false, required: ['tus.method', 'tus.uploadId', 'tus.size', 'tus.offset'], properties: { 'tus.method': { type: 'boolean' }, 'tus.uploadId': { type: 'boolean' }, 'tus.size': { type: 'boolean' }, 'tus.offset': { type: 'boolean' } } },
            info: { $ref: '#/paths/~1api~1logs~1policy/get/responses/200/content/application~1json/schema/properties/fieldControls/properties/tus/properties/debug' }, warn: { $ref: '#/paths/~1api~1logs~1policy/get/responses/200/content/application~1json/schema/properties/fieldControls/properties/tus/properties/debug' }, error: { $ref: '#/paths/~1api~1logs~1policy/get/responses/200/content/application~1json/schema/properties/fieldControls/properties/tus/properties/debug' },
          } },
        } },
        catalog: { type: 'object', required: ['integrations', 'profiles'], properties: {
          integrations: { type: 'array', items: { type: 'object' } },
          profiles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'source', 'label', 'levels', 'fields'], properties: {
            key: { type: 'string', enum: ['http', 'tus'] }, source: { type: 'string', enum: ['http', 'file'] }, label: { type: 'string' },
            levels: { type: 'array', items: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] } },
            fields: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'label', 'description'], properties: {
              key: { type: 'string', enum: ['httpMethod', 'httpRoute', 'statusCode', 'durationMs', 'tus.method', 'tus.uploadId', 'tus.size', 'tus.offset'] }, label: { type: 'string' }, description: { type: 'string' },
            } } },
          } } },
        } },
        revision: { type: 'integer', minimum: 0 }, storageBytes: { type: 'integer', minimum: 0 },
        pruned: { type: 'integer', minimum: 0 }, cleared: { type: 'integer', minimum: 0 },
        accounting: { type: 'string' }, status: { type: 'object', description: '本进程实时计数；记录单位accepted/stored/filtered/dropped/writeUnknown，额外查询尝试单位coalesced；overflow/oversized为丢弃原因，stdout跳过为fallbackSkipped；PATCH可不返回' },
      },
    } } } },
    401: { description: '未授权请求拒绝，不打开store；no-store' },
  },
} })
export default createLoggingRoute('policy')
