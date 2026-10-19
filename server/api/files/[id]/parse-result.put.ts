import { parseRoute105 } from '../../../utils/parse-maintenance-105-route'
defineRouteMeta({ openAPI: {
  tags: ['Files'], summary: '#105 替换全部代理解析段',
  description: '需要 NUXT_API_TOKEN。parts 必填且全量替换;[] 清空代理段并恢复当前 evidence 派生段。parseState 省略置 parsed。仅写段/解析状态及审计;不写名录/OCR/文件元数据。版本冲突及幂等键异载荷返回409。同键同载荷返回原始回执,不覆盖后续修改。',
  parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['parts','expectedVersion','idempotencyKey','actor','reason'], properties: {
      parts: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, required: ['titleCode','eventKind'], properties: {
        titleCode: { type: 'string', enum: ['little_giant','specialized_sme','innovative_sme'] }, eventKind: { type: 'string', enum: ['award','review','maintain','nurture'] },
        year: { type: 'integer', minimum: 1900, maximum: 2100, nullable: true }, batch: { type: 'integer', minimum: 1, nullable: true }, attachment: { type: 'string', description: '最多500字符', nullable: true }, rowCount: { type: 'integer', minimum: 0 },
      } } },
      parseState: { type: 'string', enum: ['unparsed','parsed','failed'] }, expectedVersion: { type: 'string', description: '64位小写SHA-256版本' },
      idempotencyKey: { type: 'string', description: '去空白后1–200字符' }, actor: { type: 'object', additionalProperties: false, required: ['type','id'], properties: { type: { type: 'string', enum: ['user','agent'] }, id: { type: 'string', description: '去空白后1–200字符' } } }, reason: { type: 'string', description: '去空白后1–2000字符' },
    },
  } } } },
  responses: { 200: { description: '{receiptId,replayed,state}; state 与 GET 一致。' }, 400: { description: '重复段/非法或未知字段整批拒绝' }, 401: { description: '需鉴权' }, 404: { description: '文件不存在' }, 409: { description: '版本/幂等/已移出冲突' } },
} })
export default parseRoute105('replace')
