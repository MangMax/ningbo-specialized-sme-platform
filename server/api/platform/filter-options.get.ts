import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import { useDb } from '@db'
import { platformFilterOptionsQueryFromQuery } from '../../../lib/platform/filter-options'
import { readTargetDeclarationOptions } from '../../utils/platform-declarations-target'
import { readPlatformFilterOptions } from '../../utils/platform-filter-options'

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '读取本地平台筛选候选值',
    description: '只读 source/view 全范围的实际非空候选列，不受分页影响，不解析 raw JSON、不推断或补值。records 使用对应 typed 投影；isolated 使用各 reader 的关系字段，titles 是逐行 rdjb 原值；认定目录 isolated 其余不支持的字段返回空数组。年度倒序，其余按二进制顺序稳定排序。',
    parameters: [
      { name: 'source', in: 'query', required: true, schema: { type: 'string', enum: ['declarations', 'business-processes', 'recognized-directory'] } },
      { name: 'view', in: 'query', schema: { type: 'string', enum: ['records', 'isolated'], default: 'records' } },
    ],
    responses: {
      200: { description: '候选值对象 {titles,declareKinds,years,statuses,batches,districts,validityDates}；不适用字段为空数组。' },
      400: { description: 'source/view 非法、重复或出现未知参数。' },
    },
  },
})

export default defineEventHandler(event => {
  setHeader(event, 'cache-control', 'no-store')
  try {
    const query = platformFilterOptionsQueryFromQuery(getQuery(event))
    const db = useDb()
    if (query.source === 'declarations') return readTargetDeclarationOptions(query.view, db)
    return readPlatformFilterOptions(query, db)
  } catch (error) {
    const failure = error as { statusCode?: number; message?: string }
    throw createError({ statusCode: failure.statusCode ?? 500, statusMessage: failure.message ?? 'platform filter options query failed' })
  }
})
