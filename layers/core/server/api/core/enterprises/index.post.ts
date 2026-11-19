import { useDb } from '@db'
import { requireApiToken } from '../../../utils/api-guard'
import { addEnterprise, enterpriseFieldsSchema } from '../../../utils/enterprise-kernel'
import { directoryInput, directoryResult } from '../../../utils/enterprise-directory-route'

defineRouteMeta({ openAPI: {
  tags: ['企业基础库'], summary: '直接添加企业及来源', security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['name'], properties: {
      name: { type: 'string' }, uscc: { type: 'string', nullable: true }, districtCode: { type: 'string', nullable: true },
      townshipCode: { type: 'string', nullable: true }, industryCode: { type: 'string', nullable: true },
    },
  } } } },
  responses: { 200: { description: '已登记的企业' }, 409: { description: '主体或字典校验失败' } },
} })
export default defineEventHandler(async event => {
  requireApiToken(event)
  const fields = directoryInput(enterpriseFieldsSchema.required({ name: true }), await readBody(event))
  return directoryResult(() => addEnterprise(useDb(), fields))
})
