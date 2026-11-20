import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  assessCurrentQualificationInputs, formatQualificationCorrespondence, type CandidateEvent, type CandidateFile,
  type CurrentQualificationInput, type QualificationDisposition,
} from './current-qualification'
import { CURRENT_TITLES } from './current-titles'
import { evaluateEnterpriseFactEffects, type EnterpriseFactEffectRow } from './enterprise-fact-effects'
import { qualificationUsccCandidate, readPostgresPlatformQualificationFacts } from './platform-qualification-postgres'
import { platformEffectsForTitle } from './difference-platform-effects'
import { normalizeUscc } from '../domain'
import { projectEffectiveQualifications, type EffectiveQualification } from './effective-qualifications'

type Reader = Pick<NodePgDatabase, 'execute'>
export type PostgresQualificationTransaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Enterprise = CurrentQualificationInput['enterprise']
type EventInput = { title: string; event: CandidateEvent; recordId: string; value: string | null }
type EvidenceInput = {
  title: string; evidence: CurrentQualificationInput['evidence'][number]
  file: CandidateFile | null; capture: NonNullable<ReturnType<CurrentQualificationInput['readCaptureVersion']>> | null
}

async function readEnterprise(db: Reader, id: number) {
  const { rows } = await db.execute<Omit<Enterprise, 'id'> & { id: string; cycle: boolean; isolation: string }>(sql`
    WITH RECURSIVE identity_chain(id) AS (
      SELECT id FROM enterprise WHERE id = ${id}
      UNION ALL
      SELECT m.into_enterprise_id FROM identity_chain i JOIN enterprise_merge m ON m.from_enterprise_id = i.id
    ) CYCLE id SET cycle USING path
    SELECT e.id, e.name, e.name_norm, e.uscc_norm, e.city, e.district, i.cycle,
      current_setting('transaction_isolation') AS isolation
    FROM identity_chain i JOIN enterprise e ON e.id = i.id
    WHERE i.cycle OR NOT EXISTS (SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id = i.id)`)
  const result = rows[0]
  if (!result) return null
  const { id: canonical, cycle, isolation, ...enterprise } = result
  if (isolation !== 'repeatable read' && isolation !== 'serializable') {
    throw new Error('PostgreSQL qualification requires a repeatable-read or serializable transaction')
  }
  if (cycle) throw new Error('Enterprise identity merge cycle')
  return { id: Number(canonical), name: enterprise.name, name_norm: enterprise.name_norm,
    uscc_norm: enterprise.uscc_norm, district: enterprise.district, city: enterprise.city }
}

async function readDispositions(db: Reader, id: number) {
  const { rows } = await db.execute<QualificationDisposition>(sql`
    SELECT json_build_object('id',d.id,'revision',d.revision,'status',d.status,'kind',d.kind,'fact',d.fact::json) AS disposition,
      CASE WHEN f.id IS NOT NULL THEN json_build_object('removedAt',f.removed_at,'sha256',f.sha256) END AS file,
      CASE WHEN e.id IS NOT NULL THEN json_build_object('id',e.id,'revision',e.revision,'eventType',e.event_type,'year',e.year,'batchSeq',e.batch_seq) END AS cycle,
      CASE WHEN r.id IS NOT NULL THEN json_build_object('enterpriseId',r.enterprise_id,'titleCode',r.title_code,'source',r.source) END AS record
    FROM title_cycle_disposition_revision d
    LEFT JOIN stored_file f ON f.id = d.source_file_id
    LEFT JOIN record_event e ON e.id = d.cycle_event_id
    LEFT JOIN record r ON r.id = e.record_id
    WHERE d.enterprise_id = ${id}
      AND d.revision = (SELECT max(head.revision) FROM title_cycle_disposition_revision head WHERE head.id = d.id)
    ORDER BY d.revision_id`)
  return rows
}

type PlatformReference = CurrentQualificationInput['platformReferences'][number]
type PlatformScopeRow = { id: string; queryId: string; interface: PlatformReference["interface"]; queriedAt: string; collectionId: string;
  sequenceNo: string; titleCode: string | null; rdjb: string; owner: string | null; uscc: string | null }

