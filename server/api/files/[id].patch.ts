import { useDb } from '@db'
import { handleStoredFilePatchRequest } from '../../utils/stored-file-patch-http'

/**
 * 改文件元数据,或只改用户可见名称。改名不改磁盘 `filename` / `relPath`、文件 ID、OCR、页图或出处,
 * 并在 `stored_file_audit` 追加一条历史记录。
 */
defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '改文件元数据或显示名称',
    description:
      '元数据更新只接受 source / kind / year / batch / titleCode。显示名称更新只接受 displayName；它只改变用户可见名称并追加审计记录，保持 stored_file.id、filename、relPath、磁盘文件、OCR、页图和出处不变。',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            oneOf: [
              {
                type: 'object',
                properties: {
                  source: { type: 'string', enum: ['jxj', 'miit'], nullable: true },
                  kind: { type: 'string', enum: ['announcement', 'export'], nullable: true },
                  year: { type: 'integer', nullable: true, description: '**公布**年份(1900–2100)。' },
                  batch: { type: 'integer', nullable: true, description: '**公布**批次。' },
                  titleCode: { type: 'string', nullable: true },
                },
                additionalProperties: false,
                description: '元数据更新。null 表示清空对应字段。',
              },
              {
                type: 'object',
                required: ['displayName'],
                properties: {
                  displayName: {
                    type: 'string',
                    description: '非空且最多 255 个字符的用户可见名称;只接受此字段,不作为磁盘文件名或路径。',
                  },
                },
                additionalProperties: false,
                description: '只改显示名称并追加审计记录;保持 id、filename、relPath、磁盘内容和出处不变。',
              },
            ],
          },
        },
      },
    },
    responses: {
      200: {
        description: '更新后的文件行(含用户可见 displayName 和磁盘 filename / relPath)。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [
                'id',
                'relPath',
                'displayName',
                'filename',
                'ext',
                'bytes',
                'sha256',
                'source',
                'kind',
                'year',
                'batch',
                'titleCode',
                'categoryState',
                'parseState',
                'createdAt',
                'removedAt',
                'referenceCount',
                'parts',
              ],
              properties: {
                id: { type: 'integer', description: '稳定的 stored_file 主键。' },
                relPath: { type: 'string', description: '文件库内相对路径;显示名更新不会改变此路径。' },
                displayName: { type: 'string', description: '用户可见名称。' },
                filename: { type: 'string', description: '磁盘上的原始文件名;显示名更新不会改变它。' },
                ext: { type: 'string', description: '文件扩展名。' },
                bytes: { type: 'integer', description: '原文件字节数。' },
                sha256: { type: 'string', description: '原文件 SHA-256。' },
                source: { type: 'string', enum: ['jxj', 'miit'], nullable: true },
                kind: { type: 'string', enum: ['announcement', 'export'], nullable: true },
                year: { type: 'integer', nullable: true, description: '公布年份。' },
                batch: { type: 'integer', nullable: true, description: '公布批次。' },
                titleCode: { type: 'string', nullable: true },
                categoryState: { type: 'string', enum: ['set', 'inferred', 'unset'] },
                parseState: { type: 'string', enum: ['unparsed', 'parsed', 'failed'] },
                createdAt: { type: 'string', format: 'date-time' },
                removedAt: { type: 'string', format: 'date-time', nullable: true },
                referenceCount: { type: 'integer', description: '当前出处引用数。' },
                parts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      'titleCode',
                      'eventKind',
                      'year',
                      'batch',
                      'attachment',
                      'rowCount',
                      'origin',
                      'hasConflict',
                    ],
                    properties: {
                      titleCode: { type: 'string' },
                      eventKind: { type: 'string', enum: ['award', 'review', 'maintain', 'nurture'] },
                      year: { type: 'integer', nullable: true },
                      batch: { type: 'integer', nullable: true },
                      attachment: { type: 'string', nullable: true },
                      rowCount: { type: 'integer' },
                      origin: { type: 'string', enum: ['derived', 'agent', 'legacy'] },
                      hasConflict: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      400: { description: 'id 非法、请求字段混合/不支持,或字段值无效。' },
      404: { description: '文件不存在。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const result = handleStoredFilePatchRequest(
    'PATCH',
    getRouterParam(event, 'id'),
    await readBody(event),
    useDb(),
  )
  if (result.status !== 200) {
    const message = (result.body as { message?: string }).message ?? '文件更新失败'
    throw createError({ statusCode: result.status as 400 | 404 | 405, message })
  }
  return result.body
})
