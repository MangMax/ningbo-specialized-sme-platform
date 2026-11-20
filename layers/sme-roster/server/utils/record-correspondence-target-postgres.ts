import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { decodePostgresExactCell } from '../../../../db/postgresql/exact-cell'
import { platformNormalizationConflict } from '../../lib/platform/normalization'
import type { readCorrespondenceTargetSources } from './record-correspondence-target-sources'
import { readPostgresFingerprintQueries, readPostgresRelationFingerprints } from './postgres-platform-fingerprint'

type Db = Pick<NodePgDatabase, 'execute'>
type RelationSource = ReturnType<typeof readCorrespondenceTargetSources>[number]
type ProjectionOwner = { observationId: number; interface: keyof typeof projections }
const fields = [
  ['province', 'province'], ['status', 'status'], ['batch', 'batch'], ['declareKind', 'declare_kind'],
  ['appliedAt', 'applied_at'], ['awardBatchLabel', 'award_batch_label'], ['year', 'year'],
] as const
const projections = {
  apply_list: 'platform_apply_projection',
  business_list: 'platform_business_projection',
  recognized_list: 'platform_recognized_projection',
} as const

function fieldValue(row: Record<string, unknown>, field: string, key: string) {
  const value = row[key]
  if (field === 'status' && Buffer.isBuffer(value)) return decodePostgresExactCell(value, row[key + '_sqlite_storage'] as string)
  return field === 'year' && value != null ? Number(value) : value
}

export async function readPostgresObservationComparisonFacts(db: Db, owners: ProjectionOwner[], archiveDisplay = false) {
  const facts = new Map<number, Record<string, unknown>>()
  for (const [kind, matching] of Map.groupBy(owners, owner => owner.interface)) {
    const table = sql.identifier(projections[kind])
    const columns = sql.join(fields.flatMap(([, key]) => ['stored_' + key, 'parsed_' + key, 'reconciled_' + key, key + '_conflict'])
      .map(key => sql`p.${sql.identifier(key)}`), sql`,`)
    const version = archiveDisplay && kind !== 'recognized_list'
      ? sql`JOIN platform_business_observation o ON o.id=p.observation_id
        LEFT JOIN ${table} v ON v.version_id=o.version_id AND v.record_id=o.record_id` : sql.empty()
    const typed = !archiveDisplay || kind === 'recognized_list' ? sql.empty() : sql`,v.declare_kind AS typed_declare_kind,
      v.applied_at AS typed_applied_at,v.status AS typed_status,
      ${kind === 'apply_list' ? sql`v.declaration_year AS typed_year` : sql`v.business_year AS typed_year,
        v.batch AS typed_batch,v.award_batch_label AS typed_award_batch_label,v.province AS typed_province`}`
    const { rows } = await db.execute(sql`
      SELECT p.observation_id,p.source_title_kind,p.source_title_text,p.source_title_number_text,${columns}
        ${kind === 'business_list' ? sql`,p.stored_status_sqlite_storage,p.reconciled_status_sqlite_storage` : sql.empty()}${typed}
      FROM ${table} p ${version}
      WHERE p.observation_id=ANY(${sql.param(matching.map(row => row.observationId))}::bigint[])`)
    for (const row of rows) facts.set(Number(row.observation_id), row)
  }
  const result = new Map<number, Omit<RelationSource['facts'], 'id' | 'queryId' | 'sequenceNo' | 'enterpriseId' | 'usccRaw' | 'verificationStatus' | 'sourceRdjb'>>()
  for (const [id, p] of facts) {
    const conflicts = fields.flatMap(([field, key]) => {
      const stored = fieldValue(p, field, 'stored_' + key), parsed = fieldValue(p, field, 'parsed_' + key)
      return String(p[key + '_conflict']) === '1' && stored != null && parsed != null ? [platformNormalizationConflict(field, stored, parsed)] : []
    })
    const value = (field: typeof fields[number][0], column: string) => {
      const typed = p['typed_' + column]
      return typed != null && !conflicts.some(conflict => conflict.field === field)
        ? fieldValue(p, field, 'typed_' + column) : fieldValue(p, field, 'reconciled_' + column)
    }
    result.set(id, {
      province: value('province','province') as string | null,
      status: value('status','status') as string | Buffer | null,
      batch: value('batch','batch') as string | null,
      declareKind: value('declareKind','declare_kind') as string | null,
      appliedAt: value('appliedAt','applied_at') as string | null,
      awardBatchLabel: value('awardBatchLabel','award_batch_label') as string | null,
      year: value('year','year') as number | null,
      normalizationConflicts: conflicts,
      rawFields: { rdjb: p.source_title_kind === 'text' ? p.source_title_text as string : p.source_title_kind === 'number' ? p.source_title_number_text as string : null },
    })
  }
  return result
}

export async function readPostgresCorrespondenceTargetSources(db: Db, ids: readonly number[]): Promise<RelationSource[]> {
  if (!ids.length) return []
  const owners = await readPostgresRelationFingerprints(db, { relationIds: ids })
  const queries = await readPostgresFingerprintQueries(db, [...new Set(owners.map(owner => owner.relation.queryId))])
  const facts = await readPostgresObservationComparisonFacts(db, owners.map(owner => ({ observationId: owner.observationId,
    interface: queries.get(owner.relation.queryId)!.query.interface })))
  return owners.map(({ relation, observationId, sourceRdjb, originalUscc }) => {
    const projection = facts.get(observationId)
    if (!projection) throw new Error('Missing correspondence source projection')
    const observed: RelationSource['facts'] = { ...projection,
      id: relation.id, queryId: relation.queryId, sequenceNo: relation.sequenceNo, enterpriseId: relation.enterpriseId,
      usccRaw: originalUscc, verificationStatus: relation.verificationStatus, sourceRdjb,
    }
    return { relation, query: queries.get(relation.queryId)!.query, facts: observed, observationId }
  })
}
