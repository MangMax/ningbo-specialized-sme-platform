import { eq, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'

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
