import { evidenceCorrectionRoute } from '~~/server/utils/roster-evidence-correction-route'
defineRouteMeta({ openAPI: { tags: ['名录出处'], summary: '按稳定证据 ID 精确读取正式出处和版本', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { 200: { description: 'evidenceId,eventId,recordId,enterpriseId,coordinate,file,version,sourceHref' }, 404: { description: 'Evidence not found' } } } })
export default evidenceCorrectionRoute('get')
