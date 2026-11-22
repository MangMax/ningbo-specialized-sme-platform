import { savePostgresEnterpriseDetails } from '../../../../utils/enterprise-directory-postgres-write'
import { requireApiToken } from '../../../../utils/api-guard'
import { sameOriginBrowserAccess } from '../../../../utils/browser-page-access'
import { directoryInput, directoryResult, usePostgresDirectoryWriteDb, enterpriseId } from '../../../../utils/enterprise-directory-route'
import { enterpriseDetailsSchema } from '../../../../utils/enterprise-contract'

defineRouteMeta({ openAPI: {
  tags: ['企业基础库'], summary: '更新企业区划、行业及地址',
  description: '区划和行业省略时保留，传 null 清空。地址随本次资料整组保存。支持授权调用和平台同源页面。',
  security: [{ bearerAuth: [] }, {}],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['expectedRevision', 'registeredAddress', 'operatingAddress'], properties: {
      expectedRevision: { type: 'integer', minimum: 1 }, districtCode: { type: 'string', nullable: true },
      townshipCode: { type: 'string', nullable: true }, industryCode: { type: 'string', nullable: true },
      registeredAddress: { type: 'string', nullable: true, ...{ maxLength: 500 } },
      operatingAddress: { type: 'string', nullable: true, ...{ maxLength: 500 } },
    },
  } } } },
  responses: { 200: { description: '已保存的企业资料及新版本' }, 409: { description: '企业或资料版本有冲突' } },
} })

export default defineEventHandler(async event => {
  if (!sameOriginBrowserAccess(event, 'x-enterprise-library-browser')) requireApiToken(event)
  const id = directoryInput(enterpriseId, getRouterParam(event, 'id'))
  const input = directoryInput(enterpriseDetailsSchema, await readBody(event))
  return directoryResult(() => {
    const db = usePostgresDirectoryWriteDb()
    return savePostgresEnterpriseDetails(db, id, input)
  })
})
