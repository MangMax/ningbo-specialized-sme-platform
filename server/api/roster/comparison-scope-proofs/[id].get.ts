import { comparisonScopeProofRoute } from '~~/server/utils/comparison-scope-proof-route'
defineRouteMeta({ openAPI: { tags: ['对比范围证明'], summary: '读取证明及来源漂移状态', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Proof, revision and validity' }, 404: { description: 'Proof not found' } } } })
export default comparisonScopeProofRoute('get', 'id')
