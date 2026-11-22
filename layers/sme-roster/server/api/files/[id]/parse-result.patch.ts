import { parseRoute105 } from '../../../utils/parse-maintenance-route'
defineRouteMeta({ openAPI: {
  tags: ['Files'], summary: '#105 仅更正解析状态,保留全部段', description: 'NUXT_API_TOKEN。必须 parseState/expectedVersion/idempotencyKey/actor/reason。不得提供 parts。字段省略不清段;null 非法。parsed 仅表示解析完成,不表示名录校验通过。并发/幂等语义同 PUT。',
  parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['parseState','expectedVersion','idempotencyKey','actor','reason'], properties: {
    parseState: { type: 'string', enum: ['unparsed','parsed','failed'] }, expectedVersion: { type: 'string', description: '64位小写SHA-256版本' }, idempotencyKey: { type: 'string', description: '去空白后1–200字符' },
    actor: { $ref: '#/paths/~1api~1files~1{id}~1parse-result/put/requestBody/content/application~1json/schema/properties/actor' }, reason: { type: 'string', description: '去空白后1–2000字符' },
  } } } } },
  responses: { 200: { description: '{receiptId,replayed,state}' }, 400: { description: '非法状态/parts/未知字段' }, 401: { description: '需鉴权' }, 404: { description: '文件不存在' }, 409: { description: '版本/幂等/已移出冲突' } },
} })
export default parseRoute105('status')
