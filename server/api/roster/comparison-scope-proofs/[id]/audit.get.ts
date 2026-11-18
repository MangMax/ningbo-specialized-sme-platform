import { comparisonScopeProofRoute } from '#sme-roster/server/utils/comparison-scope-proof-route'
defineRouteMeta({ openAPI: { tags: ['对比范围证明'], summary: '读取证明追加决定审计', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', maximum: 200 } }], responses: { 200: { description: 'Paged immutable decisions' }, 404: { description: 'Proof not found' } } } })
export default comparisonScopeProofRoute('audit', 'id')
