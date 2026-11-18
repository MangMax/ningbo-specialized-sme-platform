import { semanticRouteHandler } from '../../../../../../layers/core/server/utils/core-route'
import { useDb } from '@db'
import { getEnterpriseAlias } from '../../../../../utils/alias-maintenance'
defineRouteMeta({ openAPI: {
  tags: ['企业别名维护'], summary: '按企业和别名稳定ID精确查询',
  parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
    { name: 'aliasId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
  ],
  responses: { 200: { description: '完整别名，包括id/enterpriseId/version/name/nameNorm/sourceKind/sourceRefId/validFrom/validTo/note/verificationStatus/createdAt及不可变originalName/originalSourceKind/originalSourceRefId。' }, 400: { description: 'ID非法。' }, 404: { description: '企业或其别名不存在，不跨企业猜测目标。' } },
} })
export default semanticRouteHandler('maintenance.alias.get', event => {
  setHeader(event, 'cache-control', 'no-store')
  return getEnterpriseAlias(useDb(), getRouterParam(event, 'id'), getRouterParam(event, 'aliasId'))
})
