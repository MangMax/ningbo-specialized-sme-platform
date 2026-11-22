import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  platformApplyProjection, platformBusinessObservation, platformBusinessProjection, platformLegacyRelationAlias,
  platformObservationAssignment, platformRecognizedProjection,
} from '../../../../db/postgresql/platform-tables'
import { normalizeUscc } from '../../lib/domain'
import type { PlatformFactInterface,PlatformObservationFact } from '../../lib/platform/observation-facts'
import type { PlatformStoredRelation } from '../../lib/platform/read'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import type { RosterPlatformQueryRow } from '../../lib/roster/enterprise-roster'
import type { PlatformDetailObservation } from '../../lib/roster/platform-business-detail'
import { groupPlatformBusinessDetails } from '../../lib/roster/platform-business-detail'
import { projectBusinessProcessObservationFact } from './platform-business-processes-projection'
import { readPostgresPlatformBusinessGroups, type readPlatformBusinessGroups } from './platform-business-record-postgres'
import { projectDeclarationObservationFact } from './platform-declarations-projection'
import { projectRecognizedObservationFact } from './platform-recognized-projection'

type Pg = Pick<NodePgDatabase, 'execute' | 'select'>
type Positions = { sourceRdjb: string | null | undefined }
type Projection = typeof platformApplyProjection | typeof platformBusinessProjection | typeof platformRecognizedProjection

export function archiveFactFieldOrder(fact: PlatformObservationFact): PlatformObservationFact {
  if (fact.interface !== 'recognized_list') return fact
  return { ...fact, modeledFields: [
    ...fact.modeledFields.filter(field => field === 'nameRaw' || field === 'usccRaw'),
    ...fact.modeledFields.filter(field => field !== 'nameRaw' && field !== 'usccRaw'),
  ] }
}

export function archiveObservations(enterpriseId: number, queries: RosterPlatformQueryRow[], relations: PlatformStoredRelation[],
  positions: Map<number,Positions>, typedFields: Map<number,PlatformObservationFact>) {
  const byQuery = new Map(queries.map(q => [q.id, q]))
  return relations.map(archived => {
    const query = byQuery.get(archived.queryId)!
    const fact = typedFields.get(archived.id)
    if (!fact?.archiveProcessFacts) throw new Error(`missing_archive_process_facts:${archived.id}`)
    const row = { ...archived, ...fact.archiveProcessFacts, normalizationConflicts: fact.normalizationConflicts }
    const rdjb = query.interface === 'recognized_list' ? positions.get(row.id)?.sourceRdjb ?? '' : query.rdjb.trim() || fact.titleRaw || ''
    const titleCode = (query.interface === 'recognized_list' ? RDJB_TITLE_CODES[rdjb] ?? query.titleCode : query.titleCode ?? RDJB_TITLE_CODES[rdjb]) ?? ''
    const conflicts: string[] = row.normalizationConflicts.length ? ['platform_field_conflict'] : []
    const rawRdjb = fact.titleRaw ?? ''
    if (rawRdjb && RDJB_TITLE_CODES[rawRdjb] && titleCode && RDJB_TITLE_CODES[rawRdjb] !== titleCode) conflicts.push('title_conflict')
    const rawUscc = normalizeUscc(fact.usccRaw)
    if (rawUscc && normalizeUscc(row.usccRaw) && rawUscc !== normalizeUscc(row.usccRaw)) conflicts.push('identity_conflict')
    return { relationId: row.id, queryId: row.queryId, sequenceNo: row.sequenceNo, interface: query.interface, relationKey: row.relationKey, queriedAt: query.queriedAt, queryStatus: query.status, queryKey: query.queryKey, rdjb, queryTitleCode: query.titleCode ?? null, titleCode, enterpriseId: row.enterpriseId, usccRaw: row.usccRaw, nameRaw: row.nameRaw, verificationStatus: row.verificationStatus, matchBasis: row.matchBasis,
      // Archive grouping has no event/title-role selection. Actual query title is kept above for conflicts.
      target: { eventId: null, enterpriseId, titleCode: '', type: 'archive', role: 'archive' }, evidence: {}, conflicts }
  })
}

