/** Explicit finalized-target archive seam. No runtime selector or legacy entity join. */
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as schema } from './target-schema'
import type { LegacyReference, ArchiveReference } from './immutable-archive'
export { insertArchiveValue, readArchiveValue, bindArchive, sealArchiveOwner, writeOwnerArchive, readOwnerArchive, bindLegacyAlias, reserveLegacyIds, allocateLegacyAlias } from './immutable-archive'
export function resolveLegacyReference<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>, input:LegacyReference):ArchiveReference|null {
  if(input.version!==1||!['query','relation'].includes(input.kind)||!Number.isSafeInteger(input.queryId)||input.queryId<1)throw new Error('Invalid legacy namespace or identity')
  const q=schema.platformLegacyQueryAlias,c=schema.platformCollection
  const query=db.select({collectionId:c.id}).from(q).innerJoin(c,eq(c.id,q.collectionId)).where(eq(q.oldId,input.queryId)).get()
  if(!query)return null
  if(input.kind==='query')return {version:2,kind:'collection',collectionId:query.collectionId}
  if(!Number.isSafeInteger(input.relationId)||input.relationId<1)throw new Error('Invalid legacy identity')
  const a=schema.platformLegacyRelationAlias,o=schema.platformBusinessObservation
  const found=db.select({observationId:o.id}).from(a).innerJoin(o,eq(o.id,a.observationId)).innerJoin(c,eq(c.id,o.collectionId)).where(and(eq(a.oldId,input.relationId),eq(c.id,query.collectionId))).get()
  return found?{version:2,kind:'observation',observationId:found.observationId,collectionId:query.collectionId}:null
}
