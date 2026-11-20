import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { getTableName, sql, type Table } from 'drizzle-orm'
import type * as schema from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import type { PlatformFactInterface,PlatformObservationFact } from '../../lib/platform/observation-facts'
import type { PlatformStoredRelation } from '../../lib/platform/read'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import type { RosterPlatformQueryRow } from '../../lib/roster/enterprise-roster'
import type { PlatformDetailObservation } from '../../lib/roster/platform-business-detail'
import { groupPlatformBusinessDetails } from '../../lib/roster/platform-business-detail'
import { readCandidateTargetPositions } from './candidate-target-sources'
import { projectBusinessProcessObservationFact, readTargetBusinessProcessFacts } from './platform-business-processes-target'
import { readPlatformBusinessGroups, readPostgresPlatformBusinessGroups } from './platform-business-record-read'
import { projectDeclarationObservationFact, readTargetDeclarationFacts } from './platform-declarations-target'
import { projectRecognizedObservationFact, readTargetRecognizedFacts } from './platform-recognized-target'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { platformApplyProjection, platformBusinessProjection, platformRecognizedProjection } from '../../../../db/schema'

type Db = BetterSQLite3Database<typeof schema>
type Pg = Pick<NodePgDatabase, 'execute'>
type Positions = { sourceRdjb: string | null | undefined }

function archiveFactFieldOrder(fact: PlatformObservationFact): PlatformObservationFact {
  if (fact.interface !== 'recognized_list') return fact
  return { ...fact, modeledFields: [
    ...fact.modeledFields.filter(field => field === 'nameRaw' || field === 'usccRaw'),
    ...fact.modeledFields.filter(field => field !== 'nameRaw' && field !== 'usccRaw'),
  ] }
}

/** Source-owned typed facts only. This function never reads projection tables directly:
 * each source module owns its projection layout and captured archive facts. */
export function readPlatformDetailFacts(db: Db, queries: RosterPlatformQueryRow[], relations: PlatformStoredRelation[]) {
  const byQuery = new Map(queries.map(query => [query.id, query]))
  const byInterface = new Map<PlatformFactInterface, number[]>()
  for (const relation of relations) {
    const interfaceName = byQuery.get(relation.queryId)?.interface as PlatformFactInterface | undefined
    if (!interfaceName) continue
    const ids = byInterface.get(interfaceName) ?? []
    ids.push(relation.id); byInterface.set(interfaceName, ids)
  }
  const result = new Map<number, PlatformObservationFact>()
  for (const [interfaceName, ids] of byInterface) {
    const facts = interfaceName === 'apply_list' ? readTargetDeclarationFacts(db, ids, { scope: 'selected' })
      : interfaceName === 'business_list' ? readTargetBusinessProcessFacts(db, ids, { scope: 'selected' })
      : readTargetRecognizedFacts(db, ids)
    for (const [relationId, fact] of facts) {
      // Preserve the enterprise DTO's historical identity-first field order.
      // The accepted source owner still defines field membership and values.
      result.set(relationId, archiveFactFieldOrder(fact))
    }
  }
  return result
}

/** Caller supplies only displayed enterprise-scoped archives, inside its existing read transaction. */
export function readPlatformBusinessDetails(db: Db, enterpriseId: number, queries: RosterPlatformQueryRow[],
  relations: PlatformStoredRelation[], typedFields = readPlatformDetailFacts(db, queries, relations)) {
  const positions = readCandidateTargetPositions(db, relations.map(row => row.id))
  return groupBusinessDetails(readPlatformBusinessGroups(db, archiveObservations(enterpriseId,queries,relations,positions,typedFields)),typedFields)
}

