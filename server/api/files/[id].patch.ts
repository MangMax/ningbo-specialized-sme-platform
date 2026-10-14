import { useDb } from '@db'
import { parseMetadataPatch, updateStoredFile } from '../../utils/stored-files'

/**
 * 改一个文件的**元数据**。`PATCH /api/files/:id`
 *
 * 只改 `source / kind / year / batch / title_code / category_state / parse_state`;
 * **不动 `rel_path`、不动磁盘上的文件**(票 09 硬要求,`parseMetadataPatch` 会拒掉
 * 任何磁盘事实字段)。返回改后的整行,让列表能就地更新。
 */
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: '文件 id 非法' })
  }

  let patch
  try {
    patch = parseMetadataPatch(await readBody(event))
  } catch (error) {
    // 用 `message` 而不是 `statusMessage`:h3 会对较长的 statusMessage 告警
    // (它将被按 HTTP 语义净化)。前端从 `data.message` 取这句话。
    throw createError({ statusCode: 400, message: (error as Error).message })
  }

  const row = updateStoredFile(useDb(), id, patch)
  if (!row) throw createError({ statusCode: 404, message: '文件不存在' })
  return row
})
