import { eventCorrectionRoute } from '../../../utils/roster-event-correction-route'
defineRouteMeta({ openAPI: { tags: ['正式事件更正'], summary: '精确读取正式事件、版本、原出处与生命周期', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { 200: { description: 'event, record, evidence, files(hash metadata), lifecycle; no raw platform blobs' }, 404: { description: 'Official event not found' } } } })
export default eventCorrectionRoute('get')