function archiveObservations(enterpriseId: number, queries: RosterPlatformQueryRow[], relations: PlatformStoredRelation[],
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

function groupBusinessDetails(groups: ReturnType<typeof readPlatformBusinessGroups>, typedFields: Map<number,PlatformObservationFact>) {
  const observations = groups.flatMap(g => g.observationRefs).map((o): PlatformDetailObservation => ({ relationId: o.relationId, queryId: o.queryId, queriedAt: o.queriedAt, businessRecord: o.businessRecord, existingCorrespondenceIds: o.existingCorrespondenceIds, existingCorrespondences: o.existingCorrespondences, conflicts: o.conflicts, titleCode: o.titleCode, enterpriseId: o.enterpriseId, usccRaw: o.usccRaw, nameRaw: o.nameRaw, typedFields: typedFields.get(o.relationId)?.projectionVersionId != null ? typedFields.get(o.relationId)! : null })).sort((a, b) => a.relationId - b.relationId)
  return groupPlatformBusinessDetails(observations)
}

async function loadPostgresFacts<T extends Table>(db: Pg, table: T, ids: number[], mixedStatus = false) {
  if (!ids.length) return []
  const { rows } = await db.execute<{ relationId:number; source:T['$inferSelect']; version:T['$inferSelect'] | null;
    originalName:string | null; originalUscc:string | null;
    stored:Buffer | null; storedKind:string; reconciled:Buffer | null; reconciledKind:string }>(sql`
    SELECT a.old_id::float8 AS "relationId",${postgresRosterRow(table,'p')} AS source,
      CASE WHEN v.id IS NOT NULL THEN ${postgresRosterRow(table,'v')} END AS version,
      first.name_raw AS "originalName",first.uscc_raw AS "originalUscc"
      ${mixedStatus ? sql`, p.stored_status AS stored,p.stored_status_sqlite_storage AS "storedKind",
        p.reconciled_status AS reconciled,p.reconciled_status_sqlite_storage AS "reconciledKind"` : sql.empty()}
    FROM platform_legacy_relation_alias a JOIN platform_business_observation o ON o.id=a.observation_id
    JOIN ${sql.identifier(getTableName(table))} p ON p.observation_id=o.id
    LEFT JOIN ${sql.identifier(getTableName(table))} v ON v.version_id=o.version_id AND v.record_id=o.record_id
    JOIN platform_observation_assignment first ON first.observation_id=o.id AND first.revision=1
    WHERE a.old_id=ANY(${sql.param(ids)}::bigint[]) ORDER BY a.old_id`)
  return rows
}

export async function readPostgresPlatformDetailFacts(db: Pg, queries: RosterPlatformQueryRow[], relations: PlatformStoredRelation[]) {
  const byQuery = new Map(queries.map(query=>[query.id,query.interface]))
  const scoped = Map.groupBy(relations, row=>byQuery.get(row.queryId))
  const ids = (source: PlatformFactInterface) => (scoped.get(source) ?? []).map(row=>row.id)
  const declarations = await loadPostgresFacts(db,platformApplyProjection,ids('apply_list'))
  const processes = await loadPostgresFacts(db,platformBusinessProjection,ids('business_list'),true)
  const recognized = await loadPostgresFacts(db,platformRecognizedProjection,ids('recognized_list'))
  const value = (bytes: Buffer | null, kind: string) => kind === 'text' ? bytes?.toString('utf8') ?? null : bytes
  const facts = [...declarations.map(projectDeclarationObservationFact),
    ...processes.map(row=>projectBusinessProcessObservationFact({ ...row, source:{ ...row.source,
      storedStatus:value(row.stored,row.storedKind),reconciledStatus:value(row.reconciled,row.reconciledKind) } })),
    ...recognized.map(projectRecognizedObservationFact).map(archiveFactFieldOrder)]
  return new Map(facts.map(fact=>[fact.relationId,fact]))
}

export async function readPostgresPlatformBusinessDetails(db: Pg, enterpriseId: number, queries: RosterPlatformQueryRow[],
  relations: PlatformStoredRelation[], positions: Map<number,Positions>, typedFields: Map<number,PlatformObservationFact>) {
  const groups = await readPostgresPlatformBusinessGroups(db,archiveObservations(enterpriseId,queries,relations,positions,typedFields))
  return groupBusinessDetails(groups,typedFields)
}
