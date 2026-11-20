import { asc, sql } from 'drizzle-orm'
import { useDb } from '@db'
import { title } from '@db/schema'
import { usePostgresRosterDb } from '../../../utils/postgres-roster-db'

defineRouteMeta({ openAPI: { tags: ['优质中小企业'], summary: '读取认定称号字典',
  responses: { 200: { description: '称号编码与名称' } },
} })

export default defineEventHandler(async () => {
  const pg = usePostgresRosterDb()
  return pg ? (await pg.execute<{ code:string; name:string }>(sql`SELECT code,name_zh AS name FROM title ORDER BY rank,code`)).rows
    : useDb().select({ code:title.code,name:title.nameZh }).from(title).orderBy(asc(title.rank)).all()
})
