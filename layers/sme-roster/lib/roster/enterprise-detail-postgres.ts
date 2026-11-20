import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { normalizeName, normalizeUscc } from '../domain'
import type { PlatformStoredQuery, PlatformStoredRelation } from '../platform/read'
import { readPostgresDisplayRows, type PostgresDisplayOwner } from '../platform/postgres-query-display'
import { TITLE_ORDER } from '../labels'
import { postgresDifferenceRow } from '../../server/utils/decision-lifecycle-102/postgres-reads'
import { readPostgresPlatformDetailFacts, readPostgresPlatformBusinessDetails } from '../../server/utils/platform-business-detail-read'
import { projectDifferences } from './current-difference'
import { readPostgresRosterDetailQualification } from './current-qualification-postgres'
import { isPageCapable } from './evidence-page'
import { qualificationUsccCandidate } from './platform-qualification-postgres'
import { postgresRosterRow, readPostgresRosterRowsById } from './postgres-rows'
import { readPostgresQueryAssessments } from './query-assessment-postgres'
import { projectEnterpriseDifferenceUniverse, projectRosterDetailHistory, projectRosterDetailRelations,
  projectRosterDetailTimeline, selectRosterDetailArchive, type RosterDetailArchive, type RosterEnterpriseDetail } from './enterprise-roster'

type Reader = Pick<NodePgDatabase,'execute'>
type Enterprise = typeof schema.enterprise.$inferSelect
type Difference = Parameters<typeof projectEnterpriseDifferenceUniverse>[0]['differences'][number]
type Coordinate = Parameters<typeof projectEnterpriseDifferenceUniverse>[1][number]
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

async function readSources(db: Reader, enterprise: Enterprise, evidenceIds: number[]) {
  const id = enterprise.id
  const nameKey = 'name:' + enterprise.nameNorm
  const uscc = normalizeUscc(enterprise.usccNorm)
  const { rows } = await db.execute<PostgresDisplayOwner & { owned:boolean; lastCollectedAt:string | null;
    query: Pick<PlatformStoredQuery, 'status' | 'interface'> }>(sql`
    WITH owned AS (
      SELECT DISTINCT o.collection_id FROM platform_observation_assignment a
      JOIN platform_business_observation o ON o.id=a.observation_id
      WHERE a.enterprise_id=${id} AND NOT EXISTS (
        SELECT 1 FROM platform_observation_assignment n WHERE n.observation_id=a.observation_id AND n.revision>a.revision)
    )
    SELECT c.id AS "collectionId",c.provenance_state AS "provenanceState",c.last_collected_at AS "lastCollectedAt",o.collection_id IS NOT NULL AS owned,
      json_build_object('id',q.old_id,'interface',c.interface,'queryKey',c.query_key,'rdjb',c.rdjb,'titleCode',c.title_code,
        'queriedAt',c.queried_at,'status',c.status,'failureReason',c.failure_reason,'createdAt',c.created_at,'relationCount',0) AS query
    FROM platform_collection c JOIN platform_legacy_query_alias q ON q.collection_id=c.id LEFT JOIN owned o ON o.collection_id=c.id
    WHERE o.collection_id IS NOT NULL OR c.query_key=${nameKey} OR q.old_id=ANY(${ids(evidenceIds)})
      ${uscc ? sql`OR ${qualificationUsccCandidate(sql`c.query_key`,[uscc])}` : sql.empty()}
    ORDER BY q.old_id`)
  const selected = rows.filter(row=>row.owned || row.query.queryKey === nameKey || !!uscc && normalizeUscc(row.query.queryKey) === uscc)
  const recognized = selected.filter(row=>row.query.interface === 'recognized_list').map(row=>row.collectionId)
  const explain = rows.filter(row=>evidenceIds.includes(row.query.id))
  const { rows: pointers } = await db.execute<{ id:number; queryId:number; displayed:boolean }>(sql`
    SELECT a.old_id::float8 AS id,q.old_id::float8 AS "queryId",
      (o.collection_id=ANY(${sql.param(recognized)}::bigint[]) OR coalesce(owner.enterprise_id=${id},false)) AS displayed
    FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id
    JOIN platform_legacy_query_alias q ON q.collection_id=o.collection_id
    LEFT JOIN LATERAL (SELECT enterprise_id FROM platform_observation_assignment a
      WHERE a.observation_id=o.id ORDER BY revision DESC LIMIT 1) owner ON true
    WHERE (o.collection_id=ANY(${sql.param(selected.map(row=>row.collectionId))}::bigint[])
      AND (o.collection_id=ANY(${sql.param(recognized)}::bigint[]) OR owner.enterprise_id=${id}))
      OR q.old_id=ANY(${ids(evidenceIds)})
    ORDER BY o.id`)
  const displays = await readPostgresDisplayRows(db,selected,false,pointers.filter(row=>row.displayed).map(row=>row.id))
  const byQuery = new Map(displays.map(row=>[row.query.id,row]))
  const queries: PlatformStoredQuery[] = [...new Map([...selected,...explain].map(row=>[row.query.id,row])).values()].map(row=>({
    ...row.query,rawResponse:null,collectionEvidence:byQuery.get(row.query.id)?.query.collectionEvidence ?? null,lastCollectedAt:row.lastCollectedAt,
  }))
  const platformLegacyById = new Map(displays.flatMap(row=>row.query.legacyProvenance ? [[row.query.id,row.query.legacyProvenance] as const] : []))
  const platformPositionsById: NonNullable<RosterDetailArchive['platformPositionsById']> = new Map()
  const relations: PlatformStoredRelation[] = []
  for (const display of displays) {
    for (const item of display.relations) {
      const { sourceRdjb,sourcePage,...relation } = item.relation as unknown as PlatformStoredRelation & {
        sourceRdjb?:string | null; sourcePage?:number | null
      }
      platformPositionsById.set(relation.id,{ sourceRdjb,sourcePage })
      relations.push(relation)
    }
  }
  return { archive:selectRosterDetailArchive(enterprise,{ queries,relations,platformLegacyById,platformPositionsById }),queries,pointers,platformPositionsById }
}

