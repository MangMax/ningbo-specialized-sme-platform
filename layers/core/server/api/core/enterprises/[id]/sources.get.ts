import { usePostgresDirectoryDb } from '../../../../../../../db/postgresql/client'
import { listPostgresEnterpriseSources } from '../../../../utils/enterprise-directory-postgres'
import { directoryInput, enterpriseId } from '../../../../utils/enterprise-directory-route'

defineRouteMeta({ openAPI: {
  tags: ['企业基础库'], summary: '按企业读取已登记的来源', responses: { 200: { description: '来源、系列和文件版本列表' } },
} })
export default defineEventHandler(event => {
  const id = directoryInput(enterpriseId, getRouterParam(event, 'id'))
  const postgres = usePostgresDirectoryDb()
  return listPostgresEnterpriseSources(postgres, id)
})
