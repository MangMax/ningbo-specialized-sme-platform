import { correspondenceRoute } from '#sme-roster/server/utils/record-correspondence-route'
defineRouteMeta({ openAPI: { tags: ['名录对应'], summary: '读取单条对应与原行出处', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'CorrespondenceDetail' }, 404: { description: 'Not found' } } } })
export default correspondenceRoute('get', { id: true })
