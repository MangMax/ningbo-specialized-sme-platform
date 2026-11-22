import { getRouterParam, setHeader } from 'h3'
import { readPlatformArchiveDetail } from '../../../utils/platform-archive-read'

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '读取单条申报记录的当前业务内容及采集证据',
    description:
      "返回申报记录的当前业务内容和当次采集摘要。",

    parameters: [{ name: 'recordId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
    responses: {
      200: { description: 'record, current, versions[], observations[], counts{versions,observations,versionsTruncated,observationsTruncated}。' },
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
