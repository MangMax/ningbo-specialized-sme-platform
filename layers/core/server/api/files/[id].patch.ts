import { maintainPostgresFile } from '../../utils/file-maintenance-postgres'
import { usePostgresFileDb } from '../../utils/file-store-postgres'
import { requestLogContext } from '../../../lib/logging'
import { requireApiToken } from '../../utils/api-guard'
import { hasFileMaintenanceControls, splitFileMaintenanceBody } from '../../utils/file-maintenance-shared'

/**
 * 改文件元数据,或只改用户可见名称。改名不改磁盘 `filename` / `relPath`、文件 ID、OCR、页图或出处,
 * 并在 `stored_file_audit` 追加一条历史记录。
 */
defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '改文件元数据或显示名称',
    description:
      '元数据更新接受已登记的可编辑字段。可附 expectedRevision / idempotencyKey / actor / basis；修订与历史从 maintenance 读取。旧载荷保留原有本地入口与 blind-write 语义。只要给出控制字段，就必须完整提供四项并使用 API token；不完整封套拒绝。显示名称更新只接受 displayName；它只改变用户可见名称并追加审计记录，保持 stored_file.id、filename、relPath、磁盘文件、OCR、页图和出处不变。',
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
                  expectedRevision: { type: 'integer', minimum: 0, description: '预期维护修订；旧值返回409。' },
                  idempotencyKey: { type: 'string', description: '非空文本，最多200字符。' },
                  actor: { type: 'string', description: '非空文本，最多200字符。' },
                  basis: { type: 'string', description: '非空维护依据，最多2000字符。' },
                },
                additionalProperties: false,
                description: '元数据更新。null 表示清空对应字段。',
              },
              {
                type: 'object',
                required: ['displayName'],
                properties: {
                  expectedRevision: { type: 'integer', minimum: 0, description: '预期维护修订；旧值返回409。' },
                  idempotencyKey: { type: 'string', description: '非空文本，最多200字符。' },
                  actor: { type: 'string', description: '非空文本，最多200字符。' },
                  basis: { type: 'string', description: '非空维护依据，最多2000字符。' },
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
              additionalProperties: true,
              required: [
                'id',
                'relPath',
                'displayName',
                'filename',
                'ext',
                'bytes',
                'sha256',
                'createdAt',
                'removedAt',
              ],
              properties: {
                id: { type: 'integer', description: '稳定的 stored_file 主键。' },
                relPath: { type: 'string', description: '文件库内相对路径;显示名更新不会改变此路径。' },
                displayName: { type: 'string', description: '用户可见名称。' },
                filename: { type: 'string', description: '磁盘上的原始文件名;显示名更新不会改变它。' },
                ext: { type: 'string', description: '文件扩展名。' },
                bytes: { type: 'integer', description: '原文件字节数。' },
                sha256: { type: 'string', description: '原文件 SHA-256。' },
                createdAt: { type: 'string', format: 'date-time' },
                removedAt: { type: 'string', format: 'date-time', nullable: true },
              },
            },
          },
        },
      },
      401: { description: '版本化写入缺少 API token。' },
      409: { description: '维护修订、幂等键或已移出状态冲突。' },
      500: { description: '事务失败；元数据与审计回滚。' },
      400: { description: 'id 非法、请求字段混合/不支持,或字段值无效。' },
      404: { description: '文件不存在。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  setHeader(event, 'cache-control', 'no-store')
  if (hasFileMaintenanceControls(body)) requireApiToken(event)
  const pg = usePostgresFileDb()
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id <= 0) throw createError({ statusCode: 400, message: '文件 id 非法' })
  try {
    const { options, patch } = splitFileMaintenanceBody(body, 'update')
    return await maintainPostgresFile(pg, useRuntimeConfig().filesDir, id, 'update', patch, options, requestLogContext(event))
  } catch (error) {
    throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message })
  }
})
