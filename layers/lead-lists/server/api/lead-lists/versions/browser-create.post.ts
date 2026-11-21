import { sameOriginBrowserAccess } from '#core/server/utils/browser-page-access'
import { registerLeadVersionRequest } from '../../../utils/registration-route'

defineRouteMeta({ openAPI: {
  tags: ['线索名单'],
  summary: '页面新增线索名单',
  description: '仅供单机应用的同源页面发起，校验 X-Lead-List-Browser: 1、Sec-Fetch-Site、Origin 和 JSON。与自动化登记共用名单行、原件及版本冲突校验。',
  requestBody: { $ref: '#/paths/~1api~1lead-lists~1versions/post/requestBody' },
  responses: {
    200: { description: '相同名单的既有版本' },
    201: { description: '已保存的名单版本' },
    400: { description: '名单资料有误' },
    403: { description: '请求未通过同源页面校验' },
    409: { description: '版本或原件有冲突' },
  },
} })

export default defineEventHandler(async event => {
  if (!sameOriginBrowserAccess(event, 'x-lead-list-browser')) {
    throw createError({ statusCode: 403, message: '请从当前平台的线索名单页重新打开「新增名单」后再试。' })
  }
  return registerLeadVersionRequest(event)
})
