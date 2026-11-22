import { and, between, desc, eq, exists, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvent } from '../../../../db/postgresql/ledger-tables'
import {
  platformApplyProjection, platformBusinessObservation, platformBusinessProjection, platformCollection, platformCollectionPage,
  platformExportBatch, platformExportRow, platformLegacyQueryAlias, platformLegacyRelationAlias,
  platformObservationAssignment, platformRecognizedProjection,
} from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import { platformArchiveValue, platformCollectionArchiveRef } from '../../../../db/postgresql/platform-archive-tables'
import { title } from '../../../../db/postgresql/title-table'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { type EventArchiveInput } from './event-archive-discovery'
import { EVENT_ARCHIVE_RULE_VERSION, normalizedUscc } from './event-archive-discovery-model'
import { readPostgresCorrespondenceSources } from './record-correspondence-postgres'
import { safeCollectionEvidence } from './evidence-redaction'
import type { ReceiptRedactor } from './import-receipt-redaction'
import { readPostgresPlatformBusinessGroups } from './platform-business-record-postgres'
import { projectCandidateRows, type CandidateInput } from './record-correspondence-candidate-projection'
import { readPostgresObservationComparisonFacts } from './record-correspondence-target-postgres'

type Reader = Pick<NodePgDatabase, 'execute' | 'select'>
type Sources = Parameters<typeof projectCandidateRows>[1]
type Selection = { relationIds: number[]; total: number }
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`
const offset = (page: number, size: number) => Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * size)

const sourceRows = sql`
  FROM platform_legacy_query_alias q JOIN platform_collection c ON c.id=q.collection_id
  JOIN platform_business_observation o ON o.collection_id=c.id JOIN platform_legacy_relation_alias ra ON ra.observation_id=o.id
  JOIN platform_observation_assignment original ON original.observation_id=o.id AND original.revision=1
  JOIN LATERAL (SELECT enterprise_id,match_basis,verification_status FROM platform_observation_assignment
    WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1) a ON true
  LEFT JOIN platform_apply_projection ap ON ap.observation_id=o.id
  LEFT JOIN platform_business_projection bp ON bp.observation_id=o.id`
const rawTitle = sql`CASE coalesce(ap.source_title_kind,bp.source_title_kind)
  WHEN 'text' THEN coalesce(ap.source_title_text,bp.source_title_text)
  WHEN 'number' THEN coalesce(ap.source_title_number_text,bp.source_title_number_text) END`
const sourceTitle = (value: ReturnType<typeof sql>) => sql`CASE ${value}
  WHEN '1' THEN 'innovative_sme' WHEN '2' THEN 'specialized_sme' WHEN '3' THEN 'little_giant' END`
const recognizedTitle = sql`coalesce((SELECT ${sourceTitle(sql`p.rdjb`)} FROM platform_collection_page p
  WHERE p.collection_id=c.id AND p.status='success' AND p.sequence_end>=o.sequence_no ORDER BY p.ordinal LIMIT 1),c.title_code)`
const genericTitle = sql`CASE WHEN c.interface='recognized_list' THEN ${recognizedTitle}
  ELSE coalesce(c.title_code, CASE WHEN trim(both ',' from c.rdjb) IN ('1','2','3') THEN ${sourceTitle(sql`trim(both ',' from c.rdjb)`)}
  WHEN replace(c.rdjb,',','')='' OR ${rawTitle}=ANY(string_to_array(c.rdjb,',')) THEN ${sourceTitle(rawTitle)} END) END`

async function pageCandidateGroups(db: Reader, input: CandidateInput, enterpriseId: number, identity: string, titleCode: string) {
  // PostgreSQL MATERIALIZED freezes eligible archive rows before grouping and
  // pagination. The CTE hint is outside Drizzle's query builder.
  const { rows: [result] } = await db.execute<{ total: number; ids: number[] }>(sql`
    WITH eligible AS MATERIALIZED (
      SELECT ra.old_id AS id,row_number() OVER (ORDER BY q.old_id,o.sequence_no,ra.old_id) AS ordinal,
        CASE WHEN o.identity_state='resolved' AND o.content_state='verified' AND o.record_id IS NOT NULL AND o.version_id IS NOT NULL
          THEN 'version:' || o.record_id || ':' || o.version_id ELSE 'observation:' || o.id END AS key
      ${sourceRows} WHERE q.old_id=ANY(${ids(input.queryIds)}) AND c.status IN ('success','partial')
        AND (a.enterprise_id IS NULL OR a.enterprise_id=${enterpriseId}) AND ${identity ? sql`${normalizedUscc(sql`original.uscc_raw`)}=${identity}` : sql`false`}
        AND ${genericTitle}=${titleCode} ${input.eventId === undefined ? sql`AND c.interface<>'recognized_list'` : sql.empty()}
    ), groups AS (SELECT key,min(ordinal) AS first FROM eligible GROUP BY key),
    page AS (SELECT key FROM groups ORDER BY first LIMIT ${input.pageSize} OFFSET ${offset(input.page,input.pageSize)})
    SELECT (SELECT count(*) FROM groups)::float8 AS total,
      (SELECT coalesce(json_agg(e.id ORDER BY e.ordinal),'[]'::json) FROM eligible e JOIN page USING(key)) AS ids`)
  return result!
}

async function readPostgresCandidateQueries(db: Reader, queryIds: readonly number[]): Promise<Sources['queries']> {
  const q = platformLegacyQueryAlias, c = platformCollection
  const archiveRef = platformCollectionArchiveRef, archive = platformArchiveValue
  const jsonObject = sql`convert_from(${archive.bytes},'UTF8')::json`
  const fields = db.select({ value: sql`coalesce(json_object_agg(f.key,f.value ORDER BY f.ordinal),'{}'::json)` })
    .from(sql`json_each(${jsonObject}) WITH ORDINALITY f(key,value,ordinal)`)
    .where(ne(sql<string>`f.key`, 'rows'))
  const evidence = db.select({
    value: sql`CASE WHEN json_typeof(${jsonObject})='object' THEN (${fields}) END`,
  }).from(archiveRef).innerJoin(archive, eq(archive.id, archiveRef.archiveId))
    .where(and(eq(archiveRef.ownerId, c.id), eq(archiveRef.field, 'collectionEvidence')))
  const rows = await db.select({
    id: q.oldId, interface: c.interface, queryKey: c.queryKey, rdjb: c.rdjb, titleCode: c.titleCode, queriedAt: c.queriedAt,
    lastCollectedAt: c.lastCollectedAt, status: c.status, failureReason: c.failureReason, createdAt: c.createdAt,
    collectionEvidence: sql<Sources['queries'][number]['collectionEvidence']>`(${evidence})`,
  }).from(q).innerJoin(c, eq(c.id, q.collectionId)).where(eq(q.oldId, sql`ANY(${ids(queryIds)})`)).orderBy(q.oldId)
  return rows as Sources['queries']
}

async function factsForCandidates(db: Reader, relations: (Sources['relevantRelations'][number] & { observationId: number; interface: Sources['queries'][number]['interface'] })[]) {
  const result = new Map<number, Sources['factsByRelation'] extends ReadonlyMap<number,infer V> ? V : never>()
  const normalized = await readPostgresObservationComparisonFacts(db, relations)
  const tables = { apply_list: platformApplyProjection, business_list: platformBusinessProjection, recognized_list: platformRecognizedProjection }
  for (const [source, group] of Map.groupBy(relations, row => row.interface)) {
    const process = source !== 'recognized_list'
    const o = platformBusinessObservation, p = alias(tables[source], 'observed'), v = alias(tables[source], 'version')
    const rows = await db.select({
      id: o.id, typed: isNotNull(v.versionId).mapWith(Boolean), usccRaw: v.usccRaw,
      titleRaw: 'sqlFactTitle' in p ? p.sqlFactTitle : v.titleRaw,
      declareKind: 'declareKind' in v ? v.declareKind : sql<null>`NULL`,
      year: 'declarationYear' in v ? v.declarationYear : 'businessYear' in v ? v.businessYear : sql<null>`NULL`,
      status: 'status' in v ? v.status : sql<null>`NULL`,
      appliedAt: 'appliedAt' in v ? v.appliedAt : sql<null>`NULL`,
      batch: 'businessYear' in v ? v.batch : sql<null>`NULL`,
      awardBatchLabel: 'businessYear' in v ? v.awardBatchLabel : sql<null>`NULL`,
    }).from(o).innerJoin(p, eq(p.observationId, o.id))
      .leftJoin(v, and(eq(v.versionId, o.versionId), eq(v.recordId, o.recordId)))
      .where(eq(o.id, sql`ANY(${ids(group.map(row => row.observationId))})`))
    const typed = new Map(rows.map(row => [row.id,row]))
    for (const relation of group) {
      const base = normalized.get(relation.observationId), fact = typed.get(relation.observationId)
      if (!base || !fact) continue
      const recognizedTitle = typeof base.rawFields?.rdjb === 'string' && base.rawFields.rdjb.trim() || null
      result.set(relation.id, { normalizationConflicts: base.normalizationConflicts,
        titleRaw: process ? fact.titleRaw : fact.titleRaw ?? recognizedTitle,
        usccRaw: fact.typed ? fact.usccRaw : relation.usccRaw,
        declareKind: process && fact.typed ? fact.declareKind : base.declareKind,
        year: process && fact.typed ? fact.year : base.year, status: process && fact.typed ? fact.status : base.status,
        appliedAt: process && fact.typed ? fact.appliedAt : base.appliedAt,
        batch: source === 'business_list' && fact.typed ? fact.batch : base.batch,
        awardBatchLabel: source === 'business_list' && fact.typed ? fact.awardBatchLabel : base.awardBatchLabel })
    }
  }
  return result
}

export async function generatePostgresCandidates(db: Reader, input: CandidateInput, selection?: Selection) {
  const e = alias(recordEvent, 'e'), r = alias(record, 'r')
  type Event = NonNullable<Sources['event']>
  const event = input.eventId ? (await db.select({
    event: sql<Event['event']>`${postgresRosterRow(recordEvent,'e')}`,
    record: sql<Event['record']>`${postgresRosterRow(record,'r')}`,
  }).from(e).innerJoin(r, eq(r.id, e.recordId)).where(and(eq(e.id, input.eventId), eq(r.source, 'jxj'))))[0] : null
  if (input.eventId && !event) return null
  const enterpriseId = event?.record.enterpriseId ?? input.enterpriseId!, titleCode = event?.record.titleCode ?? input.titleCode!
  const owner = alias(enterprise, 'p')
  const [ownerRow] = await db.select({ row: sql<typeof schema.enterprise.$inferSelect>`${postgresRosterRow(enterprise,'p')}` })
    .from(owner).where(and(eq(owner.id, enterpriseId), exists(db.select({ code: title.code }).from(title).where(eq(title.code, titleCode)))))
  if (!ownerRow) return null
  const identity = normalizeUscc(event?.record.usccRaw ?? ownerRow.row.usccNorm)
  const queries = await readPostgresCandidateQueries(db,input.queryIds)
  const b = alias(platformExportBatch, 'p')
  const batches = (await db.select({
    row: sql<typeof schema.platformExportBatch.$inferSelect>`${postgresRosterRow(platformExportBatch,'p')}`,
  }).from(b).where(eq(b.id, sql`ANY(${ids(input.exportBatchIds)})`)).orderBy(b.id)).map(({ row }) => row)
  if (queries.length !== new Set(input.queryIds).size || batches.length !== new Set(input.exportBatchIds).size) return null
  const targetPage = selection ? null : await pageCandidateGroups(db,input,enterpriseId,identity,titleCode)
  const q = platformLegacyQueryAlias, c = platformCollection, o = platformBusinessObservation, ra = platformLegacyRelationAlias
  const original = alias(platformObservationAssignment, 'original'), a = platformObservationAssignment
  const ap = alias(platformApplyProjection, 'ap'), bp = alias(platformBusinessProjection, 'bp'), page = platformCollectionPage
  const assignment = db.select({ enterpriseId: a.enterpriseId, matchBasis: a.matchBasis, verificationStatus: a.verificationStatus })
    .from(a).where(eq(a.observationId, o.id)).orderBy(desc(a.revision)).limit(1).as('assignment')
  const coverage = db.select({ rdjb: page.rdjb, pageNo: page.pageNo }).from(page).where(and(
    eq(page.collectionId, c.id), eq(page.status, 'success'), between(o.sequenceNo, page.sequenceStart, page.sequenceEnd),
  )).orderBy(page.ordinal).limit(1).as('cover')
  type Relevant = Sources['relevantRelations'][number] & {
    observationId: number; interface: Sources['queries'][number]['interface']; sourceRdjb: string | null; sourcePage: number | null
  }
  const relations = await db.select({
    id: ra.oldId, queryId: q.oldId, collectionId: c.id, sequenceNo: o.sequenceNo, relationKey: o.sourceRelationKey,
    enterpriseId: assignment.enterpriseId, usccRaw: original.usccRaw, nameRaw: original.nameRaw,
    matchBasis: assignment.matchBasis, verificationStatus: assignment.verificationStatus, rowTitleRaw: sql<string | null>`${rawTitle}`,
    observationId: o.id, interface: c.interface, sourceRdjb: coverage.rdjb, sourcePage: coverage.pageNo,
  }).from(q).innerJoin(c, eq(c.id, q.collectionId)).innerJoin(o, eq(o.collectionId, c.id))
    .innerJoin(ra, eq(ra.observationId, o.id)).innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .innerJoinLateral(assignment, sql`true`).leftJoin(ap, eq(ap.observationId, o.id)).leftJoin(bp, eq(bp.observationId, o.id))
    .leftJoinLateral(coverage, sql`true`).where(and(eq(ra.oldId, sql`ANY(${ids(selection?.relationIds ?? targetPage!.ids)})`),
      inArray(c.status, ['success', 'partial']))).orderBy(q.oldId, o.sequenceNo, ra.oldId) as Relevant[]
  const relevantRelations = relations.filter(r => (!r.enterpriseId || r.enterpriseId === enterpriseId) &&
    ((identity && normalizeUscc(r.usccRaw) === identity) || (selection && !normalizeUscc(r.usccRaw) && r.enterpriseId === enterpriseId && r.verificationStatus === 'confirmed')))
  const factsByRelation = await factsForCandidates(db,relevantRelations)
  const positions = new Map(relevantRelations.map(row => [row.id,{ sourceRdjb: row.sourceRdjb,sourcePage: row.sourcePage }]))
  const exportBatches = event && identity ? batches.filter(b => b.importStatus === 'imported' && b.titleCode === titleCode).map(b => b.id) : []
  const exported = platformExportRow, edge = recordCorrespondence
  const exports = await db.select({ id: exported.id, batchId: exported.batchId, sourceRowNo: exported.sourceRowNo, usccRaw: exported.usccRaw })
    .from(exported).where(eq(exported.batchId, sql`ANY(${ids(exportBatches)})`)).orderBy(exported.batchId, exported.sourceRowNo)
  const relevantExports = exports.filter(row => identity && normalizeUscc(row.usccRaw) === identity)
  const priors = await db.select({ id: edge.id, eventId: edge.eventId, type: edge.type, exportRowId: edge.exportRowId, revision: edge.revision })
    .from(edge).where(eq(edge.exportRowId, sql`ANY(${ids(relevantExports.map(row => row.id))})`)).orderBy(edge.id)
  const steps = projectCandidateRows(input,{ event,enterprise: ownerRow.row,queries,batches,relevantRelations,relevantExports,factsByRelation,positions,priors,targetPage,selection })
  const pending = steps.next()
  if (pending.done) return pending.value
  const final = steps.next(await readPostgresPlatformBusinessGroups(db,pending.value))
  if (final.done) return final.value
  throw new Error('Candidate projection did not finish')
}

export async function discoverPostgresEventArchives(db: NodePgDatabase, input: EventArchiveInput, redact: ReceiptRedactor) {
  const [owner] = await db.select({
    id: enterprise.id, title: record.titleCode, name: enterprise.nameNorm,
    uscc: sql<string | null>`coalesce(${record.usccRaw},${enterprise.usccNorm})`,
  }).from(recordEvent).innerJoin(record, eq(record.id, recordEvent.recordId)).innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    .where(and(eq(recordEvent.id, input.eventId), eq(record.source, 'jxj'), inArray(recordEvent.eventType, ['award','review'])))
  if (!owner) return null
  const identity = normalizeUscc(owner.uscc)
  const rowKey = normalizedUscc(sql`original.uscc_raw`)
  const scope = sql`
    WITH matched AS MATERIALIZED (
      SELECT q.old_id AS query_id,ra.old_id AS id,o.sequence_no,c.interface,c.status,
        CASE WHEN c.interface='recognized_list' THEN ${recognizedTitle} ELSE coalesce(c.title_code,${sourceTitle(sql`c.rdjb`)}) END AS row_title
      ${sourceRows}
      WHERE (a.enterprise_id IS NULL OR a.enterprise_id=${owner.id}) AND (
        (${Boolean(identity)} AND ${rowKey}=${identity}) OR
        (a.enterprise_id=${owner.id} AND a.verification_status='confirmed' AND ${rowKey}=''))
    ), related AS MATERIALIZED (
      SELECT q.old_id AS id,c.id AS collection_id,c.interface,c.status FROM platform_legacy_query_alias q
      JOIN platform_collection c ON c.id=q.collection_id
      WHERE c.query_key=ANY(${sql.param([...(identity ? [identity] : []),`name:${owner.name}`])}::text[])
        OR c.query_key IN (SELECT 'name:' || name_norm FROM enterprise_alias WHERE enterprise_id=${owner.id} AND verification_status='confirmed')
        OR q.old_id IN (SELECT query_id FROM matched)
    ), eligible AS MATERIALIZED (
      SELECT id,query_id,sequence_no FROM matched WHERE status IN ('success','partial') AND row_title=${owner.title}
    )`
  type Cover = { id: number; relationCount: number; candidateCount: number }
  const { rows: [page] } = await db.execute<{ total: number; queryTotal: number; selection: { id: number; queryId: number }[];
    coverage: Cover[]; states: { interface: Sources['queries'][number]['interface']; status: string; count: number }[] }>(sql`
    ${scope}, coverage AS (
      SELECT rel.id,(SELECT count(*) FROM platform_business_observation WHERE collection_id=rel.collection_id) AS "relationCount",
        (SELECT count(*) FROM eligible WHERE query_id=rel.id) AS "candidateCount"
      FROM (SELECT * FROM related ORDER BY id LIMIT ${input.queryPageSize} OFFSET ${offset(input.queryPage,input.queryPageSize)}) rel
    ) SELECT (SELECT count(*) FROM eligible)::float8 AS total,(SELECT count(*) FROM related)::float8 AS "queryTotal",
      (SELECT coalesce(json_agg(json_build_object('id',s.id,'queryId',s.query_id) ORDER BY s.query_id,s.sequence_no,s.id),'[]'::json)
        FROM (SELECT * FROM eligible ORDER BY query_id,sequence_no,id LIMIT ${input.pageSize} OFFSET ${offset(input.page,input.pageSize)}) s) AS selection,
      (SELECT coalesce(json_agg(coverage ORDER BY id),'[]'::json) FROM coverage) AS coverage,
      (SELECT coalesce(json_agg(states ORDER BY interface COLLATE "C",status COLLATE "C"),'[]'::json)
        FROM (SELECT interface,status,count(*) AS count FROM related GROUP BY interface,status) states) AS states`)
  const selected = page!
  const generated = await generatePostgresCandidates(db, { eventId: input.eventId,
    queryIds: [...new Set(selected.selection.map(r => r.queryId))], exportBatchIds: [], ruleVersion: EVENT_ARCHIVE_RULE_VERSION,
    page: 1,pageSize: input.pageSize }, { relationIds: selected.selection.map(r => r.id),total: selected.total })
  const details = await readPostgresCorrespondenceSources(db, [], redact, { kind: 'event',id: input.eventId })
  const event = details.event(input.eventId)
  const metadata = new Map((await readPostgresCandidateQueries(db,selected.coverage.map(r => r.id))).map(row => [row.id,row]))
  const coverage = selected.coverage.map(row => ({ ...metadata.get(row.id)!, ...row }))
  return { event, ruleVersion: EVENT_ARCHIVE_RULE_VERSION, rows: generated!.rows, total: selected.total, page: input.page,pageSize: input.pageSize,
    coverage: { rows: coverage.map(({ collectionEvidence,...row }) => ({ ...row,
      outcome: row.status !== 'success' ? row.status : row.candidateCount > 0 ? 'candidates' : row.relationCount > 0 ? 'no_candidate' : 'empty_unproven',
      collectionEvidence: safeCollectionEvidence(collectionEvidence) })),total: selected.queryTotal,page: input.queryPage,pageSize: input.queryPageSize },
    interfaces: (['business_list','apply_list','recognized_list'] as const).map(source => ({ interface: source,
      states: selected.states.filter(row => row.interface === source).map(({ status,count }) => ({ status,count })),
      queried: selected.states.some(row => row.interface === source && row.status !== 'not_queried') })) }
}
