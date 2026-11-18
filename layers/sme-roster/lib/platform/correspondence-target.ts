/** Typed H1c target reference. Ordinary expand schema remains unchanged. */
import { eq,inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { recordCorrespondence } from '../../../../db/schema'
import { targetSchema,platformLegacyRelationAlias as a } from './target-schema'
export const targetRecordCorrespondence = recordCorrespondence
export function readObservationCorrespondenceRefs(db:BetterSQLite3Database<typeof targetSchema>|BetterSQLite3Database<typeof import('../../../../db/schema')>,relationIds:number[]) {
 const c=targetRecordCorrespondence
 return relationIds.length?db.select({relationId:a.oldId,id:c.id,status:c.status,revision:c.revision}).from(c).innerJoin(a,eq(a.observationId,c.observationId)).where(inArray(a.oldId,relationIds)).orderBy(a.oldId,c.id).all():[]
}
