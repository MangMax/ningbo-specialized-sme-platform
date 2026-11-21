import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { postgresRosterRow, readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { EVENT_ARCHIVE_RULE_VERSION, normalizedUscc, type EventArchiveInput } from './event-archive-discovery'
import { readPostgresCorrespondenceSources } from './record-correspondence-postgres'
import { safeCollectionEvidence } from './record-correspondence-read'
import type { ReceiptRedactor } from './import-receipt-redaction'
import { readPostgresPlatformBusinessGroups } from './platform-business-record-read'
import { projectCandidateRows, type CandidateInput } from './record-correspondence-candidates'
import { readPostgresObservationComparisonFacts } from './record-correspondence-target-postgres'

type Reader = Pick<NodePgDatabase, 'execute'>
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
  const { rows } = await db.execute<Sources['queries'][number]>(sql`
    SELECT q.old_id::float8 AS id,c.interface,c.query_key AS "queryKey",c.rdjb,c.title_code AS "titleCode",c.queried_at AS "queriedAt",
      c.last_collected_at AS "lastCollectedAt",c.status,c.failure_reason AS "failureReason",c.created_at AS "createdAt",
      (SELECT CASE WHEN json_typeof(archive.data)='object' THEN (
        SELECT coalesce(json_object_agg(f.key,f.value ORDER BY f.ordinal),'{}'::json)
        FROM json_each(archive.data) WITH ORDINALITY f(key,value,ordinal) WHERE f.key<>'rows'
      ) END FROM platform_collection_archive_ref r JOIN platform_archive_value v ON v.id=r.archive_id
        CROSS JOIN LATERAL (SELECT convert_from(v.bytes,'UTF8')::json AS data) archive
      WHERE r.owner_id=c.id AND r.field='collectionEvidence') AS "collectionEvidence"
    FROM platform_legacy_query_alias q JOIN platform_collection c ON c.id=q.collection_id
    WHERE q.old_id=ANY(${ids(queryIds)}) ORDER BY q.old_id`)
  return rows
}

