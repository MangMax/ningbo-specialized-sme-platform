import { title as postgresTitle } from '../../../../../../db/postgresql/title-table'
import { asc } from 'drizzle-orm'
import { useDb } from '@db'
import { title } from '@db/schema'
import { usePostgresRosterDb } from '../../../utils/postgres-roster-db'

defineRouteMeta({ openAPI: { tags: ['优质中小企业'], summary: '读取认定称号字典',
  responses: { 200: { description: '称号编码与名称' } },
} })

export default defineEventHandler(async () => {
  const pg = usePostgresRosterDb()
  return pg ? pg.select({ code: postgresTitle.code, name: postgresTitle.nameZh }).from(postgresTitle)
      .orderBy(postgresTitle.rank, postgresTitle.code)
    : useDb().select({ code:title.code,name:title.nameZh }).from(title).orderBy(asc(title.rank)).all()
})
