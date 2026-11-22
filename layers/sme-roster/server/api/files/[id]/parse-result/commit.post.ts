import { parseRoute105 } from '../../../../utils/parse-maintenance-route'
defineRouteMeta({ openAPI: {
  tags: ['Files'], summary: '#310 提交冻结输入的解析段',
  description: '需NUXT_API_TOKEN。当前推荐写口:必须提供原preflight inputRef和独立expectedVersion。只接受带parts的解析替换,不得降级为旧盲写。先恢复同键原回执;新提交输入变更返回409要求重读,不切到最新OCR。段/状态/血缘/审计同事务;不改正式出处页码或人工分节。',
  parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['parts','inputRef','expectedVersion','idempotencyKey','actor','reason'], properties: {
    parts: { $ref: '#/paths/~1api~1files~1{id}~1parse-result/put/requestBody/content/application~1json/schema/properties/parts' },
    parseState: { type: 'string', enum: ['unparsed','parsed','failed'] }, expectedVersion: { type: 'string', description: '64位小写十六进制SHA-256输出版本,必须符合 ^[a-f0-9]{64}$' },
    inputRef: { type: 'object', additionalProperties: false, required: ['format','fileId','relPath','sha256','kind','pages'], properties: {
      physicalSource: { type: 'object', additionalProperties: false, required: ['pageCount','contentVersion'], description: '#669 verifyPhysicalPages预检返回原样提交;服务端重检,禁止客户端猜填', properties: { pageCount: { type: 'integer', minimum: 1 }, contentVersion: { type: 'string' } } },
      format: { type: 'integer', enum: [1] }, fileId: { type: 'integer', minimum: 1 }, relPath: { type: 'string', description: '非空文件库相对路径' }, sha256: { type: 'string', description: '实际文件内容的64位小写十六进制SHA-256,必须符合 ^[a-f0-9]{64}$' }, kind: { type: 'string', enum: ['file','ocr'] }, pages: { $ref: '#/paths/~1api~1files~1{id}~1parse-result~1preflight/post/requestBody/content/application~1json/schema/properties/pages' },
    } },
    idempotencyKey: { type: 'string', description: '去空白后1–200字符' }, actor: { $ref: '#/paths/~1api~1files~1{id}~1parse-result/put/requestBody/content/application~1json/schema/properties/actor' }, reason: { type: 'string', description: '去空白后1–2000字符' },
  } } } } },
  responses: { 200: { description: '{receiptId,replayed,state};回执inputLineage保存冻结输入,重放不改后续结果' }, 400: { description: '缺inputRef/parts或非法请求,不可兼容降级' }, 401: { description: '需鉴权' }, 404: { description: '文件不存在' }, 409: { description: '输入已变化/输出CAS/异载荷幂等键冲突;重新读取并预检后用新key提交,原稿保留' } },
} })
export default parseRoute105('commit')
