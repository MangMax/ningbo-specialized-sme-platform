import { sql } from 'drizzle-orm'
import { useDb, schema } from '@db/index'

/** Smoke endpoint for ticket 01: proves the Nuxt → Nitro → Drizzle → SQLite chain. */
export default defineEventHandler(() => {
  const db = useDb()
  const titles = db.select().from(schema.title).all()
  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.record)
    .get()
  return { titles, recordCount: total?.n ?? 0 }
})
