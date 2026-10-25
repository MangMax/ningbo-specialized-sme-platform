import { parseRoute105 } from '../../../../utils/parse-maintenance-105-route'
defineRouteMeta({ openAPI: {
  tags: ['Files'], summary: '#310 冻结解析实际输入',
  description: '需NUXT_API_TOKEN。kind=file核实实际磁盘sha256与登记一致;kind=ocr还须提供实际读过的页号及OCR version(id:revision),不自动选最新页。只核所选页、不修改文件/OCR/正式出处。返回expectedVersion(输出CAS)及inputRef(独立输入依据),解析后原样交commit。',
  parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['kind'], properties: {
    kind: { type: 'string', enum: ['file','ocr'] }, pages: { type: 'array', maxItems: 10000, description: 'ocr必填且非空、页号不重复;file省略或[]', items: { type: 'object', additionalProperties: false, required: ['page','version'], properties: { page: { type: 'integer', minimum: 1 }, version: { type: 'string', pattern: '^[1-9]\\d*:[1-9]\\d*$' } } } },
  } } } } },
  responses: { 200: { description: '{expectedVersion,inputRef:{format:1,fileId,relPath,sha256,kind,pages:[{page,version}]}};no-store' }, 400: { description: '非法选择/重复页' }, 401: { description: '需鉴权' }, 404: { description: '文件不存在' }, 409: { description: '磁盘/登记身份不一致或OCR版本已变化;重新读取核实后预检' } },
} })
export default parseRoute105('preflight')
