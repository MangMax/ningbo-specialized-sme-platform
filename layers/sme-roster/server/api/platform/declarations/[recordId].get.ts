import { getRouterParam, setHeader } from 'h3'
import { readPlatformArchiveDetail } from '../../../utils/platform-archive-read'

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '读取单条申报记录的实际观察与历史版本',
    description:
      '只读本地 apply_list 申报记录。返回全部内容版本（含未建立 typed 投影的历史版本）和该记录的实际观察元数据；不返回 raw JSON、不复制对应决定。版本最多 100、观察最多 200，超出时 counts.*Truncated=true，不静默截断。',
    parameters: [{ name: 'recordId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
    responses: {
      200: { description: 'record, versions[], observations[], counts{versions,observations,versionsTruncated,observationsTruncated}。' },
      400: { description: 'recordId 非法。' },
      404: { description: '记录不存在或不是 apply_list。' },
    },
  },
})

export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  const raw = getRouterParam(event, 'recordId')
  const recordId = Number(raw)
  try {
    return await readPlatformArchiveDetail('declarations', recordId)
  } catch (error) {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    throw createError({ statusCode: failure.statusCode ?? 500, statusMessage: failure.message ?? 'declaration read failed' })
  }
})
