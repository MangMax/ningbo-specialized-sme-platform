import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformApplyProjection, platformBusinessObservation, platformBusinessProjection,
  platformBusinessRecordVersion, platformRecognizedProjection } from '../../../../db/postgresql/platform-tables'
import { platformObservationComparison, platformObservationVersionDefaults } from '../../lib/platform/postgres-observation-facts'
import type { CorrespondenceRelationSource } from './record-correspondence-model'
import { readPostgresFingerprintQueries, readPostgresRelationFingerprints } from './postgres-platform-fingerprint'

type Db = Pick<NodePgDatabase, 'execute' | 'select'>
type ProjectionOwner = { observationId: number; interface: keyof typeof projections }
const projections = {
  apply_list: platformApplyProjection,
  business_list: platformBusinessProjection,
  recognized_list: platformRecognizedProjection,
} as const

type ComparisonFacts = Omit<CorrespondenceRelationSource['facts'], 'id' | 'queryId' | 'sequenceNo' | 'enterpriseId' | 'usccRaw' | 'verificationStatus' | 'sourceRdjb'> & {
  sqlFactTitle: string | null
}

export async function readPostgresObservationComparisonFacts(db: Db, owners: ProjectionOwner[], view: 'normalized' | 'archive' | 'version' = 'normalized') {
  const result = new Map<number, ComparisonFacts>()
  const o = platformBusinessObservation
  const v = platformBusinessRecordVersion
  for (const [source, matching] of Map.groupBy(owners, owner => owner.interface)) {
    const p = projections[source]
    const rows = await db.select({
      id: o.id, sourceValues: o.sourceValues, versionId: o.versionId,
      observationFields: o.businessFields, versionFields: v.businessFields, projection: p,
    }).from(o).leftJoin(v, eq(v.id, o.versionId)).leftJoin(p, eq(p.versionId, o.versionId))
      .where(eq(o.id, sql`ANY(${sql.param(matching.map(row => row.observationId))}::bigint[])`))
    for (const row of rows) {
      const defaults = platformObservationVersionDefaults(source, row.projection)
      const comparison = platformObservationComparison(source, row.sourceValues, defaults,
        row.versionId === null ? row.observationFields : row.versionFields)
      const fields = { ...comparison.normalized }
      if (view !== 'normalized' && source !== 'recognized_list' && row.projection) {
        for (const key of ['status', 'declareKind', 'appliedAt', 'year', 'batch', 'awardBatchLabel', 'province'] as const) {
          if (!Object.hasOwn(defaults, key)) continue
          const value = defaults[key] ?? null
          if (view === 'version' || value !== null && !comparison.normalizationConflicts.some(conflict => conflict.field === key)) {
            Object.assign(fields, { [key]: value })
          }
        }
      }
      result.set(row.id, { ...fields, normalizationConflicts: comparison.normalizationConflicts, sqlFactTitle: comparison.sqlFactTitle,
        rawFields: { rdjb: comparison.sourceTitle === null ? null : String(comparison.sourceTitle) } })
    }
  }
  return result
}

export async function readPostgresCorrespondenceTargetSources(db: Db, ids: readonly number[]): Promise<CorrespondenceRelationSource[]> {
  if (!ids.length) return []
  const owners = await readPostgresRelationFingerprints(db, { relationIds: ids })
  const queries = await readPostgresFingerprintQueries(db, [...new Set(owners.map(owner => owner.relation.queryId))])
  const facts = await readPostgresObservationComparisonFacts(db, owners.map(owner => ({ observationId: owner.observationId,
    interface: queries.get(owner.relation.queryId)!.query.interface })))
  return owners.map(({ relation, observationId, sourceRdjb, originalUscc }) => {
    const compact = facts.get(observationId)
    if (!compact) throw new Error('Missing correspondence source projection')
    const { sqlFactTitle: _sqlFactTitle, ...projection } = compact
    const observed: CorrespondenceRelationSource['facts'] = { ...projection,
      id: relation.id, queryId: relation.queryId, sequenceNo: relation.sequenceNo, enterpriseId: relation.enterpriseId,
      usccRaw: originalUscc, verificationStatus: relation.verificationStatus, sourceRdjb,
    }
    const query = queries.get(relation.queryId)!.query
    const { rawResponse: _rawResponse, ...queryFacts } = query
    const { rawFields: _rawFields, sourceText: _sourceText, ...relationFacts } = relation
    return { relation, query, facts: observed, observationId, provenance: { relation: relationFacts, query: queryFacts } }
  })
}
