import { correspondenceRoute } from '#sme-roster/server/utils/record-correspondence-route'
defineRouteMeta({ openAPI: { tags: ['名录对应'], summary: '按原幂等键恢复已提交回执', security: [{ bearerAuth: [] }], parameters: [{ name: 'idempotencyKey', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Committed correspondence receipt' }, 401: { description: 'Token absent or unconfigured' }, 404: { description: 'No committed receipt' } } } })
export default correspondenceRoute('batch', { key: true })
