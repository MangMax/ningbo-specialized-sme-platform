import { record } from '../../db/postgresql/ledger-tables'
import { title } from '../../db/postgresql/title-table'
import { count } from 'drizzle-orm'
import { useDb, schema } from '@db/index'
import { usePostgresDirectoryDb } from '../../db/postgresql/client'
import { postgresOnlyRuntime } from '../../db/runtime-mode'
import { applicationLogs } from '../../layers/core/lib/logging'
import { checkPostgresJobStorage } from '../../layers/core/server/utils/job-store-postgres'

defineRouteMeta({
  openAPI: {
    tags: ['系统'],
    summary: '健康检查',
    description: '只读检查已配置的业务库。PostgreSQL 模式也检查任务表和独立日志连接。',
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
      const health = await postgres!.transaction(async tx => {
        const titles = await tx.select().from(title).orderBy(title.rank, title.code)
        const recordCount = await tx.$count(record)
        return { titles, recordCount }
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
      await checkPostgresJobStorage(postgres!)
      await applicationLogs().policy()
      return health
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
    .select({ n: count() })
    .from(schema.record)
    .get()
  return { titles, recordCount: total?.n ?? 0 }
})
