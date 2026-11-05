import { appLog, requestLogContext } from '../../../lib/logging'
import { requireApiToken } from '../../utils/api-guard'
import { quarantineStoredFile } from '../../utils/file-physical'
import { useDb } from '@db'
import { hasFileMaintenanceControls, maintainStoredFileSync, splitFileMaintenanceBody } from '../../utils/file-maintenance'

/**
 * 把一个文件移出库与索引。`DELETE /api/files/:id`
 *
 * **默认不删磁盘文件** —— 只打 `removed_at` 标(软删除),台账的出处仍指得到它。
 * 隔离磁盘文件必须显式 `?deleteDisk=1` 并提供完整版本封套。
 */
defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '把一个文件移出库',
    description:
      '默认**软删除**(只打 `removed_at` 标,磁盘文件保留)。`deleteDisk=1` 将原字节移入可恢复隔离区；正式出处引用数大于0时拒绝。旧载荷保留原本地入口与 blind-write 语义。版本化软移出必须同时给 expectedRevision/idempotencyKey/actor/basis 并使用 API token；显式磁盘删除需要完整维护封套和 API token，返回 intent 和持久完成回执；diskDeleted=false，diskQuarantined=true。不永久擦除字节。',
    parameters: [
      {
        name: 'deleteDisk',
        in: 'query',
        schema: { type: 'string', enum: ['1', 'true'] },
        description: '显式可恢复隔离(默认不隔离)。',
      },
    ],
    requestBody: { content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false,
      properties: {
        expectedRevision: { type: 'integer', minimum: 0 },
        idempotencyKey: { type: 'string', description: '非空文本，最多200字符。' },
        actor: { type: 'string', description: '非空文本，最多200字符。' },
        basis: { type: 'string', description: '非空维护依据，最多2000字符。' },
      },
    } } } },
    responses: {
      200: { description: '软移出返回 `{ removed, diskDeleted, referenceCount }`；显式隔离另带 diskQuarantined 与 intent，diskDeleted 始终 false。' },
      400: { description: 'id 非法 / 路径越界。' },
      404: { description: '文件不存在。' },
      401: { description: '版本化写入需要 API token。' },
      409: { description: '修订或幂等冲突；磁盘删除仍被正式出处引用。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) ?? {}
  setHeader(event, 'cache-control', 'no-store')
  if (hasFileMaintenanceControls(body)) requireApiToken(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: '文件 id 非法' })
  }

  const q = getQuery(event)
  const deleteDisk = q.deleteDisk === '1' || q.deleteDisk === 'true'

  let result
  try {
    if (deleteDisk) {
      const { options } = splitFileMaintenanceBody(body, 'remove')
      requireApiToken(event)
      const receipt = quarantineStoredFile(useDb(), useRuntimeConfig().filesDir, id, options)
      appLog({ source: 'file', operation: 'file.disk.remove', outcome: 'success', fileId: id }, requestLogContext(event))
      return receipt
    }
    else {
      const { options } = splitFileMaintenanceBody(body, 'remove')
      const row = maintainStoredFileSync(useDb(), id, 'remove', {}, options)
      result = { row, diskDeleted: false, referenceCount: row.referenceCount }
    }
  } catch (error) {
    appLog({ source: 'file', operation: deleteDisk ? 'file.disk.remove' : 'file.maintenance.remove', outcome: ((error as { statusCode?: number }).statusCode ?? 500) < 500 ? 'denied' : 'failure', level: 'error', errorCode: 'file_remove_failed', fileId: id }, requestLogContext(event))
    throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message })
  }
  if (!result) throw createError({ statusCode: 404, message: '文件不存在' })

  appLog({ source: 'file', operation: deleteDisk ? 'file.disk.remove' : 'file.maintenance.remove', outcome: 'success', fileId: result.row.id }, requestLogContext(event))
  return {
    removed: result.row.removedAt !== null,
    diskDeleted: result.diskDeleted,
    referenceCount: result.referenceCount,
  }
})
