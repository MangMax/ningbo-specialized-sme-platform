import { eq, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as s from '../../../../db/schema'

type Executor = Pick<BetterSQLite3Database<typeof s>, 'select'>
function prepareCatalog(db:Executor) {
  return db.select({name:sql<string>`name`}).from(sql`sqlite_schema`).where(sql`type='table' and name='enterprise_merge'`).prepare()
}
const catalogs=new WeakMap<Executor,ReturnType<typeof prepareCatalog>>()

/** Schema0 remains available only while the offline target migration is being completed. */
export function hasEnterpriseMergeIdentity(db: Executor) {
  let catalog=catalogs.get(db)
  if(!catalog){catalog=prepareCatalog(db);catalogs.set(db,catalog)}
  return !!catalog.get()
}

/** Current membership excludes historical identities, while direct identity reads remain possible. */
export function currentEnterpriseIdentity(db: Executor, id: SQL = sql`${s.enterprise.id}`) {
  return hasEnterpriseMergeIdentity(db)
    ? sql`not exists(select 1 from enterprise_merge identity_merge where identity_merge.from_enterprise_id=${id})`
    : sql`1`
}

/** Follow recorded identity merges without changing the original enterprise or assignment rows. */
function prepareIdentity(db:Executor) {
  return {enterprise:db.select({id:s.enterprise.id}).from(s.enterprise).where(eq(s.enterprise.id,sql.placeholder('id'))).prepare(),
    next:db.select({id:s.enterpriseMerge.intoEnterpriseId}).from(s.enterpriseMerge).where(eq(s.enterpriseMerge.fromEnterpriseId,sql.placeholder('id'))).prepare()}
}
const identities=new WeakMap<Executor,ReturnType<typeof prepareIdentity>>()
export function canonicalEnterpriseId(db: Executor, enterpriseId: number): number | null {
  if (!hasEnterpriseMergeIdentity(db)) return db.select({id:s.enterprise.id}).from(s.enterprise).where(eq(s.enterprise.id,enterpriseId)).get()?enterpriseId:null
  let queries=identities.get(db)
  if(!queries){queries=prepareIdentity(db);identities.set(db,queries)}
  if(!queries.enterprise.get({id:enterpriseId}))return null
  const seen = new Set<number>()
  let id = enterpriseId
  for (;;) {
    if (seen.has(id)) throw new Error('Enterprise identity merge cycle')
    seen.add(id)
    const next = queries.next.get({id})
    if (!next) return id
    id = next.id
  }
}

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
