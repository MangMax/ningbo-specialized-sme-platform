import { setHeader } from 'h3'
import { rosterWriteEnabled } from '../../utils/postgres-roster-db'

defineRouteMeta({
  openAPI: {
    tags: ['名录维护'],
    summary: '读取名录页面写入的可用状态',
    description: '只返回 {writeEnabled}。同源页面默认可提交，实际请求仍须通过同源及业务校验。该状态不是登录身份，也不表示谁在操作；无需 API token。',
    responses: { 200: { description: '{writeEnabled:boolean}；永远 no-store，不回 token、不回操作人' } },
  },
})

/** 轻量状态位：只告诉页面“这台机器是否允许页面提交”，不泄露配置值或任何身份。 */
export default defineEventHandler((event) => {
  setHeader(event, 'cache-control', 'no-store')
  return { writeEnabled: rosterWriteEnabled() }
})
