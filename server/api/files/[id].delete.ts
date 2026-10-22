import { appLog, requestLogContext } from '../../../lib/logging'
import { requireApiToken } from '../../utils/api-guard'
import { useDb } from '@db'
import { removeStoredFileSync } from '../../utils/stored-files'
import { hasFileMaintenanceControls, maintainStoredFileSync, splitFileMaintenanceBody } from '../../utils/file-maintenance'

/**
 * 把一个文件移出库与索引。`DELETE /api/files/:id`
 *
 * **默认不删磁盘文件** —— 只打 `removed_at` 标(软删除),台账的出处仍指得到它。
 * 要真删磁盘必须显式 `?deleteDisk=1`,由界面上的二次确认负责发起(票 09)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '把一个文件移出库',
    description:
      '默认**软删除**(只打 `removed_at` 标,磁盘文件保留)。`deleteDisk=1` 才真删磁盘 —— 不可撤销，正式出处引用数大于0时拒绝。旧载荷保留原本地入口与 blind-write 语义。版本化软移出必须同时给 expectedRevision/idempotencyKey/actor/basis 并使用 API token；显式磁盘删除不接受幂等键。',
    parameters: [
      {
        name: 'deleteDisk',
        in: 'query',
        schema: { type: 'string', enum: ['1', 'true'] },
        description: '真删磁盘文件(默认不删)。',
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
      200: { description: '`{ removed, diskDeleted, referenceCount }`。' },
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
      if (options.idempotencyKey) throw createError({ statusCode: 400, message: '磁盘删除需要单独明确授权，不接受软移出幂等键' })
      const db = useDb()
      result = db.transaction((tx) => {
        maintainStoredFileSync(tx, id, 'remove', {}, options)
        return removeStoredFileSync(tx, useRuntimeConfig().filesDir, id, { deleteDisk: true })
      }, { behavior: 'immediate' })
    }
    else {
      const { options } = splitFileMaintenanceBody(body, 'remove')
      const row = maintainStoredFileSync(useDb(), id, 'remove', {}, options)
      result = { row, diskDeleted: false, referenceCount: row.referenceCount }
    }
  } catch (error) {
    appLog({ source: 'file', operation: deleteDisk ? 'file.disk.remove' : 'file.maintenance.remove', outcome: ((error as { statusCode?: number }).statusCode ?? 500) < 500 ? 'denied' : 'failure', level: 'error', errorCode: 'file_remove_failed' }, requestLogContext(event))
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