export function groupBusinessDetails(groups: ReturnType<typeof readPlatformBusinessGroups>, typedFields: Map<number,PlatformObservationFact>) {
  const observations = groups.flatMap(g => g.observationRefs).map((o): PlatformDetailObservation => ({ relationId: o.relationId, queryId: o.queryId, queriedAt: o.queriedAt, businessRecord: o.businessRecord, existingCorrespondenceIds: o.existingCorrespondenceIds, existingCorrespondences: o.existingCorrespondences, conflicts: o.conflicts, titleCode: o.titleCode, enterpriseId: o.enterpriseId, usccRaw: o.usccRaw, nameRaw: o.nameRaw, typedFields: typedFields.get(o.relationId)?.projectionVersionId != null ? typedFields.get(o.relationId)! : null })).sort((a, b) => a.relationId - b.relationId)
  return groupPlatformBusinessDetails(observations)
}

async function loadPostgresFacts(db: Pg, table: Projection, ids: number[]) {
  if (!ids.length) return []
  const a = platformLegacyRelationAlias
  const o = platformBusinessObservation
  const version = alias(table, 'version_projection')
  const first = platformObservationAssignment
  return db.select({ relationId: a.oldId, source: table, version, originalName: first.nameRaw, originalUscc: first.usccRaw })
    .from(a).innerJoin(o, eq(o.id, a.observationId)).innerJoin(table, eq(table.observationId, o.id))
    .leftJoin(version, and(eq(version.versionId, o.versionId), eq(version.recordId, o.recordId)))
    .innerJoin(first, and(eq(first.observationId, o.id), eq(first.revision, 1)))
    // A single array bind preserves global relation order without the parameter-count limit.
    .where(sql`${a.oldId} = ANY(${sql.param(ids)}::bigint[])`).orderBy(a.oldId)
}

export async function readPostgresPlatformDetailFacts(db: Pg, queries: RosterPlatformQueryRow[], relations: PlatformStoredRelation[]) {
  const byQuery = new Map(queries.map(query=>[query.id,query.interface]))
  const scoped = Map.groupBy(relations, row=>byQuery.get(row.queryId))
  const ids = (source: PlatformFactInterface) => (scoped.get(source) ?? []).map(row=>row.id)
  const declarations = await loadPostgresFacts(db,platformApplyProjection,ids('apply_list'))
  const processes = await loadPostgresFacts(db,platformBusinessProjection,ids('business_list'))
  const recognized = await loadPostgresFacts(db,platformRecognizedProjection,ids('recognized_list'))
  const value = (bytes: Buffer | null, kind: string) => kind === 'text' ? bytes?.toString('utf8') ?? null : bytes
  const facts = [
    ...declarations.map(row => projectDeclarationObservationFact(row as unknown as Parameters<typeof projectDeclarationObservationFact>[0])),
    ...processes.map(row => {
      const source = row.source as typeof platformBusinessProjection.$inferSelect
      return projectBusinessProcessObservationFact({
        ...row,
        source: { ...source,
          storedStatus: value(source.storedStatus, source.storedStatusSqliteStorage),
          reconciledStatus: value(source.reconciledStatus, source.reconciledStatusSqliteStorage),
        },
      } as unknown as Parameters<typeof projectBusinessProcessObservationFact>[0])
    }),
    ...recognized.map(row => projectRecognizedObservationFact(row as unknown as Parameters<typeof projectRecognizedObservationFact>[0]))
      .map(archiveFactFieldOrder),
  ]
  return new Map(facts.map(fact=>[fact.relationId,fact]))
}

export async function readPostgresPlatformBusinessDetails(db: Pg, enterpriseId: number, queries: RosterPlatformQueryRow[],
  relations: PlatformStoredRelation[], positions: Map<number,Positions>, typedFields: Map<number,PlatformObservationFact>) {
  const groups = await readPostgresPlatformBusinessGroups(db,archiveObservations(enterpriseId,queries,relations,positions,typedFields))
  return groupBusinessDetails(groups,typedFields)
}
