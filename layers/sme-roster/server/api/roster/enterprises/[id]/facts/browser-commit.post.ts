import { browserEnterpriseFactsRoute } from '#sme-roster/server/utils/browser-enterprise-facts'
defineRouteMeta({ openAPI: { tags: ['企业事实'], summary: '同源页面事实提交', description: '提交预检绑定的业务命令；复用事实幂等、版本检查及原子审计。适配器身份不是个人身份。', responses: { 200: { description: '事实回执' }, 403: { description: '页面写入关闭或非同源' }, 409: { description: '事实冲突' } } } })
export default browserEnterpriseFactsRoute('commit')
