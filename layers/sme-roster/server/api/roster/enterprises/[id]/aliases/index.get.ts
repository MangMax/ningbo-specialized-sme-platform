import { usePostgresDirectoryDb } from '../../../../../../../../db/postgresql/client'
import { listPostgresEnterpriseAliases } from '../../../../../utils/alias-maintenance-postgres'
import { semanticRouteHandler } from '../../../../../../../core/server/utils/core-route'
defineRouteMeta({ openAPI: {
  tags: ['企业别名维护'], summary: '有界查询企业别名',
  description: '只读。按稳定企业ID，按别名ID升序；包含version、原名称originalName与原来源originalSourceKind/originalSourceRefId；不加载平台原文。',
  parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
    { name: 'status', in: 'query', schema: { type: 'string', enum: ['all', 'pending', 'confirmed', 'withdrawn'], default: 'all' } },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
  ],
  responses: { 413: { description: '页面超过256KiB；减小pageSize完整读取，不截断历史或备注。' }, 200: { description: '{rows,total,page,pageSize}。无结果rows=[]，total=0。' }, 400: { description: '查询字段或页界限非法。' }, 404: { description: '企业不存在。' } },
} })
export default semanticRouteHandler('maintenance.alias.list', event => {
  setHeader(event, 'cache-control', 'no-store')
  const pg = usePostgresDirectoryDb()
  return listPostgresEnterpriseAliases(pg, getRouterParam(event, 'id'), getQuery(event))
})
