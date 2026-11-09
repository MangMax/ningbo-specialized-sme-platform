import { parseRoute105 } from '../../../utils/parse-maintenance-105-route'
defineRouteMeta({ openAPI: {
  tags: ['Files'], summary: '#105 读取解析状态、有效段及预期版本',
  description: '稳定文件 ID 点读。#669 declarations独立返回稳定declarationId/revision/fileId/sha256/contentVersion/part/pageRanges;null范围未知,[]显式清空,不表示OCR实际使用页。范围历史点读history回执。version仅保护输出集合,包含登记SHA与声明修订;磁盘epoch由物理页预检独立保护,不随OCR变化;inputLineage是上次解析明确依据(bound或unknown),不是当前有效性承诺。当前解析先POST parse-result/preflight再POST parse-result/commit。旧历史不回填hash,只读不修改文件/OCR/正式出处。',
  parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } }],
  responses: { 200: { description: '{fileId,parseState,parts,version,removedAt,inputLineage}; parts 含 origin/hasConflict。no-store。' }, 400: { description: '非法 ID/参数' }, 404: { description: '文件不存在' } },
} })
export default parseRoute105('read')
