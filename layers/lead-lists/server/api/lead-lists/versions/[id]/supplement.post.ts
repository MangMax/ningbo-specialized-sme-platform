import { usePostgresLeadWriteDb } from '../../../../utils/postgres-versions'
import { browserSupplementInput, supplementInput, supplementPostgresLeadVersion } from '../../../../utils/postgres-supplement'
import { requireApiToken } from '../../../../../../core/server/utils/api-guard'
import { sameOriginBrowserAccess } from '#core/server/utils/browser-page-access'
import { leadListId } from '../../../../../lib/contracts'

const pageInput = browserSupplementInput.transform(input => ({
  ...input, actor: { type: 'user' as const, id: 'lead-lists-page' }, basis: '线索名单页面补充',
}))

defineRouteMeta({ openAPI: {
  tags: ['线索名单'], summary: '将已核对的名单行补充到企业基础库', security: [{ bearerAuth: [] }, {}],
  description: '同源页面通过 X-Lead-List-Browser: 1 提交 decisions。自动化调用使用 Bearer token，同时传入 actor 和 basis。关联已有企业时，fields 中明确提供的资料将同步保存。',
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['decisions'], properties: {
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
  const browser = sameOriginBrowserAccess(event, 'x-lead-list-browser')
  if (!browser) requireApiToken(event)
  const id = leadListId.safeParse(Number(getRouterParam(event, 'id')))
  const body = await readBody(event)
  const parsed = (browser ? pageInput : supplementInput).safeParse(body)
  if (!id.success || !parsed.success) throw createError({ statusCode: 400, message: '补充资料有误', data: parsed.error?.issues })
  return supplementPostgresLeadVersion(usePostgresLeadWriteDb(), id.data, parsed.data)
})
