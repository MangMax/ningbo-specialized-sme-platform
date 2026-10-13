import { useDb } from '@db'
import { getEnterpriseDetail } from '~~/lib/query'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  const detail = getEnterpriseDetail(useDb(), id)
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'not found' })
  return detail
})
