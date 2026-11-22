import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { platformBusinessObservation as observation, platformCollection as collection } from '../../../../db/postgresql/platform-tables'

export async function readPostgresCandidateSourceBytes(db: Pick<NodePgDatabase, 'select'>, relationId: number) {
  const [row] = await db.select({ collection: collection.sourceBytes, observation: observation.sourceRawBytes })
    .from(observation)
    .innerJoin(collection, eq(collection.id, observation.collectionId)).where(eq(observation.publicId, relationId))
  return row ? row.collection + row.observation : undefined
}
