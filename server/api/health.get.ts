import { sql } from 'drizzle-orm'
import { useDb, schema } from '@db/index'

/** Smoke endpoint for ticket 01: proves the Nuxt → Nitro → Drizzle → SQLite chain. */
defineRouteMeta({
  openAPI: {
    tags: ['系统'],
    summary: '健康检查',
    description: '证明 Nuxt → Nitro → Drizzle → SQLite 这条链是通的(票 01)。只读。',
    responses: { 200: { description: '`{ titles, recordCount }`。' } },
  },
})

export default defineEventHandler(() => {
  const db = useDb()
  const titles = db.select().from(schema.title).all()
  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.record)
    .get()
  return { titles, recordCount: total?.n ?? 0 }
})
