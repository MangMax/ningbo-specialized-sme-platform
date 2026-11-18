import { browserCorrespondenceRoute } from '#sme-roster/server/utils/browser-correspondence'
defineRouteMeta({ openAPI: { tags: ['名录对应'], summary: '同源页面原子提交对应决定', description: '仅接受 {request:{idempotencyKey,basis,operations},planHash}。相同服务端代理身份和能力/同源检查；复用领域原子提交、幂等、plan 及来源版本绑定。', responses: { 200: { description: '对应决定回执，需公开 API/审计读回' }, 403: { description: '未开启或非同源' }, 409: { description: '过期 plan/来源/版本或幂等冲突' }, 422: { description: '领域拒绝；无部分提交' } } } })
export default browserCorrespondenceRoute('commit')
