import { requestLogContext } from '../../../../lib/logging'
import { useDb } from '@db'
import { maintainStoredFile, splitFileMaintenanceBody, requireVersionedFileMaintenanceOptions } from '../../../utils/file-maintenance'
import { requireApiToken } from '../../../utils/api-guard'

defineRouteMeta({ openAPI: {
  tags: ['文件库'], summary: '恢复已移出的文件',
  description: '校验原路径普通文件、字节数和 SHA-256，恢复相同 ID；不重导正式事件。必须同时提供 expectedRevision/idempotencyKey/actor/basis，并使用 API token。',
  requestBody: { content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['expectedRevision', 'idempotencyKey', 'actor', 'basis'],
    properties: {
      expectedRevision: { type: 'integer', minimum: 0 },
      idempotencyKey: { type: 'string', description: '非空文本，最多200字符。' },
      actor: { type: 'string', description: '非空文本，最多200字符。' },
      basis: { type: 'string', description: '非空维护依据，最多2000字符。' },
    },
  } } } },
  responses: { 200: { description: '原文件行。' }, 400: { description: '非法 ID。' }, 401: { description: '缺少鉴权。' }, 404: { description: '文件不存在。' }, 409: { description: '磁盘事实或文件状态冲突。' } },
} })
export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  requireApiToken(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id <= 0) throw createError({ statusCode: 400, message: '文件 id 非法' })
  try {
    const { options } = splitFileMaintenanceBody((await readBody(event)) ?? {}, 'restore')
    return await maintainStoredFile(useDb(), useRuntimeConfig().filesDir, id, 'restore', {}, requireVersionedFileMaintenanceOptions(options), requestLogContext(event))
  }
  catch (error) { throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message }) }
})