async function readPlatformReferences(db: Reader, { id, uscc_norm }: Enterprise) {
  const uscc = normalizeUscc(uscc_norm)
  const { rows } = await db.execute<PlatformScopeRow>(sql`
    SELECT ra.old_id AS id, qa.old_id AS "queryId", c.interface, c.queried_at AS "queriedAt",
      c.id AS "collectionId", o.sequence_no AS "sequenceNo", c.title_code AS "titleCode", c.rdjb,
      a.enterprise_id AS owner, first.uscc_raw AS uscc
    FROM platform_business_observation o
    JOIN platform_legacy_relation_alias ra ON ra.observation_id = o.id
    JOIN platform_collection c ON c.id = o.collection_id
    JOIN platform_legacy_query_alias qa ON qa.collection_id = c.id
    JOIN platform_observation_assignment first ON first.observation_id = o.id AND first.revision = 1
    JOIN platform_observation_assignment a ON a.observation_id = o.id AND a.revision = (
      SELECT max(head.revision) FROM platform_observation_assignment head WHERE head.observation_id = o.id)
    WHERE a.enterprise_id = ${id} OR (${!!uscc} AND a.enterprise_id IS NULL
      AND ${qualificationUsccCandidate(sql`first.uscc_raw`, uscc)})
    ORDER BY ra.old_id`)
  const exact = rows.filter(row => row.owner !== null || normalizeUscc(row.uscc) === uscc)
    .map(row => ({ ...row, id: Number(row.id), queryId: Number(row.queryId), collectionId: Number(row.collectionId), sequenceNo: Number(row.sequenceNo) }))
  const pageCollections = [...new Set(exact.filter(row => row.rdjb.includes(',')).map(row => row.collectionId))]
  const pages = pageCollections.length ? (await db.execute<{ page: Parameters<typeof platformEffectsForTitle>[1][number] }>(sql`
    SELECT json_build_object('collectionId',collection_id,'status',status,'sequenceStart',sequence_start,
      'sequenceEnd',sequence_end,'rdjb',rdjb) AS page FROM platform_collection_page
    WHERE collection_id = ANY(${sql.param(pageCollections)}::bigint[]) ORDER BY ordinal`)).rows.map(row => row.page) : []
  return (title: string): PlatformReference[] => platformEffectsForTitle(exact, pages, title)
    .map(({ id, queryId, interface: kind, queriedAt }) => ({ id, queryId, interface: kind, queriedAt }))
}

/** Read all qualification inputs through the caller's repeatable-read (or
 * serializable) transaction. Keep asOf fixed across this and any adjacent reads. */
