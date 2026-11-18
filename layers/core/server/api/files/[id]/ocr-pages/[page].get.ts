import { ocrPageHttp106 } from '../../../../utils/ocr-page-http-106'

defineRouteMeta({
  openAPI: {
    tags: ['OCR'],
    summary: '按文件 ID 与页号读 OCR 结果',
    description: '显式单页,不影响其他页、页图、源文件、正式事件或证据。读回 results[].version;expectedVersion 不符返回 409,null 表示预期不存在。省略保留旧覆盖语义。写入需独立 NUXT_API_TOKEN。重做=读页图后按本页写回,不触发整份在线 OCR。',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
      { name: 'page', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 2000 } },
    ],
    responses: { 200: { description: '单页结果。', content: { 'application/json': { schema: { type: 'object', properties: { file: { type: 'object' }, page: { type: 'integer' }, pages: { type: 'array', items: { type: 'integer' } }, markdown: { type: 'string' }, results: { type: 'array', items: { type: 'object', properties: { page: { type: 'integer' }, version: { type: 'string' }, engine: { type: 'string' }, model: { type: 'string', nullable: true }, channel: { type: 'string' }, createdAt: { type: 'string' }, chars: { type: 'integer' }, pageRelPath: { type: 'string', nullable: true }, url: { type: 'string', nullable: true } } } } } } } } }, 400: { description: '参数或字段非法。' }, 401: { description: '写入未鉴权。' }, 404: { description: '文件不存在/写入目标已移出;读取页不存在。' }, 409: { description: '预期页版本不符。' }, 415: { description: '写入目标不是 PDF。' } },
  },
})

export default defineEventHandler(event => ocrPageHttp106(event, 'get'))
