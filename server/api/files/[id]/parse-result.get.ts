import { parseRoute105 } from '../../../utils/parse-maintenance-105-route'
defineRouteMeta({ openAPI: {
  tags: ['Files'], summary: '#105 读取解析状态、有效段及预期版本',
  description: '稳定文件 ID 点读。version 覆盖当前段、派生来源、状态及审计修订;修改前必须读取。只读,不回填文件/OCR。',
  parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } }],
  responses: { 200: { description: '{fileId,parseState,parts,version,removedAt}; parts 含 origin/hasConflict。no-store。' }, 400: { description: '非法 ID/参数' }, 404: { description: '文件不存在' } },
} })
export default parseRoute105('read')
