import { comparisonScopeProofRoute } from '#sme-roster/server/utils/comparison-scope-proof-route'
defineRouteMeta({ openAPI: { tags: ['对比范围证明'], summary: '按幂等键恢复证明提交回执', security: [{ bearerAuth: [] }], parameters: [{ name: 'idempotencyKey', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Committed receipt' }, 401: { description: 'Token absent or unconfigured' }, 404: { description: 'Receipt not found' } } } })
export default comparisonScopeProofRoute('batch', 'key')
