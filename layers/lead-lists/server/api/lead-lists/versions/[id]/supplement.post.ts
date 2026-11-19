import { useDb } from '@db'
import { requireApiToken } from '../../../../../../core/server/utils/api-guard'
import { leadListId } from '../../../../../lib/contracts'
import { supplementInput, supplementLeadVersion } from '../../../../utils/versions'

defineRouteMeta({ openAPI: {
  tags: ['线索名单'], summary: '将已核对的名单行补充到企业基础库', security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['actor', 'basis', 'decisions'], properties: {
      actor: { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string', enum: ['user', 'agent'] }, id: { type: 'string' } } },
      basis: { type: 'string' }, decisions: { type: 'array', minItems: 1, maxItems: 200, items: {
        type: 'object', required: ['rowId', 'action'], properties: {
          rowId: { type: 'integer' }, action: { type: 'string', enum: ['create', 'attach'] }, fields: { type: 'object' }, enterpriseId: { type: 'integer' }, expectedRevision: { type: 'integer' },
        },
      } },
    },
  } } } },
  responses: { 200: { description: '企业与名单来源关联' }, 409: { description: '核对结果或企业版本冲突' } },
} })

export default defineEventHandler(async event => {
  requireApiToken(event)
  const id = leadListId.safeParse(Number(getRouterParam(event, 'id')))
  const parsed = supplementInput.safeParse(await readBody(event))
  if (!id.success || !parsed.success) throw createError({ statusCode: 400, message: '补充资料有误', data: parsed.error?.issues })
  return supplementLeadVersion(useDb(), id.data, parsed.data)
})
