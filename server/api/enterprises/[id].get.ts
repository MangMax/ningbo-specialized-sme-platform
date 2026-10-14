import { useDb } from '@db'
import { getEnterpriseDetail } from '~~/lib/query'

/**
 * 一个企业的详情(含它的记录与事件)。
 *
 * 本票只加了 `defineRouteMeta`(`:id` 是**路径参数**,由 Nitro 自动推断进 spec,
 * 无需手写);**错误文案与其它行为一字未改** —— 那不在票 19 的范围里。
 */
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

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  const detail = getEnterpriseDetail(useDb(), id)
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'not found' })
  return detail
})
