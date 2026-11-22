import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, notExists, or, sql, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise as enterpriseTable, enterpriseAlias, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { platformBusinessObservation as observation, platformCollection as collection,
  platformExportBatch as exportBatch, platformExportRow as exportRow,
  platformObservationAssignment as assignment } from '../../../../db/postgresql/platform-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { normalizeName, normalizeUscc } from '../domain'
import type { PlatformStoredQuery, PlatformStoredRelation } from '../platform/read'
import { readPostgresDisplayRows, type PostgresDisplayOwner } from '../platform/postgres-query-display'
import { TITLE_ORDER } from '../labels'
import { postgresDifferenceRow } from '../../server/utils/decision-lifecycle/postgres-reads'
import { readPostgresPlatformDetailFacts, readPostgresPlatformBusinessDetails } from '../../server/utils/platform-business-detail-postgres'
import { projectDifferences } from './current-difference'
import { readPostgresRosterDetailQualification } from './current-qualification-postgres'
import { isPageCapable } from './evidence-page'
import { qualificationUsccCandidate } from './platform-qualification-postgres'
import { isCurrentPlatformCaptureRow } from '../platform/current-observation-postgres'
import { readPostgresQueryAssessments } from './query-assessment-postgres'
import { projectEnterpriseDifferenceUniverse, projectRosterDetailHistory, projectRosterDetailRelations,
  projectRosterDetailTimeline, selectRosterDetailArchive, type RosterDetailArchive, type RosterEnterpriseDetail } from './enterprise-roster-projection'

type Reader = Pick<NodePgDatabase, 'execute' | 'select' | 'selectDistinct'>
type Enterprise = typeof enterpriseTable.$inferSelect
type Difference = Parameters<typeof projectEnterpriseDifferenceUniverse>[0]['differences'][number]
type Coordinate = Parameters<typeof projectEnterpriseDifferenceUniverse>[1][number]
// Preserve one bound parameter per large archive selection; inArray uses one per ID.
const inIds = (column: SQLWrapper, values: readonly number[]) => sql`${column} = ANY(${sql.param(values)}::bigint[])`

async function readSources(db: Reader, enterprise: Enterprise, evidenceIds: number[]) {
  const id = enterprise.id
  const nameKey = 'name:' + enterprise.nameNorm
  const uscc = normalizeUscc(enterprise.usccNorm)
  const newer = alias(assignment, 'newer')
  const owned = db.selectDistinct({ collectionId: observation.collectionId }).from(assignment)
    .innerJoin(observation, eq(observation.id, assignment.observationId))
    .where(and(isCurrentPlatformCaptureRow(db), eq(assignment.enterpriseId, id), notExists(db.select({ revision: newer.revision }).from(newer)
      .where(and(eq(newer.observationId, assignment.observationId), gt(newer.revision, assignment.revision)))))).as('owned')
  const sourceRows = await db.select({ collectionId: collection.id, provenanceState: collection.provenanceState,
    lastCollectedAt: collection.lastCollectedAt, ownedCollectionId: owned.collectionId,
    query: { id: collection.publicId, interface: collection.interface, queryKey: collection.queryKey, rdjb: collection.rdjb,
      titleCode: collection.titleCode, queriedAt: collection.queriedAt, status: collection.status,
      failureReason: collection.failureReason, createdAt: collection.createdAt },
  }).from(collection)
    .leftJoin(owned, eq(owned.collectionId, collection.id))
    .where(or(isNotNull(owned.collectionId), eq(collection.queryKey, nameKey), inIds(collection.publicId, evidenceIds),
      uscc ? qualificationUsccCandidate(collection.queryKey, [uscc]) : undefined)).orderBy(collection.publicId)
  type SourceQuery = Omit<PlatformStoredQuery, 'rawResponse' | 'collectionEvidence' | 'lastCollectedAt'>
    & Pick<PostgresDisplayOwner['query'], 'collectionEvidence'> & { relationCount: number }
  const rows = sourceRows.map(({ query, ownedCollectionId, ...row }) => ({
    ...row, owned: ownedCollectionId !== null, query: { ...query, relationCount: 0 } as SourceQuery,
  }))
  const selected = rows.filter(row=>row.owned || row.query.queryKey === nameKey || !!uscc && normalizeUscc(row.query.queryKey) === uscc)
  const recognized = selected.filter(row=>row.query.interface === 'recognized_list').map(row=>row.collectionId)
  const explain = rows.filter(row=>evidenceIds.includes(row.query.id))
  const owner = db.select({ observationId: assignment.observationId, enterpriseId: assignment.enterpriseId }).from(assignment)
    .where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('owner')
  const recognizedScope = inIds(observation.collectionId, recognized)
  const selectedPointers = await db.select({ id: observation.publicId, queryId: collection.publicId,
    collectionId: observation.collectionId, owner: owner.enterpriseId,
  }).from(observation)
    .innerJoin(collection, eq(collection.id, observation.collectionId))
    .leftJoinLateral(owner, eq(owner.observationId, observation.id))
    .where(and(isCurrentPlatformCaptureRow(db), or(and(inIds(observation.collectionId, selected.map(row => row.collectionId)),
      or(recognizedScope, eq(owner.enterpriseId, id))), inIds(collection.publicId, evidenceIds))))
    .orderBy(observation.id)
  const recognizedCollections = new Set(recognized)
  const pointers = selectedPointers.map(row => ({
    id: row.id, queryId: row.queryId, displayed: recognizedCollections.has(row.collectionId) || row.owner === id,
  }))
  const displayOwners: PostgresDisplayOwner<SourceQuery>[] = selected.map(({ collectionId, provenanceState, query }) => ({
    collectionId: String(collectionId), provenanceState, query,
  }))
  const displays = await readPostgresDisplayRows(db, displayOwners, pointers.filter(row => row.displayed).map(row => row.id))
  const byQuery = new Map(displays.map(row=>[row.query.id,row]))
  const queries: PlatformStoredQuery[] = [...new Map([...selected,...explain].map(row=>[row.query.id,row])).values()].map(row=>({
    ...row.query,rawResponse:null,collectionEvidence:byQuery.get(row.query.id)?.query.collectionEvidence ?? null,lastCollectedAt:row.lastCollectedAt,
  }))
  const platformPositionsById: NonNullable<RosterDetailArchive['platformPositionsById']> = new Map()
  const relations: PlatformStoredRelation[] = []
  for (const display of displays) {
    for (const item of display.relations) {
      const { sourceRdjb,sourcePage,...relation } = item.relation as unknown as PlatformStoredRelation & {
        sourceRdjb?: string | null; sourcePage?: number | null
      }
      platformPositionsById.set(relation.id,{ sourceRdjb,sourcePage })
      relations.push(relation)
    }
  }
  return { archive:selectRosterDetailArchive(enterprise,{ queries,relations,platformPositionsById }),queries,pointers,platformPositionsById }
}