async function readExportMembership(db: Reader, enterprise: Enterprise) {
  const uscc = normalizeUscc(enterprise.usccNorm)
  const { rows: identities } = await db.execute<{ id: number; uscc:string | null; name:string }>(sql`
    SELECT e.id::float8 AS id,e.uscc_norm AS uscc,e.name_norm AS name FROM enterprise e
    WHERE NOT EXISTS(SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=e.id) ORDER BY e.id`)
  const codes = new Map(identities.flatMap(row=>row.uscc ? [[normalizeUscc(row.uscc),row.id] as const] : []))
  const names = new Map(identities.map(row=>[row.name,row.id]))
  const candidates = (await db.execute<{ row:typeof schema.platformExportRow.$inferSelect }>(sql`
    SELECT json_build_object('id',id,'batchId',batch_id,'usccRaw',uscc_raw,'nameRaw',name_raw) AS row FROM platform_export_row`)).rows
  const exportRows = candidates.map(row=>row.row).filter(row=>{
    const code = normalizeUscc(row.usccRaw)
    return (codes.get(code) ?? (row.nameRaw ? names.get(normalizeName(row.nameRaw)) : undefined)) === enterprise.id
      && (code === uscc || normalizeName(row.nameRaw) === enterprise.nameNorm)
  })
  const exportBatches = await readPostgresRosterRowsById(db,schema.platformExportBatch,sql`FROM platform_export_batch p
    WHERE p.id=ANY(${ids(exportRows.map(row=>row.batchId))}) OR NOT EXISTS (
      SELECT 1 FROM platform_export_batch newer WHERE newer.title_code=p.title_code AND (newer.year,newer.id)>(p.year,p.id))`)
  return { exportRows,exportBatches }
}

export function readPostgresRosterEnterpriseDetail(db: NodePgDatabase, requestedId: number, asOf = Date.now()): Promise<RosterEnterpriseDetail | null> {
  if (!Number.isSafeInteger(requestedId)) return Promise.resolve(null)
  return db.transaction(async tx => {
    let evidence: (typeof schema.recordEvidence.$inferSelect)[] = []
    const qualification = await readPostgresRosterDetailQualification(tx,requestedId,asOf,async owner=>{
      const rows = await readPostgresRosterRowsById(tx,schema.recordEvidence,sql`FROM record_evidence p
        JOIN record_event v ON v.id=p.record_event_id JOIN record r ON r.id=v.record_id WHERE r.enterprise_id=${owner}`)
      evidence = rows.map(row=>isPageCapable(row.sourceFile) ? row : { ...row,page:null })
      return evidence.map(row=>({ evidenceId:row.id,eventId:row.recordEventId }))
    })
    if (!qualification) return null
    const { snapshot: qualificationAssessment,publishedPresentation,platformFacts,coverage } = qualification
    const id = qualificationAssessment.enterpriseId
    const enterprises = await readPostgresRosterRowsById(tx,schema.enterprise,sql`FROM enterprise p WHERE id=${id}`)
    const enterprise = enterprises[0]!
    const records = await readPostgresRosterRowsById(tx,schema.record,sql`FROM record p WHERE enterprise_id=${id}`)
    const events = await readPostgresRosterRowsById(tx,schema.recordEvent,sql`FROM record_event p WHERE record_id=ANY(${ids(records.map(row=>row.id))})`)
    const aliases = await readPostgresRosterRowsById(tx,schema.enterpriseAlias,sql`FROM enterprise_alias p WHERE enterprise_id=${id}`)
    const membership = records.length && !records.some(row=>row.source === 'jxj')
      ? await readExportMembership(tx,enterprise) : { exportRows:[],exportBatches:[] }
    const history = { enterprises,records,aliases,evidence,...membership,
      recordsByEnterprise:Map.groupBy(records,row=>row.enterpriseId),eventsByRecord:Map.groupBy(events,row=>row.recordId) }
    const differences = (await tx.execute<{ row:Difference }>(sql`SELECT ${postgresDifferenceRow()} AS row
      FROM difference_reason p WHERE enterprise_id=${id} ORDER BY id`)).rows.map(row=>row.row)
    const derived = (await tx.execute<Coordinate>(sql`
      SELECT DISTINCT r.enterprise_id::float8 AS "enterpriseId",r.title_code AS "titleCode",
        CASE WHEN r.source='jxj' THEN 'missing_in_miit' ELSE 'extra_in_miit' END AS direction
      FROM record r JOIN enterprise e ON e.id=r.enterprise_id
      WHERE r.enterprise_id=${id} AND r.title_code=ANY(${sql.param(TITLE_ORDER)}::text[])
        AND (e.uscc_norm IS NULL OR NOT EXISTS (
          SELECT 1 FROM record other JOIN enterprise oe ON oe.id=other.enterprise_id
          WHERE oe.uscc_norm=e.uscc_norm AND other.title_code=r.title_code AND (other.source='jxj')<>(r.source='jxj')))`)).rows
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
