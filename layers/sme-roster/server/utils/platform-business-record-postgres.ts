import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { eq,sql } from 'drizzle-orm'
import { platformBusinessObservation as observation, platformBusinessRecord as businessRecord,
  platformBusinessRecordVersion as version } from '../../../../db/postgresql/platform-tables'
import { normalizeUscc } from '../../lib/domain'
import type { PlatformBusinessGroup,PlatformBusinessMetadata,PlatformBusinessObservationRef,ScopedPlatformObservation } from '../../lib/platform/business-record'

export type BusinessMetadataRow =
  Pick<typeof observation.$inferSelect, 'projectionRuleVersion' | 'recordId' | 'versionId'>
  & { relationId: number; interface: PlatformBusinessMetadata['interface'] | null; platformKey: string | null;
    identityState: Exclude<PlatformBusinessMetadata['identityState'], 'not_indexed'>;
    contentState: Exclude<PlatformBusinessMetadata['contentState'], 'not_indexed'>; keySource: PlatformBusinessMetadata['keySource'];
    hashAlgorithm: string | null; contentHash: string | null }
// Drizzle inArray binds each ID separately. Use one bound array for large scoped reads.
const postgresRelationScope = (ids: readonly number[]) => sql`${observation.publicId} = ANY(${sql.param(ids)}::bigint[])`

export async function readPostgresPlatformBusinessMetadata(db: Pick<NodePgDatabase, 'select'>, relationIds: readonly number[]) {
  if (!relationIds.length) return new Map<number, BusinessMetadataRow>()
  const rows = await db.select({ relationId: observation.publicId, recordId: observation.recordId, versionId: observation.versionId,
    interface: businessRecord.interface, platformKey: businessRecord.platformKey, identityState: observation.identityState,
    contentState: observation.contentState, keySource: observation.keySource, projectionRuleVersion: observation.projectionRuleVersion,
    hashAlgorithm: version.hashAlgorithm, contentHash: version.contentHash,
  }).from(observation)
    .leftJoin(businessRecord, eq(businessRecord.id, observation.recordId))
    .leftJoin(version, eq(version.id, observation.versionId)).where(postgresRelationScope(relationIds))
  return new Map<number, BusinessMetadataRow>(rows.map(row => [row.relationId, row as BusinessMetadataRow]))
}

export async function readPostgresPlatformBusinessGroups(db: Pick<NodePgDatabase, 'select'>, observations: ScopedPlatformObservation[], metadata?: Map<number, BusinessMetadataRow>) {
  if (!observations.length) return []
  const relationIds = observations.map(row => row.relationId)
  metadata ??= await readPostgresPlatformBusinessMetadata(db, relationIds)
  return projectPlatformBusinessGroups(observations, metadata)
}

export function projectPlatformBusinessGroups(observations: ScopedPlatformObservation[], metadata: Map<number, BusinessMetadataRow>): PlatformBusinessGroup[] {
  const groups = new Map<string, PlatformBusinessObservationRef[]>()
  for (const observation of observations) {
    const row = metadata.get(observation.relationId)
    const groupState = !row?.identityState ? 'not_indexed' : row.identityState !== 'resolved' ? row.identityState : row.contentState !== 'verified' ? 'unverifiable' : 'verified'
    const businessRecord: PlatformBusinessMetadata = {
      recordId: row?.recordId ?? null, versionId: row?.versionId ?? null, interface: observation.interface,
      platformKey: row?.platformKey ?? null, groupState, identityState: row?.identityState ?? 'not_indexed', contentState: row?.contentState ?? 'not_indexed',
      keySource: row?.keySource ?? null, projectionRuleVersion: row?.projectionRuleVersion ?? null, hashAlgorithm: row?.hashAlgorithm ?? null, contentHash: row?.contentHash ?? null,
    }

    const ref: PlatformBusinessObservationRef = { ...observation, businessRecord }
    // Never group null/missing/unverified identities, nor distinct target roles.
    const key = JSON.stringify([observation.target.eventId, observation.target.enterpriseId, observation.target.titleCode, observation.target.type, observation.target.role, observation.interface,
      groupState === 'verified' ? [businessRecord.recordId, businessRecord.versionId] : ['relation', observation.relationId]])
    const group = groups.get(key)
    if (group) group.push(ref)
    else groups.set(key, [ref])
  }
  return [...groups.values()].map(observationRefs => {
    const sorted = [...observationRefs].sort((a, b) => a.relationId - b.relationId)
    const representative = sorted[0]!

    const conflicts = new Set(observationRefs.flatMap(o => o.conflicts))
    if (observationRefs.some(o => o.businessRecord.identityState === 'conflict')) conflicts.add('platform_key_conflict')
    if (new Set(observationRefs.map(o => normalizeUscc(o.usccRaw)).filter(Boolean)).size > 1 || new Set(observationRefs.map(o => o.enterpriseId).filter(id => id != null)).size > 1) conflicts.add('identity_conflict')
    if (new Set(observationRefs.map(o => o.titleCode).filter(Boolean)).size > 1) conflicts.add('title_conflict')
    return { businessRecord: representative.businessRecord, representativeRelationId: representative.relationId, observationRefs, conflicts: [...conflicts] }
  })
}
