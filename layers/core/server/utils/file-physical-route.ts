import { readPostgresPhysicalIntent, recoverPostgresFile } from './file-physical-postgres'
import { usePostgresFileDb } from './file-store-postgres'
import { requireApiToken } from './api-guard'
import { splitFileMaintenanceBody } from './file-maintenance-shared'
import { createError, defineEventHandler, getQuery, getRouterParam, readBody, setHeader } from 'h3'

export function physicalRecoveryRoute(action: 'read' | 'recover') {
  return defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    if (action === 'recover') requireApiToken(event)
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isSafeInteger(id) || id <= 0) throw createError({ statusCode: 400, message: '文件 id 非法' })
    try {
      const pg = usePostgresFileDb()
      if (action === 'read') {
        const intentId = getQuery(event).intentId
        if (intentId !== undefined && (typeof intentId !== 'string' || intentId.length > 100)) throw createError({ statusCode: 400, message: 'intentId 非法' })
        return await readPostgresPhysicalIntent(pg, id, intentId)
      }
      const body = await readBody(event)
      if (!body || typeof body !== 'object' || !('intentId' in body) || typeof body.intentId !== 'string' || !body.intentId || body.intentId.length > 100) throw createError({ statusCode: 400, message: 'intentId 必须为有界非空文本' })
      const { intentId, ...controls } = body
      const { options } = splitFileMaintenanceBody(controls, 'restore')
      const root = useRuntimeConfig().filesDir
      return await recoverPostgresFile(pg, root, id, intentId, options)
    } catch (error) {
      throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message })
    }
  })
}
