import { requestLogContext } from '../../lib/logging'
import { useDb } from '@db'
import { getParse105, historyParse105, saveParse105, preflightRanges669, commitRanges669, ParseMaintenanceError } from './parse-maintenance-105'
import { requireApiToken } from './api-guard'

export function parseRoute105(action: 'read' | 'replace' | 'status' | 'history' | 'preflight' | 'commit') {
  return defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    if (action !== 'read' && action !== 'history') requireApiToken(event)
    const rawId = getRouterParam(event, 'id') ?? ''
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw createError({ statusCode: 400, message: '文件 ID 非法' })
    const fileId = Number(rawId)
    try {
      const db = useDb()
      if (action === 'read') {
        if (Object.keys(getQuery(event)).length) throw new ParseMaintenanceError(400, '不支持查询参数')
        return getParse105(db, fileId)
      }
      if (action === 'history') {
        const query = getQuery(event)
        const input: Record<string, unknown> = { fileId }
        for (const [key, value] of Object.entries(query)) {
          if (!['receiptId', 'afterId', 'limit'].includes(key) || typeof value !== 'string' || !/^\d+$/.test(value)) throw new ParseMaintenanceError(400, '非法历史参数')
          input[key] = Number(value)
        }
        return historyParse105(db, input)
      }
      const body = await readBody(event).catch(() => null)
      if (action === 'preflight') return await preflightRanges669(db, fileId, body, useRuntimeConfig().filesDir)
      if (action === 'commit') return await commitRanges669(db, fileId, body, useRuntimeConfig().filesDir, requestLogContext(event))
      return saveParse105(db, fileId, body, action, requestLogContext(event), useRuntimeConfig().filesDir)
    } catch (error) {
      if (error instanceof ParseMaintenanceError) throw createError({ statusCode: error.statusCode, message: error.message })
      throw error
    }
  })
}
