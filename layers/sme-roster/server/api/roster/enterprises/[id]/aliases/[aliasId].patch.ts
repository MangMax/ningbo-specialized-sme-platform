import { usePostgresDirectoryDb } from '../../../../../../../../db/postgresql/client'
import { maintainPostgresEnterpriseAlias } from '../../../../../utils/alias-maintenance-postgres'
import { semanticRouteHandler } from '../../../../../../../core/server/utils/core-route'
import { requireApiToken } from '../../../../../../../core/server/utils/api-guard'

defineRouteMeta({ openAPI: {
  tags: ['企业别名维护'], summary: '显式确认、更正或撤回企业别名',
  description: '需要API token。confirm可恢复已撤回同ID别名；correct只更正允许字段并保留核验状态，不能静默恢复；withdraw撤回有效搜索/匹配资格。原名称、原来源与历史保留。事务提交，版本与同键载荷冲突409。',
  parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
    { name: 'aliasId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
    { name: 'Authorization', in: 'header', description: 'Bearer <NUXT_API_TOKEN>', schema: { type: 'string' } },
  ],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['action', 'expectedVersion', 'actor', 'basis', 'idempotencyKey'],
    properties: {
      action: { type: 'string', enum: ['confirm', 'correct', 'withdraw'] },
      expectedVersion: { type: 'integer', minimum: 1 },
      actor: { type: 'string', description: '去首尾空白后1–200字符' },
      basis: { type: 'string', description: '去首尾空白后1–4000字符' },
      idempotencyKey: { type: 'string', description: '去首尾空白后1–200字符' },
      changes: { type: 'object', additionalProperties: false, description: '仅correct允许，必须实际改变字段。未提供保留；null仅清除validFrom/validTo/note。', properties: {
        name: { type: 'string', description: '去首尾空白后1–1000字符' },
        sourceKind: { type: 'string', enum: ['platform_business', 'platform_apply', 'announcement', 'manual'] },
        sourceRefId: { type: 'integer', minimum: 0, description: '平台关系ID；announcement为由该企业同原名称的记录出处支持的经信局source_document ID；manual必须0，依据写basis。' },
        validFrom: { type: 'string', nullable: true, description: '非空时去首尾空白后1–100字符' },
        validTo: { type: 'string', nullable: true, description: '非空时去首尾空白后1–100字符' },
        note: { type: 'string', nullable: true, description: '最多4000字符' },
      } },
    },
  } } } },
  responses: {
    200: { description: '{alias,replayed}；同键同归一化载荷返回首次决策的alias快照，不追加历史。alias含稳定id、enterpriseId、version、verificationStatus及原名称和来源。' },
    400: { description: '字段/动作/来源证据不合法，不产生部分写入。' },
    401: { description: '未配置或未通过API token。' }, 404: { description: '企业或其别名不存在。' },
    409: { description: '版本、幂等键、自然键、主体或状态转换冲突。' },
  },
} })
export default semanticRouteHandler('maintenance.alias.patch', async event => {
  setHeader(event, 'cache-control', 'no-store')
  requireApiToken(event)
  const pg = usePostgresDirectoryDb()
  return maintainPostgresEnterpriseAlias(pg, getRouterParam(event, 'id'), getRouterParam(event, 'aliasId'), await readBody(event))
})