async function factsForCandidates(db: Reader, relations: (Sources['relevantRelations'][number] & { observationId: number; interface: Sources['queries'][number]['interface'] })[]) {
  const result = new Map<number, Sources['factsByRelation'] extends ReadonlyMap<number,infer V> ? V : never>()
  const normalized = await readPostgresObservationComparisonFacts(db, relations)
  const tables = { apply_list: 'platform_apply_projection', business_list: 'platform_business_projection', recognized_list: 'platform_recognized_projection' }
  for (const [source, group] of Map.groupBy(relations, row => row.interface)) {
    const table = sql.identifier(tables[source])
    const process = source !== 'recognized_list'
    const { rows } = await db.execute<{ id: number; typed: boolean; titleRaw: string | null; usccRaw: string | null;
      declareKind: string | null; year: number | null; status: string | null; appliedAt: string | null; batch: string | null; awardBatchLabel: string | null }>(sql`
      SELECT o.id::float8 AS id,v.version_id IS NOT NULL AS typed,v.uscc_raw AS "usccRaw",
        ${process ? sql`p.sql_fact_title` : sql`v.title_raw`} AS "titleRaw",
        ${process ? sql`v.declare_kind AS "declareKind",v.status,v.applied_at AS "appliedAt",
          ${source === 'apply_list' ? sql`v.declaration_year` : sql`v.business_year`}::float8 AS year` : sql`NULL AS "declareKind",NULL AS status,NULL AS "appliedAt",NULL AS year`},
        ${source === 'business_list' ? sql`v.batch,v.award_batch_label AS "awardBatchLabel"` : sql`NULL AS batch,NULL AS "awardBatchLabel"`}
      FROM platform_business_observation o JOIN ${table} p ON p.observation_id=o.id
      LEFT JOIN ${table} v ON v.version_id=o.version_id AND v.record_id=o.record_id
      WHERE o.id=ANY(${ids(group.map(row => row.observationId))})`)
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
  const event = input.eventId ? (await db.execute<NonNullable<Sources['event']>>(sql`
    SELECT ${postgresRosterRow(schema.recordEvent,'e')} AS event,${postgresRosterRow(schema.record,'r')} AS record
    FROM record_event e JOIN record r ON r.id=e.record_id WHERE e.id=${input.eventId} AND r.source='jxj'`)).rows[0] : null
  if (input.eventId && !event) return null
  const enterpriseId = event?.record.enterpriseId ?? input.enterpriseId!, titleCode = event?.record.titleCode ?? input.titleCode!
  const [enterprise] = await readPostgresRosterRowsById(db,schema.enterprise,sql`
    FROM enterprise p WHERE p.id=${enterpriseId} AND EXISTS(SELECT 1 FROM title WHERE code=${titleCode})`)
  if (!enterprise) return null
  const identity = normalizeUscc(event?.record.usccRaw ?? enterprise.usccNorm)
  const queries = await readPostgresCandidateQueries(db,input.queryIds)
  const batches = await readPostgresRosterRowsById(db,schema.platformExportBatch,sql`FROM platform_export_batch p WHERE p.id=ANY(${ids(input.exportBatchIds)})`)
  if (queries.length !== new Set(input.queryIds).size || batches.length !== new Set(input.exportBatchIds).size) return null
  const targetPage = selection ? null : await pageCandidateGroups(db,input,enterpriseId,identity,titleCode)
  const { rows: relations } = await db.execute<Sources['relevantRelations'][number] & { observationId: number; interface: Sources['queries'][number]['interface']; sourceRdjb: string | null; sourcePage: number | null }>(sql`
    SELECT ra.old_id::float8 AS id,q.old_id::float8 AS "queryId",c.id::float8 AS "collectionId",o.sequence_no::float8 AS "sequenceNo",
      o.source_relation_key AS "relationKey",a.enterprise_id::float8 AS "enterpriseId",original.uscc_raw AS "usccRaw",original.name_raw AS "nameRaw",
      a.match_basis AS "matchBasis",a.verification_status AS "verificationStatus",${rawTitle} AS "rowTitleRaw",
      o.id::float8 AS "observationId",c.interface,cover.rdjb AS "sourceRdjb",cover.page_no::float8 AS "sourcePage"
    ${sourceRows} LEFT JOIN LATERAL(SELECT p.rdjb,p.page_no FROM platform_collection_page p
      WHERE p.collection_id=c.id AND p.status='success' AND o.sequence_no BETWEEN p.sequence_start AND p.sequence_end ORDER BY p.ordinal LIMIT 1) cover ON true
    WHERE ra.old_id=ANY(${ids(selection?.relationIds ?? targetPage!.ids)}) AND c.status IN ('success','partial')
    ORDER BY q.old_id,o.sequence_no,ra.old_id`)
  const relevantRelations = relations.filter(r => (!r.enterpriseId || r.enterpriseId === enterpriseId) &&
    ((identity && normalizeUscc(r.usccRaw) === identity) || (selection && !normalizeUscc(r.usccRaw) && r.enterpriseId === enterpriseId && r.verificationStatus === 'confirmed')))
  const factsByRelation = await factsForCandidates(db,relevantRelations)
  const positions = new Map(relevantRelations.map(row => [row.id,{ sourceRdjb: row.sourceRdjb,sourcePage: row.sourcePage }]))
  const exportBatches = event && identity ? batches.filter(b => b.importStatus === 'imported' && b.titleCode === titleCode).map(b => b.id) : []
  const { rows: exports } = await db.execute<Sources['relevantExports'][number]>(sql`
    SELECT id::float8 AS id,batch_id::float8 AS "batchId",source_row_no::float8 AS "sourceRowNo",uscc_raw AS "usccRaw"
    FROM platform_export_row WHERE batch_id=ANY(${ids(exportBatches)}) ORDER BY batch_id,source_row_no`)
  const relevantExports = exports.filter(row => identity && normalizeUscc(row.usccRaw) === identity)
  const { rows: priors } = await db.execute<Sources['priors'][number]>(sql`
    SELECT id::float8 AS id,event_id::float8 AS "eventId",type,export_row_id::float8 AS "exportRowId",revision::float8 AS revision
    FROM record_correspondence WHERE export_row_id=ANY(${ids(relevantExports.map(row => row.id))}) ORDER BY id`)
  const steps = projectCandidateRows(input,{ event,enterprise,queries,batches,relevantRelations,relevantExports,factsByRelation,positions,priors,targetPage,selection })
  const pending = steps.next()
  if (pending.done) return pending.value
  const final = steps.next(await readPostgresPlatformBusinessGroups(db,pending.value))
  if (final.done) return final.value
  throw new Error('Candidate projection did not finish')
}

export async function discoverPostgresEventArchives(db: NodePgDatabase, input: EventArchiveInput, redact: ReceiptRedactor) {
  const { rows: [owner] } = await db.execute<{ id: number; title: string; name: string; uscc: string | null }>(sql`
    SELECT e.id::float8 AS id,r.title_code AS title,e.name_norm AS name,coalesce(r.uscc_raw,e.uscc_norm) AS uscc
    FROM record_event v JOIN record r ON r.id=v.record_id JOIN enterprise e ON e.id=r.enterprise_id
    WHERE v.id=${input.eventId} AND r.source='jxj' AND v.event_type IN ('award','review')`)
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
