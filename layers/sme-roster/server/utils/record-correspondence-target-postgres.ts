import { and, eq, getTableColumns, isNotNull, sql } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformApplyProjection, platformBusinessObservation, platformBusinessProjection, platformRecognizedProjection } from '../../../../db/postgresql/platform-tables'
import { decodePostgresExactCell } from '../../../../db/postgresql/exact-cell'
import { platformNormalizationConflict } from '../../lib/platform/normalization'
import type { readCorrespondenceTargetSources } from './record-correspondence-target-sources'
import { readPostgresFingerprintQueries, readPostgresRelationFingerprints } from './postgres-platform-fingerprint'

type Db = Pick<NodePgDatabase, 'execute' | 'select'>
type RelationSource = ReturnType<typeof readCorrespondenceTargetSources>[number]
type ProjectionOwner = { observationId: number; interface: keyof typeof projections }
const fields = [
  ['province', 'province'], ['status', 'status'], ['batch', 'batch'], ['declareKind', 'declare_kind'],
  ['appliedAt', 'applied_at'], ['awardBatchLabel', 'award_batch_label'], ['year', 'year'],
] as const
const projections = {
  apply_list: platformApplyProjection,
  business_list: platformBusinessProjection,
  recognized_list: platformRecognizedProjection,
} as const

function fieldValue(row: Record<string, unknown>, field: string, key: string) {
  const value = row[key]
  if (field === 'status' && Buffer.isBuffer(value)) return decodePostgresExactCell(value, row[key + '_sqlite_storage'] as string)
  return field === 'year' && value != null ? Number(value) : value
}

export async function readPostgresObservationComparisonFacts(db: Db, owners: ProjectionOwner[], view: 'normalized' | 'archive' | 'version' = 'normalized') {
  const facts = new Map<number, Record<string, unknown>>()
  for (const [kind, matching] of Map.groupBy(owners, owner => owner.interface)) {
    const p = alias(projections[kind], 'stored'), v = alias(projections[kind], 'version')
    const o = platformBusinessObservation
    const storedColumns = new Map<string, AnyPgColumn>(Object.values(getTableColumns(p)).map(column => [column.name, column]))
    const names = fields.flatMap(([, key]) => ['stored_' + key, 'parsed_' + key, 'reconciled_' + key, key + '_conflict'])
    if (kind === 'business_list') names.push('stored_status_sqlite_storage', 'reconciled_status_sqlite_storage')
    const compareFields = Object.fromEntries(names.map(name => [name, storedColumns.get(name)!]))
    const common = {
      observation_id: p.observationId,
      source_title_kind: p.sourceTitleKind,
      source_title_text: p.sourceTitleText,
      source_title_number_text: p.sourceTitleNumberText,
      ...compareFields,
    }
    const where = eq(p.observationId, sql`ANY(${sql.param(matching.map(row => row.observationId))}::bigint[])`)
    const rows = view === 'normalized' || kind === 'recognized_list'
      ? await db.select(common).from(p).where(where)
      : await db.select({
        ...common,
        has_version: sql<boolean>`${isNotNull(v.versionId)}`,
        ...('declareKind' in v ? { typed_declare_kind: v.declareKind, typed_applied_at: v.appliedAt, typed_status: v.status } : {}),
        ...('declarationYear' in v ? { typed_year: v.declarationYear } : 'businessYear' in v
          ? { typed_year: v.businessYear, typed_batch: v.batch, typed_award_batch_label: v.awardBatchLabel, typed_province: v.province }
          : {}),
      }).from(p).innerJoin(o, eq(o.id, p.observationId))
        .leftJoin(v, and(eq(v.versionId, o.versionId), eq(v.recordId, o.recordId))).where(where)
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
      if (view === 'version' && p.has_version && 'typed_' + column in p) return fieldValue(p, field, 'typed_' + column)
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
