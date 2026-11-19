import { useDb } from '@db'
import { requireApiToken } from '../../../../../core/server/utils/api-guard'
import { versionInput } from '../../../../lib/contracts'
import { registerLeadVersion } from '../../../utils/versions'

defineRouteMeta({ openAPI: {
  tags: ['线索名单'], summary: '登记线索名单版本和原行', security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['series', 'channel', 'listType', 'acquiredOn', 'fileId', 'rows'],
    properties: { series: { type: 'string' }, channel: { type: 'string' }, listType: { type: 'string' },
      acquiredOn: { type: 'string', format: 'date' }, fileId: { type: 'integer' }, rows: { type: 'array', minItems: 1, maxItems: 2000,
        items: { type: 'object', required: ['rowNumber', 'name'], properties: { rowNumber: { type: 'integer' }, name: { type: 'string' }, uscc: { type: 'string' }, district: { type: 'string' }, note: { type: 'string' } } } } },
  } } } },
  responses: { 200: { description: '已存在的相同版本' }, 201: { description: '已登记的版本' }, 409: { description: '版本或原件有冲突' } },
} })

export default defineEventHandler(async event => {
  requireApiToken(event)
  const parsed = versionInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: '名单版本资料有误', data: parsed.error.issues })
  const result = await registerLeadVersion(useDb(), useRuntimeConfig(event).filesDir, parsed.data)
  if (result.created) setResponseStatus(event, 201)
  return result
})
