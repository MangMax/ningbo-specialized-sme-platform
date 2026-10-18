import { correspondenceRoute } from '~~/server/utils/record-correspondence-route'
defineRouteMeta({ openAPI: { tags: ['名录对应'], summary: '正式事件、文件出处和反向对应', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'source,correspondences' }, 404: { description: 'Not found' } } } })
export default correspondenceRoute('source', { id: true, kind: 'event' })
