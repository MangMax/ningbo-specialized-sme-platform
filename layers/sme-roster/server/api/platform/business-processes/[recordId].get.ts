import { getRouterParam, setHeader } from 'h3'
import { readPlatformArchiveDetail } from '../../../utils/platform-archive-read'

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '读取单条关联办理记录的当前业务内容及采集证据',
    description:
      "返回关联办理的当前业务内容和当次采集摘要。",

    parameters: [{ name: 'recordId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
    responses: {
      200: { description: 'record, current, versions[], observations[], counts。' },
      400: { description: 'recordId 不是正整数。' },
      404: { description: '记录不存在或不是 business_list。' },
    },
  },
})

export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  try {
    return await readPlatformArchiveDetail('business-processes', Number(getRouterParam(event, 'recordId')))
  } catch (error) {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    throw createError({ statusCode: failure.statusCode ?? 500, statusMessage: failure.message ?? 'business process detail failed' })
  }
})
