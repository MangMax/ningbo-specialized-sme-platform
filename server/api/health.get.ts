import { sql } from 'drizzle-orm'
import { useDb, schema } from '@db/index'
import { usePostgresDirectoryDb } from '../../db/postgresql/client'
import { postgresOnlyRuntime } from '../../db/runtime-mode'
import { applicationLogs } from '../../layers/core/lib/logging'

defineRouteMeta({
  openAPI: {
    tags: ['系统'],
    summary: '健康检查',
    description: '只读检查已配置的业务库。PostgreSQL 模式也检查独立日志连接。',
    responses: {
      200: { description: '`{ titles, recordCount }`。' },
      503: { description: 'PostgreSQL 19 或原生 schema 尚未就绪。' },
    },
  },
})

export default defineEventHandler(async () => {
  if (postgresOnlyRuntime()) {
    try {
      const postgres = usePostgresDirectoryDb()
      const result = await postgres!.execute<{
        titles: { code: string; nameZh: string; level: string; rank: number }[]
        recordCount: number
      }>(sql`
        SELECT
          (SELECT coalesce(json_agg(
            json_build_object('code', code, 'nameZh', name_zh, 'level', level, 'rank', rank) ORDER BY rank, code
          ), '[]') FROM business.title) AS titles,
          (SELECT count(*)::integer FROM business.record) AS "recordCount"
      `)
      const health = result.rows[0]!
      await applicationLogs().policy()
      return { titles: health.titles, recordCount: health.recordCount }
    } catch {
      throw createError({
        statusCode: 503,
        statusMessage: 'PostgreSQL runtime unavailable',
        data: { code: 'postgresql_runtime_unavailable' },
      })
    }
  }
  const db = useDb()
  const titles = db.select().from(schema.title).all()
  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.record)
    .get()
  return { titles, recordCount: total?.n ?? 0 }
})
