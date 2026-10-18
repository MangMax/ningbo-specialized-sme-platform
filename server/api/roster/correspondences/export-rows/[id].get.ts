import { correspondenceRoute } from '~~/server/utils/record-correspondence-route'
defineRouteMeta({ openAPI: { tags: ['名录对应'], summary: '导出原行、批次版本和反向对应', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'source,correspondences' }, 404: { description: 'Not found' } } } })
export default correspondenceRoute('source', { id: true, kind: 'export_row' })
