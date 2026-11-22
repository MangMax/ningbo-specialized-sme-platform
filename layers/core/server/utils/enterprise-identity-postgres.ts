import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

export async function postgresCanonicalEnterpriseId(db: Pick<NodePgDatabase, 'execute'>, enterpriseId: number) {
  const { rows: [owner] } = await db.execute<{ id: string; cycle: boolean }>(sql`
    WITH RECURSIVE chain(id) AS (
      SELECT id FROM enterprise WHERE id = ${enterpriseId}
      UNION ALL
      SELECT m.into_enterprise_id FROM chain c JOIN enterprise_merge m ON m.from_enterprise_id = c.id
    ) CYCLE id SET cycle USING path
    SELECT c.id, c.cycle FROM chain c
    WHERE c.cycle OR NOT EXISTS (SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id = c.id)`)
  if (owner?.cycle) throw new Error('Enterprise identity merge cycle')
  return owner ? Number(owner.id) : null
}