async function readExportMembership(db: Reader, enterprise: Enterprise) {
  const uscc = normalizeUscc(enterprise.usccNorm)
  const identities = await db.select({ id: enterpriseTable.id, uscc: enterpriseTable.usccNorm, name: enterpriseTable.nameNorm })
    .from(enterpriseTable).where(notExists(db.select({ id: enterpriseMerge.fromEnterpriseId }).from(enterpriseMerge)
      .where(eq(enterpriseMerge.fromEnterpriseId, enterpriseTable.id)))).orderBy(enterpriseTable.id)
  const codes = new Map(identities.flatMap(row=>row.uscc ? [[normalizeUscc(row.uscc),row.id] as const] : []))
  const names = new Map(identities.map(row=>[row.name,row.id]))
  const candidates = await db.select({ id: exportRow.id, batchId: exportRow.batchId, usccRaw: exportRow.usccRaw,
    nameRaw: exportRow.nameRaw }).from(exportRow)
  const exportRows = candidates.filter(row => {
    const code = normalizeUscc(row.usccRaw)
    return (codes.get(code) ?? (row.nameRaw ? names.get(normalizeName(row.nameRaw)) : undefined)) === enterprise.id
      && (code === uscc || normalizeName(row.nameRaw) === enterprise.nameNorm)
  }) as typeof exportRow.$inferSelect[]
  const newer = alias(exportBatch, 'newer')
  const exportBatches = await db.select().from(exportBatch).where(or(inIds(exportBatch.id, exportRows.map(row => row.batchId)),
    notExists(db.select({ id: newer.id }).from(newer).where(and(eq(newer.titleCode, exportBatch.titleCode),
      or(gt(newer.year, exportBatch.year), and(eq(newer.year, exportBatch.year), gt(newer.id, exportBatch.id))))))))
    .orderBy(exportBatch.id) as typeof exportBatch.$inferSelect[]
  return { exportRows,exportBatches }
}

