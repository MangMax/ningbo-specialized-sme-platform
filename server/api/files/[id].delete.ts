import { useDb } from '@db'
import { removeStoredFile } from '../../utils/stored-files'

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
      '默认**软删除**(只打 `removed_at` 标,磁盘文件保留)。`deleteDisk=1` 才真删磁盘 —— 不可撤销。',
    parameters: [
      {
        name: 'deleteDisk',
        in: 'query',
        schema: { type: 'string', enum: ['1', 'true'] },
        description: '真删磁盘文件(默认不删)。',
      },
    ],
    responses: {
      200: { description: '`{ removed, diskDeleted, referenceCount }`。' },
      400: { description: 'id 非法 / 路径越界。' },
      404: { description: '文件不存在。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: '文件 id 非法' })
  }

  const q = getQuery(event)
  const deleteDisk = q.deleteDisk === '1' || q.deleteDisk === 'true'

  let result
  try {
    result = await removeStoredFile(useDb(), useRuntimeConfig().filesDir, id, { deleteDisk })
  } catch (error) {
    throw createError({ statusCode: 400, message: (error as Error).message })
  }
  if (!result) throw createError({ statusCode: 404, message: '文件不存在' })

  return {
    removed: true,
    diskDeleted: result.diskDeleted,
    referenceCount: result.referenceCount,
  }
})
