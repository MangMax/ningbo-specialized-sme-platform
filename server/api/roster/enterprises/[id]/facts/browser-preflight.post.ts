import { browserEnterpriseFactsRoute } from '#sme-roster/server/utils/browser-enterprise-facts'
defineRouteMeta({ openAPI: { tags: ['企业事实'], summary: '同源页面事实预检', description: '复用浏览器维护部署及同源闸门；仅业务命令，actor 由真实服务端适配器记录。', responses: { 200: { description: '预检绑定' }, 403: { description: '页面写入关闭或非同源' }, 409: { description: '事实冲突' } } } })
export default browserEnterpriseFactsRoute('preflight')
