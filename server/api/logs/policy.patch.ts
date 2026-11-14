import { createLoggingRoute } from '../../utils/logging-route'
defineRouteMeta({ openAPI: { tags: ['日志'], summary: '修改独立日志保留与采集策略', description: 'API token 或同源日志页面请求。JSON {retentionDays:1..365,maxBytes:1048576..4294967296,collection?:{sources?:Partial<11来源规则>,integrations?:Partial<11已接集成规则>}}；规则{enabled:boolean,minLevel:debug|info|warn|error}。fieldControls?:{http?:{debug?,info?,warn?,error?:{httpMethod?,httpRoute?,statusCode?,durationMs?:boolean}}}为闭合深层partial。另支持tus?:按同等级别的tus.method/tus.uploadId/tus.size/tus.offset布尔深partial；HTTP仅作用source=http；TUS仅作用source=file+file.upload+tus集成且已有清洗上下文，phase保留，省略保留已有值，默认全true；省略的规则保留已有值；双维同时允许且达到更严格级别才采集。未知key拒绝。只影响后续批次，不删除历史；规则存于独立日志库。请求原始body UTF-8最多4096字节（含空白），非仅Content-Length声明；JSON解析失败400且no-store。', security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['retentionDays', 'maxBytes'],
    properties: {
      retentionDays: { type: 'integer', minimum: 1, maximum: 365 },
      maxBytes: { type: 'integer', minimum: 1048576, maximum: 4294967296 },
      fieldControls: {
        type: 'object', additionalProperties: false, properties: {
          http: { type: 'object', additionalProperties: false, properties: {
            debug: { type: 'object', additionalProperties: false, properties: { httpMethod: { type: 'boolean' }, httpRoute: { type: 'boolean' }, statusCode: { type: 'boolean' }, durationMs: { type: 'boolean' } } },
            info: { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/fieldControls/properties/http/properties/debug' },
            warn: { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/fieldControls/properties/http/properties/debug' },
            error: { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/fieldControls/properties/http/properties/debug' },
          } },
          tus: { type: 'object', additionalProperties: false, properties: {
            debug: { type: 'object', additionalProperties: false, properties: { 'tus.method': { type: 'boolean' }, 'tus.uploadId': { type: 'boolean' }, 'tus.size': { type: 'boolean' }, 'tus.offset': { type: 'boolean' } } },
            info: { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/fieldControls/properties/tus/properties/debug' }, warn: { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/fieldControls/properties/tus/properties/debug' }, error: { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/fieldControls/properties/tus/properties/debug' },
          } },
        },
      },
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
              'tus-client': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'drizzle': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'embedpdf': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'pinia-colada': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
              'vue-router': { $ref: '#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http' },
            },
          },
        },
      },
    },
  } } } },
  responses: { 200: { description: '有效策略、完整fieldControls、HTTP/TUS catalog.profiles与共享revision；省略保持、同叶最后提交生效；无CAS', content: { 'application/json': { schema: { $ref: '#/paths/~1api~1logs~1policy/get/responses/200/content/application~1json/schema' } } } }, 400: { description: '无效策略' }, 401: { description: '未授权请求拒绝，鉴权前不读body或获取store' }, 413: { description: 'log_body_too_large：缺失/非法Content-Length或实际body超过4096字节' }, 409: { description: 'policy_capacity_pending：有界清理未完成缩容，旧策略仍生效；可显式重试' } } } })
export default createLoggingRoute('setPolicy')
