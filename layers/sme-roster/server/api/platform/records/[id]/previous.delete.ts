import { usePostgresDirectoryDb } from '../../../../../../../db/postgresql/client'
import { requireApiToken } from '../../../../../../core/server/utils/api-guard'
import { prunePostgresPlatformCaptures } from '../../../../utils/platform-capture-retention-postgres'

defineRouteMeta({ openAPI: {
  tags: ['工信部平台'], summary: '删除指定业务记录的回滚备份',
  security: [{ bearerAuth: [] }],
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
  responses: { 200: { description: '删除的旧采集观察条数，重复删除返回 0' }, 401: { description: '需要 API 授权' } },
} })

export default defineEventHandler(async event => {
  requireApiToken(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 400, statusMessage: 'Invalid platform record ID' })
  if (process.env.NUXT_DB_READONLY === '1') throw createError({ statusCode: 403, statusMessage: 'Database is read-only' })
  return { removed: await prunePostgresPlatformCaptures(usePostgresDirectoryDb(), [id], false) }
})
