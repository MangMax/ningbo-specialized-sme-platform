import { requestLogContext } from '../../../core/lib/logging'
import { ParseMaintenanceError } from './parse-maintenance-contract'
import { requireApiToken } from '../../../core/server/utils/api-guard'
import { usePostgresFileDb } from '../../../core/server/utils/file-store-postgres'
import { getPostgresParseState, historyPostgresParse, preflightPostgresParse, savePostgresParse } from './parse-maintenance-postgres'

export function parseRoute105(action: 'read' | 'replace' | 'status' | 'history' | 'preflight' | 'commit') {
  return defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    if (action !== 'read' && action !== 'history') requireApiToken(event)
    const rawId = getRouterParam(event, 'id') ?? ''
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw createError({ statusCode: 400, message: '文件 ID 非法' })
    const fileId = Number(rawId)
    try {
      const pg = usePostgresFileDb()
      if (action === 'read') {
        if (Object.keys(getQuery(event)).length) throw new ParseMaintenanceError(400, '不支持查询参数')
        return await getPostgresParseState(pg, fileId)
      }
      if (action === 'history') {
        const query = getQuery(event)
        const input: Record<string, unknown> = { fileId }
        for (const [key, value] of Object.entries(query)) {
          if (!['receiptId', 'afterId', 'limit'].includes(key) || typeof value !== 'string' || !/^\d+$/.test(value)) throw new ParseMaintenanceError(400, '非法历史参数')
          input[key] = Number(value)
        }
        return await historyPostgresParse(pg, input)
      }
      const body = await readBody(event).catch(() => null)
      const root = useRuntimeConfig().filesDir
      if (action === 'preflight') return await preflightPostgresParse(pg, fileId, body, root)
      return await savePostgresParse(pg, fileId, body, root, action, requestLogContext(event))
    } catch (error) {
      if (error instanceof ParseMaintenanceError) throw createError({ statusCode: error.statusCode, message: error.message })
      throw error
    }
  })
}
