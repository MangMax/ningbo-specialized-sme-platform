import { evidenceCorrectionRoute } from '~~/server/utils/roster-evidence-correction-route'
defineRouteMeta({ openAPI: { tags: ['名录出处'], summary: '按幂等键精确恢复出处更正回执', security: [{ bearerAuth: [] }], parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string', description: '最长200字符' } }], responses: { 200: { description: 'Committed receipt' }, 401: { description: 'Configured token required' }, 404: { description: 'Receipt not found' } } } })
export default evidenceCorrectionRoute('batch')
