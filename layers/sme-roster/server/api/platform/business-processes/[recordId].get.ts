import { getRouterParam, setHeader } from 'h3'
import { useDb } from '@db'
import { getTargetBusinessProcess } from '../../../utils/platform-business-processes-target'

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '读取单条关联办理记录的实际观察与历史版本',
    description:
      '只读本地 business_list 办理记录；返回记录身份、全部内容版本（最多 100）与实际观察元数据（最多 200），包括版本 typed 字段、观察的查询称号范围、版本哈希、观察状态与企业归属。超出上限时 counts.*Truncated=true。不返回 raw JSON、不复制对应决定。',
    parameters: [{ name: 'recordId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
    responses: {
      200: { description: 'record, versions[], observations[], counts。' },
      400: { description: 'recordId 不是正整数。' },
      404: { description: '记录不存在或不是 business_list。' },
    },
  },
})

export default defineEventHandler(event => {
  setHeader(event, 'cache-control', 'no-store')
  try {
    return getTargetBusinessProcess(useDb(), Number(getRouterParam(event, 'recordId')))
  } catch (error) {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    throw createError({ statusCode: failure.statusCode ?? 500, statusMessage: failure.message ?? 'business process detail failed' })
  }
})
