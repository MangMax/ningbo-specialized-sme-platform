import { browserCorrespondenceRoute } from '~~/server/utils/browser-correspondence'
defineRouteMeta({ openAPI: { tags: ['名录对应'], summary: '同源页面对应决定预检', description: '默认允许同源页面，校验精确 Origin 与 JSON。仅接受 idempotencyKey,basis,operations；代理身份固定为 same-origin-correspondence-adapter，不识别个人。复用对应领域预检、版本与来源守卫。', responses: { 200: { description: '绑定 planHash；未提交关系' }, 400: { description: '非法业务字段或伪造身份' }, 403: { description: '非同源请求' }, 409: { description: '版本或幂等冲突' }, 422: { description: '领域拒绝' } } } })
export default browserCorrespondenceRoute('preflight')
