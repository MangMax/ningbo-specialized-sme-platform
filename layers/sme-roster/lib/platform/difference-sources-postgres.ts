import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { readDifferenceObservation } from './difference-sources'

type Observation = NonNullable<ReturnType<typeof readDifferenceObservation>>

export async function readPostgresDifferenceObservations(db: Pick<NodePgDatabase, 'execute'>, relationIds: readonly number[]) {
  if (!relationIds.length) return new Map<number, Observation>()
  const { rows } = await db.execute<{ observation: Observation }>(sql`
    SELECT json_build_object('id', r.old_id, 'observationId', o.id, 'collectionId', o.collection_id,
      'queryId', q.old_id, 'sequenceNo', o.sequence_no, 'relationKey', o.source_relation_key, 'versionId', o.version_id,
      'enterpriseId', a.enterprise_id, 'uscc', original.uscc_raw, 'nameRaw', original.name_raw,
      'aliasNameRaw', original.alias_name_raw, 'verificationStatus', a.verification_status, 'matchBasis', a.match_basis) AS observation
    FROM platform_legacy_relation_alias r JOIN platform_business_observation o ON o.id=r.observation_id
    JOIN platform_legacy_query_alias q ON q.collection_id=o.collection_id
    JOIN platform_observation_assignment original ON original.observation_id=o.id AND original.revision=1
    JOIN LATERAL (SELECT enterprise_id,verification_status,match_basis FROM platform_observation_assignment
      WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1) a ON true
    WHERE r.old_id=ANY(${sql.param(relationIds)}::bigint[])`)
  return new Map(rows.map(({ observation }) => [observation.id, observation]))
}
