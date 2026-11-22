import { title } from '../../../../../../db/postgresql/title-table'
import { usePostgresRosterDb } from '../../../utils/postgres-roster-db'

defineRouteMeta({ openAPI: { tags: ['优质中小企业'], summary: '读取认定称号字典',
  responses: { 200: { description: '称号编码与名称' } },
} })

export default defineEventHandler(() => usePostgresRosterDb()
  .select({ code: title.code, name: title.nameZh }).from(title).orderBy(title.rank, title.code))
