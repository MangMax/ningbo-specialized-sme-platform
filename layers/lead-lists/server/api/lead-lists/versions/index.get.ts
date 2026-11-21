import { useDb } from '@db'
import { listLeadVersions } from '../../../utils/versions'
import { listPostgresLeadVersions, usePostgresLeadDb } from '../../../utils/postgres-versions'

defineRouteMeta({ openAPI: { tags: ['线索名单'], summary: '读取线索系列、名单版本和来源字典', responses: { 200: { description: '版本目录' } } } })

export default defineEventHandler(() => {
  const postgres = usePostgresLeadDb()
  return postgres ? listPostgresLeadVersions(postgres) : listLeadVersions(useDb())
})
