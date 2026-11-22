import { and, count, desc, eq, getTableColumns, gt, inArray, notExists, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { chunk } from 'es-toolkit'
import { normalizeUscc } from './domain'
import { readCuration, projectCuratedComparison } from './curation-model'
import { getPostgresComparison } from './comparison-heads-postgres'
import type { ComparisonRowFilter } from './comparison-filter'
import { attachReconcile, readReconcile } from './reconcile'
import { filterCuratedComparison, projectComparisonSummary, selectComparisonSummaryPage, type SummaryDisposition } from './comparison-summary-projection'
import { enterprise, enterpriseAlias } from '../../../db/postgresql/enterprise-tables'
import {
  platformBusinessObservation, platformCollection, platformLegacyQueryAlias, platformLegacyRelationAlias,
  platformObservationAssignment,
} from '../../../db/postgresql/platform-tables'
import { differenceReason } from '../../../db/postgresql/roster-selection-tables'
import { projectPlatformComparisonEvidence, type ComparisonObservation } from './comparison-platform-projection'
import { readPostgresFingerprintQueries, readPostgresRelationFingerprints } from '../server/utils/postgres-platform-fingerprint'
import { readPostgresObservationComparisonFacts } from '../server/utils/record-correspondence-target-postgres'
import { readPostgresQueryAssessments } from './roster/query-assessment-postgres'
import type { ComparisonSummaryOptions } from './comparison-summary-read'

type ComparisonReader = Pick<NodePgDatabase, 'select' | '$with' | 'with'>
type Subject = { id: number; nameNorm: string; uscc: string | null }
type Membership = { enterpriseId: number; queryId: number; collectionId: number; owned: boolean }
// inArray binds each ID separately. Keep queries below PostgreSQL's 65,535-parameter limit.
const ownerBatchSize = 32_768

function queriedEnterpriseIds(subjects: readonly Subject[]) {
  const owners = new Map<string, number[]>()
  for (const subject of subjects) {
    const code = normalizeUscc(subject.uscc)
    for (const key of ['name:' + subject.nameNorm, ...(code ? [code] : [])]) {
      const ids = owners.get(key) ?? []
      ids.push(subject.id)
      owners.set(key, ids)
    }
  }
  return owners
}

async function readMemberships(db: Pick<NodePgDatabase, 'select' | 'selectDistinct'>, subjects: Subject[]) {
  const latest = alias(platformObservationAssignment, 'newer_assignment')
  const membership = new Map<string, Membership>()
  const keyOf = (member: Omit<Membership, 'owned'>) => [member.enterpriseId, member.queryId, member.collectionId].join(':')
  for (const subjectIds of chunk(subjects.map(subject => subject.id), ownerBatchSize)) {
    const owned = await db.selectDistinct({
      enterpriseId: platformObservationAssignment.enterpriseId,
      collectionId: platformCollection.id,
      queryId: platformLegacyQueryAlias.oldId,
    }).from(platformObservationAssignment)
      .innerJoin(platformBusinessObservation, eq(platformBusinessObservation.id, platformObservationAssignment.observationId))
      .innerJoin(platformCollection, eq(platformCollection.id, platformBusinessObservation.collectionId))
      .innerJoin(platformLegacyQueryAlias, eq(platformLegacyQueryAlias.collectionId, platformCollection.id))
      .where(and(inArray(platformObservationAssignment.enterpriseId, subjectIds), notExists(
        db.select({ revision: latest.revision }).from(latest).where(and(
          eq(latest.observationId, platformObservationAssignment.observationId),
          gt(latest.revision, platformObservationAssignment.revision),
        )),
      )))
    for (const member of owned) {
      if (member.enterpriseId === null) continue
      const row = { ...member, enterpriseId: member.enterpriseId, owned: true }
      membership.set(keyOf(row), row)
    }
  }

  const queriedOwners = queriedEnterpriseIds(subjects)
  for (const keys of chunk([...queriedOwners.keys()], ownerBatchSize)) {
    const queried = await db.select({
      key: platformCollection.queryKey, collectionId: platformCollection.id, queryId: platformLegacyQueryAlias.oldId,
    }).from(platformCollection)
      .innerJoin(platformLegacyQueryAlias, eq(platformLegacyQueryAlias.collectionId, platformCollection.id))
      .where(inArray(platformCollection.queryKey, keys))
    for (const row of queried) {
      for (const enterpriseId of queriedOwners.get(row.key) ?? []) {
        const member = { enterpriseId, collectionId: row.collectionId, queryId: row.queryId, owned: false }
        const key = keyOf(member)
        if (!membership.has(key)) membership.set(key, member)
      }
    }
  }
  return [...membership.values()]
}

async function readPostgresCuratedComparison(db: ComparisonReader, curatedPath: string) {
  const base = await getPostgresComparison(db)
  const ownerIds = [...new Set(base.rows.map(row => row.enterpriseId))]
  const enterprises: Subject[] = []
  for (const batch of chunk(ownerIds, ownerBatchSize)) {
    enterprises.push(...await db.select({
      id: enterprise.id,
      nameNorm: enterprise.nameNorm,
      uscc: enterprise.usccNorm,
    }).from(enterprise).where(inArray(enterprise.id, batch)))
  }
  const names = new Map(enterprises.map(row => [row.id, row.nameNorm]))
  return { curated: projectCuratedComparison(base, readCuration(curatedPath), names), enterprises }
}

async function readPostgresComparisonAliases(db: Pick<NodePgDatabase, 'select'>, owners: number[]) {
  const rows: Pick<typeof enterpriseAlias.$inferSelect, 'enterpriseId' | 'name' | 'verificationStatus'>[] = []
  for (const batch of chunk([...new Set(owners)], ownerBatchSize)) {
    const aliases = await db.select({
      enterpriseId: enterpriseAlias.enterpriseId,
      name: enterpriseAlias.name,
      verificationStatus: enterpriseAlias.verificationStatus,
    }).from(enterpriseAlias).where(inArray(enterpriseAlias.enterpriseId, batch))
    for (const alias of aliases) rows.push(alias)
  }
  return Map.groupBy(rows, row => row.enterpriseId)
}

export function readPostgresComparisonExport(db: NodePgDatabase, curatedPath: string, filter: ComparisonRowFilter) {
  return db.transaction(async tx => {
    const { curated, enterprises } = await readPostgresCuratedComparison(tx, curatedPath)
    const aliases = await readPostgresComparisonAliases(tx, enterprises.map(row => row.id))
    return filterCuratedComparison(curated, filter, aliases)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function readPostgresWholeComparison(db: NodePgDatabase, input: ComparisonSummaryOptions, view: 'full' | 'summary') {
  return db.transaction(async tx => {
    const { curated, enterprises } = await readPostgresCuratedComparison(tx, input.curatedPath)
    const result = input.enterpriseId === undefined ? curated : { ...curated, rows: curated.rows.filter(row => row.enterpriseId === input.enterpriseId) }
    const scopedIds = [...new Set(result.rows.map(row => row.enterpriseId))]
    const selectedOwners = new Set(scopedIds)
    const aliases = await readPostgresComparisonAliases(tx, scopedIds)
    const { scoped, selected } = selectComparisonSummaryPage(result, input, input.page, input.pageSize, aliases)
    const members = await readMemberships(tx, enterprises.filter(row => selectedOwners.has(row.id)))
    const byOwner = new Map([...Map.groupBy(members, row => row.enterpriseId)].map(([id, rows]) => [id, rows.map(row => row.queryId)]))
    const dispositions: SummaryDisposition[] = []
    const coordinates = [differenceReason.enterpriseId, differenceReason.titleCode, differenceReason.direction] as const
    for (const owners of chunk(scopedIds, ownerBatchSize)) {
      const batch = await tx.selectDistinctOn([...coordinates], {
        enterpriseId: differenceReason.enterpriseId,
        titleCode: differenceReason.titleCode,
        direction: differenceReason.direction,
        explanationId: differenceReason.id,
        status: differenceReason.status,
        reasonCode: differenceReason.reasonCode,
        measureCode: differenceReason.measureCode,
        verificationStatus: differenceReason.verificationStatus,
        recordedAt: differenceReason.recordedAt,
        evidenceQueryId: platformLegacyQueryAlias.oldId,
        evidenceRelationId: platformLegacyRelationAlias.oldId,
      }).from(differenceReason)
        .leftJoin(platformLegacyQueryAlias, eq(platformLegacyQueryAlias.collectionId, differenceReason.evidenceQueryId))
        .leftJoin(platformLegacyRelationAlias, eq(platformLegacyRelationAlias.observationId, differenceReason.evidenceRelationId))
        .where(inArray(differenceReason.enterpriseId, owners))
        .orderBy(...coordinates, desc(differenceReason.recordedAt), desc(differenceReason.id))
      for (const row of batch) dispositions.push(row)
    }
    const selectedQueryIds = [...new Set(selected.flatMap(row => byOwner.get(row.enterpriseId) ?? []))]
    const counts = new Map<number, number>()
    for (const queryIds of chunk(selectedQueryIds, ownerBatchSize)) {
      const batch = await tx.select({ queryId: platformLegacyQueryAlias.oldId, count: count() })
        .from(platformLegacyQueryAlias)
        .innerJoin(platformBusinessObservation, eq(platformBusinessObservation.collectionId, platformLegacyQueryAlias.collectionId))
        .where(inArray(platformLegacyQueryAlias.oldId, queryIds)).groupBy(platformLegacyQueryAlias.oldId)
      for (const row of batch) counts.set(row.queryId, row.count)
    }
    const assessment = await readPostgresQueryAssessments(tx, selected)
    const assessments = assessment.map(row => ({ queryCoverage: { status: row.queryCoverage.status }, assessment: row.assessment,
      explanationValidity: { status: row.explanationValidity.status } }))
    const reconcile = readReconcile(input.reconcilePath)
    const summary = projectComparisonSummary(result, reconcile, scoped, selected, dispositions, byOwner, counts, assessments)
    if (view === 'summary') return summary
    const ownerIds = new Set(selected.map(row => row.enterpriseId))
    const { view: _view, rows: _summaries, ...countsOnly } = summary
    const rowKey = (row: { enterpriseId: number; titleCode: string; direction: string }) => [row.enterpriseId,row.titleCode,row.direction].join(':')
    const pageKeys = new Set(selected.map(rowKey))
    const rows = attachReconcile(result.rows.filter(row => pageKeys.has(rowKey(row))), reconcile)
    const platform = await readPostgresComparisonEvidence(tx, rows, enterprises.filter(row => ownerIds.has(row.id)),
      members.filter(row => ownerIds.has(row.enterpriseId)))
    return { ...countsOnly, rows: platform }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

async function readPostgresComparisonEvidence<T extends Parameters<typeof projectPlatformComparisonEvidence>[0][number]>(
  tx: NodePgDatabase, rows: T[], subjects: Subject[], membership: Membership[],
) {
  if (!rows.length) return []
  const ownerIds = subjects.map(row => row.id)
  type Disposition = Parameters<typeof projectPlatformComparisonEvidence>[2][number]
  const aliases: (typeof enterpriseAlias.$inferSelect)[] = []
  const dispositions: Disposition[] = []
  const stored = getTableColumns(differenceReason)
  for (const owners of chunk(ownerIds, ownerBatchSize)) {
    // Drizzle 0.45's ORDER BY builder has no expression-level COLLATE modifier.
    const aliasBatch = await tx.select().from(enterpriseAlias).where(inArray(enterpriseAlias.enterpriseId, owners))
      .orderBy(sql`${enterpriseAlias.nameNorm} COLLATE "C"`, enterpriseAlias.id)
    for (const row of aliasBatch) aliases.push(row)
    const dispositionBatch = await tx.select({
      ...stored, evidenceQueryId: platformLegacyQueryAlias.oldId, evidenceRelationId: platformLegacyRelationAlias.oldId,
    }).from(differenceReason)
      .leftJoin(platformLegacyQueryAlias, eq(platformLegacyQueryAlias.collectionId, stored.evidenceQueryId))
      .leftJoin(platformLegacyRelationAlias, eq(platformLegacyRelationAlias.observationId, stored.evidenceRelationId))
      .where(inArray(stored.enterpriseId, owners)).orderBy(desc(stored.recordedAt), desc(stored.id))
    for (const row of dispositionBatch) {
      dispositions.push({
        ...row,
        actor: row.actor === null ? null : JSON.parse(row.actor),
        currentQualification: row.currentQualification === null ? null : JSON.parse(row.currentQualification),
        factReferences: row.factReferences === null ? null : JSON.parse(row.factReferences),
      })
    }
  }
  const queries = [...(await readPostgresFingerprintQueries(tx, [...new Set(membership.map(row => row.queryId))], false)).values()]
    .map(row => row.query).sort((a,b) => a.id - b.id)
  const collections = [...new Set(membership.filter(row => row.owned).map(row => row.collectionId))]
  const recognized = queries.filter(query => query.interface === 'recognized_list').map(query => query.id)
  const relationIds = new Set<number>()
  const collectionBatches = chunk(collections, ownerBatchSize - 1)
  const recognizedBatches = chunk(recognized, ownerBatchSize - 1)
  for (let index = 0; index < Math.max(collectionBatches.length, recognizedBatches.length); index++) {
    const batch = await tx.select({ id: platformLegacyRelationAlias.oldId }).from(platformBusinessObservation)
      .innerJoin(platformLegacyRelationAlias, eq(platformLegacyRelationAlias.observationId, platformBusinessObservation.id))
      .innerJoin(platformLegacyQueryAlias, eq(platformLegacyQueryAlias.collectionId, platformBusinessObservation.collectionId))
      .where(or(
        inArray(platformBusinessObservation.collectionId, collectionBatches[index] ?? []),
        inArray(platformLegacyQueryAlias.oldId, recognizedBatches[index] ?? []),
      ))
    for (const row of batch) relationIds.add(row.id)
  }
  const originals = await readPostgresRelationFingerprints(tx, { relationIds: [...relationIds] })
  const byQuery = new Map(queries.map(row => [row.id,row]))
  const archive = await readPostgresObservationComparisonFacts(tx, originals.map(row =>
    ({ observationId: row.observationId, interface: byQuery.get(row.relation.queryId)!.interface })), 'archive')
  const facts = new Map<number, ComparisonObservation>()
  for (const { relation, observationId } of originals) {
    const stored = archive.get(observationId)
    if (!stored) continue
    const { rawFields: _raw, normalizationConflicts, ...archiveProcessFacts } = stored
    facts.set(relation.id, { normalizationConflicts, archiveProcessFacts })
  }
  return projectPlatformComparisonEvidence(rows, aliases, dispositions, queriedEnterpriseIds(subjects), queries, originals.map(row => row.relation)
    .sort((a,b) => a.queryId-b.queryId || a.sequenceNo-b.sequenceNo), facts)
}
