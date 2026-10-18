import { correspondenceRoute } from '~~/server/utils/record-correspondence-route'
defineRouteMeta({ openAPI: { tags: ['名录对应'], summary: '读取对应决定的追加审计', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', maximum: 200 } }], responses: { 200: { description: 'rows,total,page,pageSize' }, 404: { description: 'Not found' } } } })
export default correspondenceRoute('audit', { id: true })
