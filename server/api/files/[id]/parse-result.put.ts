import { parseRoute105 } from '../../../../layers/sme-roster/server/utils/parse-maintenance-105-route'
defineRouteMeta({ openAPI: {
  tags: ['Files'], summary: '#105 替换全部代理解析段',
  description: '需要 NUXT_API_TOKEN。历史unknown结果兼容输出CAS写入;一旦结果bound,段替换缺inputRef即409要求重读预检,不能降回unknown。当前解析推荐POST parse-result/preflight→commit,新commit缺inputRef不降级。parts必填且全量替换;[]恢复evidence派生段。parseState省略置parsed。只写段/解析状态/审计,不写正式出处/OCR。版本/幂等冲突409,同键同载荷先恢复原回执。',
  parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['parts','expectedVersion','idempotencyKey','actor','reason'], properties: {
      parts: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, required: ['titleCode','eventKind'], properties: {
        declarationId: { type: 'string', format: 'uuid', description: '稳定声明身份;修改坐标时携带,不得引用别的文件或已撤回声明' },
        pageRanges: { type: 'array', maxItems: 1000, description: '1起物理页闭区间;省略保留,[]显式清空;非空必须verifyPhysicalPages预检后commit', items: { type: 'object', additionalProperties: false, required: ['start','end'], properties: { start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } } } },
        titleCode: { type: 'string', enum: ['little_giant','specialized_sme','innovative_sme'] }, eventKind: { type: 'string', enum: ['award','review','maintain','nurture'] },
        year: { type: 'integer', minimum: 1900, maximum: 2100, nullable: true }, batch: { type: 'integer', minimum: 1, nullable: true }, attachment: { type: 'string', description: '最多500字符', nullable: true }, rowCount: { type: 'integer', minimum: 0 },
      } } },
      parseState: { type: 'string', enum: ['unparsed','parsed','failed'] }, expectedVersion: { type: 'string', description: '64位小写SHA-256版本' },
      inputRef: { $ref: '#/paths/~1api~1files~1{id}~1parse-result~1commit/post/requestBody/content/application~1json/schema/properties/inputRef' },
      idempotencyKey: { type: 'string', description: '去空白后1–200字符' }, actor: { type: 'object', additionalProperties: false, required: ['type','id'], properties: { type: { type: 'string', enum: ['user','agent'] }, id: { type: 'string', description: '去空白后1–200字符' } } }, reason: { type: 'string', description: '去空白后1–2000字符' },
    },
  } } } },
  responses: { 200: { description: '{receiptId,replayed,state}; state 与 GET 一致。' }, 400: { description: '重复段/非法或未知字段整批拒绝' }, 401: { description: '需鉴权' }, 404: { description: '文件不存在' }, 409: { description: '版本/幂等/已移出冲突' } },
} })
export default parseRoute105('replace')
