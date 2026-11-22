import { usePostgresDirectoryDb } from '../../../../../../../db/postgresql/client'
import { readPostgresEnterpriseDetails } from '../../../../utils/enterprise-directory-postgres'
import { directoryInput, enterpriseId } from '../../../../utils/enterprise-directory-route'

defineRouteMeta({ openAPI: {
  tags: ['企业基础库'], summary: '读取企业区划、行业及登记和经营地址',
  responses: { 200: { description: '企业资料及版本' }, 404: { description: '企业不存在' } },
} })

export default defineEventHandler(async event => {
  const id = directoryInput(enterpriseId, getRouterParam(event, 'id'))
  const postgres = usePostgresDirectoryDb()
  const row = await readPostgresEnterpriseDetails(postgres, id)
  if (!row) throw createError({ statusCode: 404, message: '未找到企业。', data: { code: 'enterprise_not_found' } })
  return row
})
