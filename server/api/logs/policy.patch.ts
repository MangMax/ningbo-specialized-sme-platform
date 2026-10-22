import { createLoggingRoute } from '../../utils/logging-route'
defineRouteMeta({ openAPI: { tags: ['日志'], summary: '修改独立日志保留与采集策略', description: '必须 API token。JSON {retentionDays:1..365,maxBytes:1048576..4294967296,collection?:{sources?:Partial<11来源规则>,integrations?:Partial<6已接集成规则>}}；规则{enabled:boolean,minLevel:debug|info|warn|error}。省略的规则保留已有值；双维同时允许且达到更严格级别才采集。未知key拒绝。只影响后续批次，不删除历史；规则存于独立日志库。请求最大4096字节。', security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['retentionDays', 'maxBytes'],
    properties: {
      retentionDays: { type: 'integer', minimum: 1, maximum: 365 },
      maxBytes: { type: 'integer', minimum: 1048576, maximum: 4294967296 },
      collection: {
        type: 'object', additionalProperties: false,
        properties: {
          sources: {
            type: 'object', additionalProperties: false, properties: {
              'http': { type: 'object', additionalProperties: false, required: ['enabled', 'minLevel'], properties: { enabled: { type: 'boolean' }, minLevel: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] } } },
              'mcp': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'task': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'worker': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'platform': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'file': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'ocr': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'import': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'export': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'client': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'system': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
            },
          },
          integrations: {
            type: 'object', additionalProperties: false, properties: {
              'nuxt-nitro': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'mcp-toolkit': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'tus': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'application': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'browser': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'vue': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
            },
          },
        },
      },
    },
  } } } },
  responses: { 200: { description: '有效策略、完整默认规则、catalog与revision' }, 400: { description: '无效策略' }, 401: { description: '默认拒绝' }, 409: { description: 'policy_capacity_pending：有界清理未完成缩容，旧策略仍生效；可显式重试' } } } })
export default createLoggingRoute('setPolicy')
