import { usePostgresDirectoryDb } from '../../../../../../../../../db/postgresql/client'
import { getPostgresEnterpriseAliasHistory } from '../../../../../../utils/alias-maintenance-postgres'
import { semanticRouteHandler } from '../../../../../../../../core/server/utils/core-route'
defineRouteMeta({ openAPI: {
  tags: ['企业别名维护'], summary: '按别名精确查询追加历史',
  description: '审计ID升序；包括action/actor/basis/idempotencyKey/requestHash/createdAt及before/after快照，不读取平台原文。归并折叠后用保留方企业和别名ID查询；快照保留原始IDs。',
  parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
    { name: 'aliasId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
  ],
  responses: { 413: { description: '页面超过256KiB；减小pageSize完整读取，不截断历史或备注。' }, 200: { description: '{rows,total,page,pageSize}，空历史rows=[]；精确保留所有审计，按页读取。' }, 400: { description: 'ID或分页非法。' }, 404: { description: '企业或其别名不存在。' } },
} })
export default semanticRouteHandler('maintenance.alias.history', event => {
  setHeader(event, 'cache-control', 'no-store')
  const pg = usePostgresDirectoryDb()
  return getPostgresEnterpriseAliasHistory(pg, getRouterParam(event, 'id'), getRouterParam(event, 'aliasId'), getQuery(event))
})
