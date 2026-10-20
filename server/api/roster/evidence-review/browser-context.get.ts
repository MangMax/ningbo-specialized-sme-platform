import { setHeader } from 'h3'
import { browserReviewWriteEnabled } from '../../../utils/browser-review-102'

defineRouteMeta({
  openAPI: {
    tags: ['证据复核'],
    summary: '读取页面复核的可用状态',
    description: '只返回 {writeEnabled}。未开启时页面复核保持只读。该状态不是登录身份，也不表示谁在操作；无需 API token。',
    responses: { 200: { description: '{writeEnabled:boolean}；永远 no-store，不回 token、不回操作人' } },
  },
})

/** 轻量状态位：只告诉页面“这台机器是否允许页面提交”，不泄露配置值或任何身份。 */
export default defineEventHandler((event) => {
  setHeader(event, 'cache-control', 'no-store')
  return { writeEnabled: browserReviewWriteEnabled(useRuntimeConfig()) }
})