export function readPostgresRosterEnterpriseDetail(db: NodePgDatabase, requestedId: number, asOf = Date.now()): Promise<RosterEnterpriseDetail | null> {
  if (!Number.isSafeInteger(requestedId)) return Promise.resolve(null)
  return db.transaction(async tx => {
    let evidence: (typeof recordEvidence.$inferSelect)[] = []
    const qualification = await readPostgresRosterDetailQualification(tx,requestedId,asOf,async owner=>{
      const rows = await tx.select({ evidence: recordEvidence }).from(recordEvidence)
        .innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
        .innerJoin(record, eq(record.id, recordEvent.recordId)).where(eq(record.enterpriseId, owner))
        .orderBy(recordEvidence.id).then(rows => rows.map(row => row.evidence))
      evidence = rows.map(row=>isPageCapable(row.sourceFile) ? row : { ...row,page:null })
      return evidence.map(row=>({ evidenceId:row.id,eventId:row.recordEventId }))
    })
    if (!qualification) return null
    const { snapshot: qualificationAssessment,publishedPresentation,platformFacts,coverage } = qualification
    const id = qualificationAssessment.enterpriseId
    const subjectRows = await tx.select().from(enterpriseTable).where(eq(enterpriseTable.id, id))
    const enterprises: Enterprise[] = subjectRows.map(row => ({
      ...row, qualityFlags: row.qualityFlags === null ? null : JSON.parse(row.qualityFlags),
    }))
    const enterprise = enterprises[0]!
    const records = (await tx.select().from(record).where(eq(record.enterpriseId, id)).orderBy(record.id)).map(row => ({
      ...row, qualityFlags: row.qualityFlags === null ? null : JSON.parse(row.qualityFlags),
    }))
    const events = (await tx.select().from(recordEvent).where(inIds(recordEvent.recordId, records.map(row => row.id)))
      .orderBy(recordEvent.id)).map(row => ({
      ...row, formalValidity: row.formalValidity === null ? null : JSON.parse(row.formalValidity),
    }))
    const aliases = await tx.select().from(enterpriseAlias).where(eq(enterpriseAlias.enterpriseId, id)).orderBy(enterpriseAlias.id)
    const membership = records.length && !records.some(row=>row.source === 'jxj')
      ? await readExportMembership(tx,enterprise) : { exportRows:[],exportBatches:[] }
    const history = { enterprises,records,aliases,evidence,...membership,
      recordsByEnterprise:Map.groupBy(records,row=>row.enterpriseId),eventsByRecord:Map.groupBy(events,row=>row.recordId) }
    const decision = alias(differenceReason, 'p')
    const differences = (await tx.select({ row: sql<Difference>`${postgresDifferenceRow()}` }).from(decision)
      .where(eq(decision.enterpriseId, id)).orderBy(decision.id)).map(row => row.row)
    const otherRecord = alias(record, 'other_record')
    const otherOwner = alias(enterpriseTable, 'other_owner')
    const counterparty = tx.select({ id: otherRecord.id }).from(otherRecord)
      .innerJoin(otherOwner, eq(otherOwner.id, otherRecord.enterpriseId))
      .where(and(eq(otherOwner.usccNorm, enterpriseTable.usccNorm), eq(otherRecord.titleCode, record.titleCode),
        ne(otherRecord.source, record.source)))
    const coordinatesFromRecords = await tx.selectDistinct({ enterpriseId: record.enterpriseId, titleCode: record.titleCode,
      source: record.source }).from(record).innerJoin(enterpriseTable, eq(enterpriseTable.id, record.enterpriseId))
      .where(and(eq(record.enterpriseId, id), inArray(record.titleCode, TITLE_ORDER),
        or(isNull(enterpriseTable.usccNorm), notExists(counterparty))))
    const derived: Coordinate[] = coordinatesFromRecords.map(({ source, ...row }) => ({
      ...row, direction: source === 'jxj' ? 'missing_in_miit' : 'extra_in_miit',
    }))
    const evidenceQueryIds = [...new Set(differences.flatMap(row=>row.evidenceQueryId === null ? [] : [row.evidenceQueryId]))]
    const { archive,queries,pointers,platformPositionsById } = await readSources(tx,enterprise,evidenceQueryIds)
    const coordinates = projectEnterpriseDifferenceUniverse({ ...history,differences,queries,relations:pointers },derived)
    const detailed = projectDifferences(coordinates,qualificationAssessment.titles.map(assessment=>({ enterpriseId:id,assessment })),platformFacts,asOf)
    const scopes = TITLE_ORDER.flatMap(titleCode=>(['missing_in_miit','extra_in_miit'] as const).map(direction=>({ enterpriseId:id,titleCode,direction })))
    const assessments = await readPostgresQueryAssessments(tx,scopes,coverage)
    const titleAssessments = scopes.map((scope,index)=>({ ...scope,...assessments[index]! }))
    const byCoordinate = new Map(titleAssessments.map(assessment=>[assessment.titleCode+':'+assessment.direction,assessment]))
    const typed = await readPostgresPlatformDetailFacts(tx,archive.queries,archive.relations)
    return {
      qualificationAssessment,publishedPresentation,
      businessTimeline:projectRosterDetailTimeline(id,history,platformFacts,archive.queries,qualificationAssessment.asOf),
      ...projectRosterDetailHistory(history,id,detailed),
      differences:detailed.sort((a,b)=>TITLE_ORDER.indexOf(a.titleCode)-TITLE_ORDER.indexOf(b.titleCode) || a.direction.localeCompare(b.direction))
        .map(row=>({ ...row,...byCoordinate.get(row.titleCode+':'+row.direction)! })),
      titleAssessments,
      platform:{
        queries:archive.queries,relations:projectRosterDetailRelations(archive,typed),
        businessRecords:await readPostgresPlatformBusinessDetails(tx,id,archive.queries,archive.relations,platformPositionsById,typed),
      },
    }
  }, { isolationLevel:'repeatable read',accessMode:'read only' })
}
