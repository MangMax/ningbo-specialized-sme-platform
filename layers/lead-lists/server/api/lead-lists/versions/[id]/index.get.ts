import { useDb } from '@db'
import { leadListId } from '../../../../../lib/contracts'
import { readLeadVersion } from '../../../../utils/versions'

defineRouteMeta({ openAPI: { tags: ['线索名单'], summary: '查看名单版本及原行', responses: { 200: { description: '版本及原行' } } } })

export default defineEventHandler(event => {
  const id = leadListId.safeParse(Number(getRouterParam(event, 'id')))
  if (!id.success) throw createError({ statusCode: 400, message: '名单版本编号有误' })
  return readLeadVersion(useDb(), id.data)
})