export async function readPostgresCurrentQualification(tx: PostgresQualificationTransaction, enterpriseId: number, asOf: number) {
  if (!Number.isSafeInteger(enterpriseId)) return null
  const enterprise = await readEnterprise(tx, enterpriseId)
  if (!enterprise) return null
  const { id } = enterprise
  const events = await tx.execute<EventInput>(sql`
    SELECT r.title_code AS title, e.record_id AS "recordId", e.formal_validity AS value,
      json_build_object('id',e.id,'eventType',e.event_type,'year',e.year,'decidedYear',e.decided_year,
        'batchSeq',e.batch_seq,'reviewOutcome',e.review_outcome,'revision',e.revision,
        'nameRaw',r.name_raw,'usccRaw',r.uscc_raw,'source',r.source) AS event
    FROM record r JOIN record_event e ON e.record_id = r.id WHERE r.enterprise_id = ${id} ORDER BY e.id`)
  const evidence = await tx.execute<EvidenceInput>(sql`
    SELECT r.title_code AS title,
      json_build_object('id',v.id,'eventId',v.record_event_id,'sourceFile',v.source_file,
        'attachment',v.attachment,'listNo',v.list_no,'page',v.page) AS evidence,
      CASE WHEN f.id IS NOT NULL THEN json_build_object('id',f.id,'sha256',f.sha256,'bytes',f.bytes,'removedAt',f.removed_at) END AS file,
      CASE WHEN capture.revision IS NOT NULL THEN json_build_object('revision',capture.revision,'sha256',capture.sha256) END AS capture
    FROM record r JOIN record_event e ON e.record_id = r.id JOIN record_evidence v ON v.record_event_id = e.id
    LEFT JOIN stored_file f ON f.rel_path = v.source_file
    LEFT JOIN LATERAL (SELECT revision, sha256 FROM official_evidence_row_revision
      WHERE evidence_id = v.id ORDER BY revision DESC LIMIT 1) capture ON true
    WHERE r.enterprise_id = ${id} ORDER BY v.id`)
  const aliases = await tx.execute<{ alias: ReturnType<CurrentQualificationInput['readAliases']>[number] }>(sql`
    SELECT json_build_object('id',id,'name',name,'version',version) AS alias FROM enterprise_alias
    WHERE enterprise_id = ${id} AND verification_status = 'confirmed' ORDER BY id`)
  const facts = await tx.execute<{ fact: EnterpriseFactEffectRow }>(sql`
    WITH RECURSIVE members(id) AS (
      SELECT ${id}::bigint
      UNION
      SELECT m.from_enterprise_id FROM enterprise_merge m JOIN members i ON m.into_enterprise_id = i.id
    )
    SELECT json_build_object('enterpriseId',r.enterprise_id,'factId',r.fact_id,'revision',r.revision,
      'status',r.status,'fact',r.fact::text,'basis',r.basis) AS fact
    FROM enterprise_fact_revision r JOIN members i ON r.enterprise_id = i.id ORDER BY r.id`)
  const dispositions = await readDispositions(tx, id)
  const platformFacts = await readPostgresPlatformQualificationFacts(tx, id, enterprise.uscc_norm)
  const platformReferences = await readPlatformReferences(tx, enterprise)
  // Stored links are evidence locators. Live source/proof revalidation is
  // part of the full detail reader and has no effect on eligibility.
  const correspondence = await tx.execute<{ title: string; id: string; revision: string; status: string }>(sql`
    SELECT title_code AS title, id, revision, status FROM record_correspondence
    WHERE enterprise_id = ${id} ORDER BY id`)
  const refsByTitle = Map.groupBy(correspondence.rows, row => row.title)
  const rowsByTitle = Map.groupBy(events.rows, row => row.title)
  const evidenceByTitle = Map.groupBy(evidence.rows, row => row.title)
  const files = new Map(evidence.rows.flatMap(row => row.file ? [[row.evidence.sourceFile, row.file] as const] : []))
  const captures = new Map(evidence.rows.flatMap(row => row.capture ? [[row.evidence.id, row.capture] as const] : []))
  const factRows = facts.rows.map(row => row.fact)
  const aliasRows = aliases.rows.map(row => row.alias)

  return assessCurrentQualificationInputs(enterpriseId, asOf, new Map(CURRENT_TITLES.map(title => {
    const titleEvents = rowsByTitle.get(title) ?? []
    const input: CurrentQualificationInput = {
      enterprise,
      events: titleEvents.map(row => row.event),
      evidence: (evidenceByTitle.get(title) ?? []).map(row => row.evidence),
      readValidityRows: () => titleEvents.map(row => ({ id: row.event.id, recordId: Number(row.recordId), value: row.value })),
      readFile: path => files.get(path),
      readAliases: () => aliasRows,
      readDispositions: () => dispositions,
      platformReferences: platformReferences(title),
      correspondenceReferences: () => (refsByTitle.get(title) ?? []).map(row =>
        formatQualificationCorrespondence({ id: Number(row.id), revision: Number(row.revision), status: row.status })),
      readFactEffects: effectiveOnly => evaluateEnterpriseFactEffects(factRows, asOf, effectiveOnly),
      readPlatformFacts: () => platformFacts,
      readCaptureVersion: evidenceId => captures.get(evidenceId),
    }
    return [title, input]
  })))
}

/** Read effective titles in the same transaction and asOf as the surrounding export. */
export async function readPostgresEffectiveQualifications(tx: PostgresQualificationTransaction, enterpriseId: number, asOf: number): Promise<EffectiveQualification[] | null> {
  const read = await readPostgresCurrentQualification(tx, enterpriseId, asOf)
  return read === null ? null : projectEffectiveQualifications(read.titles)
}
