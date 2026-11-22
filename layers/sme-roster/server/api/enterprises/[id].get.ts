import { readPostgresLedgerEnterpriseDetail } from '#sme-roster/lib/query-postgres'
import { usePostgresRosterDb } from '../../utils/postgres-roster-db'

/** 企业详情含该企业的台账记录与事件。 */
defineRouteMeta({
  openAPI: {
    tags: ['台账'],
    summary: '企业详情',
    responses: {
      200: { description: '企业详情(含记录与事件)。' },
      400: { description: 'id 不是数字。' },
      404: { description: '没有这个企业。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  const detail = await readPostgresLedgerEnterpriseDetail(usePostgresRosterDb(), id)
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'not found' })
  return detail
})
