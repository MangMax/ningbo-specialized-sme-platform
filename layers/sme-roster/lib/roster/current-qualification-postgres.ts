import { decodePostgresExactCell } from '../../../../db/postgresql/exact-cell'
import { sql } from 'drizzle-orm'
import * as schema from '../../../../db/schema'
import { postgresRosterRow } from './postgres-rows'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  assessCurrentQualificationInputs, currentQualificationSnapshot, evaluateLoadedCurrentQualification, formatQualificationCorrespondence,
  type CandidateEvent, type CandidateFile, type CurrentQualificationInput, type LoadedCurrentQualificationInput, type QualificationDisposition,
} from './current-qualification'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'
import { evaluateEnterpriseFactEffects, type EnterpriseFactEffectRow } from './enterprise-fact-effects'
import { qualificationUsccCandidate, createPostgresPlatformQualificationReader, type PostgresPlatformQualificationReader } from './platform-qualification-postgres'
import { platformEffectsForTitle } from './difference-platform-effects'
import { currentCandidateIdBlocks } from './current-candidate-reader'
import type { PlatformInterface } from '../labels'
import { normalizeUscc } from '../domain'
import { projectEffectiveQualifications, type EffectiveQualification } from './effective-qualifications'
import { readPostgresRecognizedWitnesses } from './recognized-witness-postgres'
import { readPostgresQueryCoverage } from './query-coverage-postgres'
import { readPostgresOfficialPublishedPresentation } from './official-published-presentation-postgres'
import { officialPublishedError, projectOfficialPublishedNames, type OfficialPublishedScope, type OfficialPublishedFact } from './official-published-presentation'
import type { PublishedPresentation } from './correspondence-view'
import { importPostgresReceiptRedactor } from '../../server/utils/import-receipt-redaction'
import { CANDIDATE_SCOPE_RULE } from '../platform/candidate-scope-capture'
import { readPostgresCorrespondenceRefs } from '../../server/utils/record-correspondence-postgres-refs'

type Reader = Pick<NodePgDatabase, 'execute'>
export type PostgresQualificationTransaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Enterprise = CurrentQualificationInput['enterprise']
type EventInput = { owner: string; title: string; event: CandidateEvent; recordId: string; value: string | null }
type EvidenceInput = {
  owner: string; title: string; evidence: CurrentQualificationInput['evidence'][number]
  file: CandidateFile | null; capture: NonNullable<ReturnType<CurrentQualificationInput['readCaptureVersion']>> | null
}

const pgIds = (ids: readonly number[]) => sql`${sql.param(ids)}::bigint[]`

async function readEnterprises(db: Reader, ids: readonly number[]) {
  const { rows } = await db.execute<{ requested: string; enterprise: Enterprise; cycle: boolean; isolation: string }>(sql`
    WITH RECURSIVE identity_chain(requested, id) AS (
      SELECT id, id FROM enterprise WHERE id = ANY(${pgIds(ids)})
      UNION ALL
      SELECT i.requested, m.into_enterprise_id FROM identity_chain i JOIN enterprise_merge m ON m.from_enterprise_id = i.id
    ) CYCLE id SET cycle USING path
    SELECT i.requested, i.cycle, current_setting('transaction_isolation') AS isolation,
      json_build_object('id',e.id,'name',e.name,'name_norm',e.name_norm,'uscc_norm',e.uscc_norm,'district',e.district,'city',e.city) AS enterprise
    FROM identity_chain i JOIN enterprise e ON e.id = i.id
    WHERE i.cycle OR NOT EXISTS (SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id = i.id)`)
  return rows.map(({ requested, enterprise, cycle, isolation }) => {
    if (isolation !== 'repeatable read' && isolation !== 'serializable') {
      throw new Error('PostgreSQL qualification requires a repeatable-read or serializable transaction')
    }
    if (cycle) throw new Error('Enterprise identity merge cycle')
    return { requested: Number(requested), enterprise }
  })
}

async function readDispositions(db: Reader, ids: readonly number[]) {
  const { rows } = await db.execute<QualificationDisposition & { owner: string }>(sql`
    SELECT d.enterprise_id AS owner, ${postgresRosterRow(schema.titleCycleDispositionRevision, 'd')} AS disposition,
      CASE WHEN f.id IS NOT NULL THEN ${postgresRosterRow(schema.storedFile, 'f')} END AS file,
      CASE WHEN e.id IS NOT NULL THEN ${postgresRosterRow(schema.recordEvent, 'e')} END AS cycle,
      CASE WHEN r.id IS NOT NULL THEN ${postgresRosterRow(schema.record, 'r')} END AS record
    FROM title_cycle_disposition_revision d
    LEFT JOIN stored_file f ON f.id = d.source_file_id
    LEFT JOIN record_event e ON e.id = d.cycle_event_id
    LEFT JOIN record r ON r.id = e.record_id
    WHERE d.enterprise_id = ANY(${pgIds(ids)})
      AND d.revision = (SELECT max(head.revision) FROM title_cycle_disposition_revision head WHERE head.id = d.id)
    ORDER BY d.revision_id`)
  return Map.groupBy(rows.map(({ owner, ...input }) => ({ owner: Number(owner), input })), row => row.owner)
}

type PlatformReference = CurrentQualificationInput['platformReferences'][number]
type PlatformEffect = PlatformReference & { interface: PlatformInterface; status: string | null; year: number | null; batch: string | null }
const titleScopeBits = { innovative_sme: 1, specialized_sme: 2, little_giant: 4 } satisfies Record<CurrentTitle, number>
type PlatformScopeRow = { id: string; queryId: string; interface: PlatformInterface; queriedAt: string; collectionId: string;
  sequenceNo: string; titleCode: string | null; rdjb: string; owner: string | null; uscc: string | null
  captured: boolean; mask: number | null; textStatus: string | null; processStatus: Buffer | null; statusStorage: string | null
  year: number | null; batch: string | null
  processYear: Buffer | null; yearStorage: string | null
  processBatch: Buffer | null; batchStorage: string | null
}

async function readPlatformEffects(db: Reader, subjects: readonly Enterprise[], hydrated: boolean) {
  const byUscc = Map.groupBy(subjects, owner => normalizeUscc(owner.uscc_norm))
  byUscc.delete('')
  const codes = [...byUscc.keys()]
  const ids = subjects.map(owner => owner.id)
  const { rows } = await db.execute<PlatformScopeRow>(sql`
    SELECT ra.old_id AS id, qa.old_id AS "queryId", c.interface, c.queried_at AS "queriedAt",
      c.id AS "collectionId", o.sequence_no AS "sequenceNo", c.title_code AS "titleCode", c.rdjb,
      a.enterprise_id AS owner, ${hydrated ? sql`a.uscc_raw` : sql`first.uscc_raw`} AS uscc
      ${hydrated ? sql`, o.candidate_scope_state='captured' AND o.candidate_scope_rule=${CANDIDATE_SCOPE_RULE} AS captured,
        o.candidate_scope_mask::integer AS mask, coalesce(ap.stored_status,rp.stored_status) AS "textStatus",
        bp.exact_status AS "processStatus", bp.exact_status_sqlite_storage AS "statusStorage",
        bp.exact_year AS "processYear", bp.exact_year_sqlite_storage AS "yearStorage",
        bp.exact_batch AS "processBatch", bp.exact_batch_sqlite_storage AS "batchStorage",
        coalesce(ap.stored_year,rp.stored_year)::float8 AS year, coalesce(ap.stored_batch,rp.stored_batch) AS batch` : sql.empty()}
    FROM platform_business_observation o
    JOIN platform_legacy_relation_alias ra ON ra.observation_id = o.id
    JOIN platform_collection c ON c.id = o.collection_id
    JOIN platform_legacy_query_alias qa ON qa.collection_id = c.id
    JOIN platform_observation_assignment first ON first.observation_id = o.id AND first.revision = 1
    JOIN platform_observation_assignment a ON a.observation_id = o.id AND a.revision = (
      SELECT max(head.revision) FROM platform_observation_assignment head WHERE head.observation_id = o.id)
    ${hydrated ? sql`LEFT JOIN platform_business_projection bp ON bp.observation_id=o.id
      LEFT JOIN platform_apply_projection ap ON ap.observation_id=o.id
      LEFT JOIN platform_recognized_projection rp ON rp.observation_id=o.id` : sql.empty()}
    WHERE a.enterprise_id = ANY(${pgIds(ids)}) OR (${codes.length > 0} AND a.enterprise_id IS NULL
      AND ${qualificationUsccCandidate(hydrated ? sql`a.uscc_raw` : sql`first.uscc_raw`, codes)})
    ORDER BY ra.old_id`)
  const exact = rows.flatMap(row => {
    const owners = row.owner !== null ? [Number(row.owner)] : (byUscc.get(normalizeUscc(row.uscc)) ?? []).map(item => item.id)
    return owners.map(owner => ({ ...row, owner, id: Number(row.id), queryId: Number(row.queryId),
      collectionId: Number(row.collectionId), sequenceNo: Number(row.sequenceNo) }))
  })
  const pageCollections = hydrated ? [] : [...new Set(exact.filter(row => row.rdjb.includes(',')).map(row => row.collectionId))]
  const pages = pageCollections.length ? (await db.execute<{ page: Parameters<typeof platformEffectsForTitle>[1][number] }>(sql`
    SELECT json_build_object('collectionId',collection_id,'status',status,'sequenceStart',sequence_start,
      'sequenceEnd',sequence_end,'rdjb',rdjb) AS page FROM platform_collection_page
    WHERE collection_id = ANY(${sql.param(pageCollections)}::bigint[]) ORDER BY ordinal`)).rows.map(row => row.page) : []
  const byOwner = Map.groupBy(exact, row => row.owner)
  return (owner: number, title: CurrentTitle): PlatformEffect[] => {
    const available = byOwner.get(owner) ?? []
    const selected = hydrated ? available.filter(row => {
      if (!row.captured || row.mask === null) throw new Error('Current hydration candidate capture unavailable')
      return Boolean(row.mask & titleScopeBits[title])
    }) : platformEffectsForTitle(available, pages, title)
    return selected.map(row => ({
      id: row.id, queryId: row.queryId, interface: row.interface, queriedAt: row.queriedAt,
      year: row.processYear == null ? row.year ?? null : decodePostgresExactCell(row.processYear, row.yearStorage) as number | null,
      batch: row.processBatch == null ? row.batch ?? null : decodePostgresExactCell(row.processBatch, row.batchStorage) as string | null,
      status: row.processStatus == null ? row.textStatus ?? null : decodePostgresExactCell(row.processStatus, row.statusStorage) as string | null,
    }))
  }
}

async function readQualificationInputs(tx: PostgresQualificationTransaction, enterpriseIds: readonly number[], asOf: number,
  selectionScope?: { mode: 'scan' | 'detail' | 'workbook' | 'classify'; title: CurrentTitle }, readPlatform = createPostgresPlatformQualificationReader(tx)) {
  if (!enterpriseIds.length) return []
  const selection = await readEnterprises(tx, enterpriseIds)
  if (!selection.length) return []
  const subjects = [...new Map(selection.map(({ enterprise }) => [enterprise.id, enterprise])).values()]
  const ids = subjects.map(enterprise => enterprise.id)
  const events = await tx.execute<EventInput>(sql`
    SELECT r.enterprise_id AS owner, r.title_code AS title, e.record_id AS "recordId", e.formal_validity AS value,
      json_build_object('id',e.id,'eventType',e.event_type,'year',e.year,'decidedYear',e.decided_year,
        'batchSeq',e.batch_seq,'reviewOutcome',e.review_outcome,'revision',e.revision,
        'nameRaw',r.name_raw,'usccRaw',r.uscc_raw,'source',r.source) AS event
    FROM record r JOIN record_event e ON e.record_id = r.id WHERE r.enterprise_id = ANY(${pgIds(ids)}) ORDER BY e.id`)
  const evidence = await tx.execute<EvidenceInput>(sql`
    SELECT r.enterprise_id AS owner, r.title_code AS title,
      json_build_object('id',v.id,'eventId',v.record_event_id,'sourceFile',v.source_file,
        'attachment',v.attachment,'listNo',v.list_no,'page',v.page) AS evidence,
      CASE WHEN f.id IS NOT NULL THEN json_build_object('id',f.id,'sha256',f.sha256,'bytes',f.bytes,'removedAt',f.removed_at) END AS file,
      CASE WHEN capture.revision IS NOT NULL THEN json_build_object('revision',capture.revision,'sha256',capture.sha256) END AS capture
    FROM record r JOIN record_event e ON e.record_id = r.id JOIN record_evidence v ON v.record_event_id = e.id
    LEFT JOIN stored_file f ON f.rel_path = v.source_file
    LEFT JOIN LATERAL (SELECT revision, sha256 FROM official_evidence_row_revision
      WHERE evidence_id = v.id ORDER BY revision DESC LIMIT 1) capture ON true
    WHERE r.enterprise_id = ANY(${pgIds(ids)}) ORDER BY v.id`)
  const aliases = await tx.execute<{ owner: string; alias: ReturnType<CurrentQualificationInput['readAliases']>[number] }>(sql`
    SELECT enterprise_id AS owner, json_build_object('id',id,'name',name,'version',version) AS alias FROM enterprise_alias
    WHERE enterprise_id = ANY(${pgIds(ids)}) AND verification_status = 'confirmed' ORDER BY id`)
  const facts = await tx.execute<{ owner: string; fact: EnterpriseFactEffectRow }>(sql`
    WITH RECURSIVE members(owner, id) AS (
      SELECT requested, requested FROM unnest(${pgIds(ids)}) AS input(requested)
      UNION
      SELECT i.owner, m.from_enterprise_id FROM enterprise_merge m JOIN members i ON m.into_enterprise_id = i.id
    )
    SELECT i.owner, json_build_object('enterpriseId',r.enterprise_id,'factId',r.fact_id,'revision',r.revision,
      'status',r.status,'fact',r.fact::text,'basis',r.basis) AS fact
    FROM enterprise_fact_revision r JOIN members i ON r.enterprise_id = i.id ORDER BY r.id`)
  const dispositions = await readDispositions(tx, ids)
  const platformFacts = await readPlatform(subjects)
  const scanning = selectionScope?.mode === 'scan'
  const classifying = selectionScope?.mode === 'classify'
  const detailed = selectionScope?.mode === 'detail' || selectionScope?.mode === 'workbook'
  const platformEffects = scanning || classifying ? undefined : await readPlatformEffects(tx, subjects, detailed)
  const correspondence = classifying ? [] : await readPostgresCorrespondenceRefs(tx, ids, scanning ? selectionScope.title : undefined)
  const witnesses = selectionScope?.mode === 'detail' || scanning ? await readPostgresRecognizedWitnesses(tx, [...new Set(correspondence.flatMap(ref =>
    ref.type === 'event_recognized' && ref.role === 'recognized_corrob' && ref.status === 'confirmed' && !ref.requiresRevalidation
      && ref.relationId !== null ? [ref.relationId] : []))]) : undefined
  const eventsByOwner = Map.groupBy(events.rows, row => Number(row.owner))
  const evidenceByOwner = Map.groupBy(evidence.rows, row => Number(row.owner))
  const referencesByOwner = Map.groupBy(correspondence, row => row.enterpriseId)
  const aliasesByOwner = Map.groupBy(aliases.rows, row => Number(row.owner))
  const factsByOwner = Map.groupBy(facts.rows, row => Number(row.owner))
  const byCanonical = new Map(subjects.map(enterprise => {
    const { id } = enterprise
    const ownerEvidence = evidenceByOwner.get(id) ?? []
    const refsByTitle = Map.groupBy(referencesByOwner.get(id) ?? [], row => row.titleCode)
    const rowsByTitle = Map.groupBy(eventsByOwner.get(id) ?? [], row => row.title)
    const evidenceByTitle = Map.groupBy(ownerEvidence, row => row.title)
    const files = new Map(ownerEvidence.flatMap(row => row.file ? [[row.evidence.sourceFile, row.file] as const] : []))
    const captures = new Map(ownerEvidence.flatMap(row => row.capture ? [[row.evidence.id, row.capture] as const] : []))
    const factRows = (factsByOwner.get(id) ?? []).map(row => row.fact)
    const aliasRows = (aliasesByOwner.get(id) ?? []).map(row => row.alias)
    const inputs = new Map(CURRENT_TITLES.map(title => {
      const titleEvents = rowsByTitle.get(title) ?? []
      const effects = platformEffects?.(id, title) ?? []
      const refs = refsByTitle.get(title) ?? []
      const input: LoadedCurrentQualificationInput = {
        enterprise,
        events: titleEvents.map(row => row.event),
        evidence: (evidenceByTitle.get(title) ?? []).map(row => row.evidence),
        readValidityRows: () => titleEvents.map(row => ({ id: row.event.id, recordId: Number(row.recordId), value: row.value })),
        readFile: path => files.get(path),
        readAliases: () => aliasRows,
        readDispositions: () => dispositions.get(id)?.map(row => row.input) ?? [],
        platformReferences: effects.map(({ id, queryId, interface: kind, queriedAt }) => ({ id, queryId, interface: kind, queriedAt })),
        ...(selectionScope ? { readWitnesses: witnesses, readCorrespondences: () => refs }
          : { correspondenceReferences: () => refs.map(formatQualificationCorrespondence) }),
        ...(detailed ? { readPlatformEffects: () => effects } : {}),
        readFactEffects: effectiveOnly => evaluateEnterpriseFactEffects(factRows, asOf, effectiveOnly),
        readPlatformFacts: () => platformFacts.get(id) ?? [],
        readCaptureVersion: evidenceId => captures.get(evidenceId),
      }
      return [title, input] as const
    }))
    return [id, inputs] as const
  }))
  return selection.map(({ requested, enterprise }) => [requested, byCanonical.get(enterprise.id)!] as const)
}

async function readQualificationCandidates(tx: PostgresQualificationTransaction, enterpriseIds: readonly number[], asOf: number, readPlatform?: PostgresPlatformQualificationReader) {
  const inputs = await readQualificationInputs(tx, enterpriseIds, asOf, undefined, readPlatform)
  return inputs.map(([requested, facts]) => [requested, assessCurrentQualificationInputs(requested, asOf, facts)] as const)
}

export async function readPostgresCurrentFilterBatch(tx: PostgresQualificationTransaction, ids: readonly number[], title: CurrentTitle, asOf: number, readPlatform?: PostgresPlatformQualificationReader) {
  const loaded = await readQualificationInputs(tx, ids, asOf, { mode: 'scan', title }, readPlatform)
  return new Map(loaded.map(([id, inputs]) => [id, evaluateLoadedCurrentQualification(asOf, inputs, title, 'scan').get(title)!]))
}

export async function readPostgresCurrentStatusBatch(tx: PostgresQualificationTransaction, ids: readonly number[], title: CurrentTitle, asOf: number, readPlatform?: PostgresPlatformQualificationReader) {
  const loaded = await readQualificationInputs(tx, ids, asOf, { mode: 'classify', title }, readPlatform)
  return new Map(loaded.map(([id, inputs]) => [id, evaluateLoadedCurrentQualification(asOf, inputs, undefined, 'scan').get(title)!.effectiveStatus]))
}

async function readPostgresDetailedAssessments(tx: PostgresQualificationTransaction, ids: readonly number[], title: CurrentTitle, asOf: number, mode: 'detail' | 'workbook', readPlatform?: PostgresPlatformQualificationReader) {
  const hydrated: [number, { rows: import('./current-qualification').CurrentRow[];
    snapshot: ReturnType<typeof currentQualificationSnapshot>; publishedPresentation?: PublishedPresentation;
    workbookPublished: Map<number, OfficialPublishedFact> }][] = []
  if (!ids.length) return new Map(hydrated)
  const loaded = await readQualificationInputs(tx, ids, asOf, { mode, title }, readPlatform)
  const coverageOwners = await tx.execute<{ id: number; name_norm: string; uscc_norm: string | null }>(sql`
    SELECT id::float8 AS id, name_norm, uscc_norm FROM enterprise WHERE id=ANY(${pgIds(ids)})`)
  const titles = mode === 'workbook' ? CURRENT_TITLES.slice(0, CURRENT_TITLES.indexOf(title) + 1) : CURRENT_TITLES
  const coverage = await readPostgresQueryCoverage(tx, coverageOwners.rows, titles)
  const redact = await importPostgresReceiptRedactor(tx)
  for (const [id, inputs] of loaded) {
    for (const target of titles) {
      const input = inputs.get(target)!
      const scope = input.evidence.map(row => ({ evidenceId: row.id, eventId: row.eventId }))
      try {
        const facts = await readPostgresOfficialPublishedPresentation(tx, scope, redact)
        input.readPublishedNames = () => [...facts.values()]
      } catch (error) {
        input.readPublishedNames = () => { throw officialPublishedError(error) }
      }
      input.readCoverage = () => coverage.get(id)!.get(target)!
    }
    let presentationScope: readonly OfficialPublishedScope[] | undefined
    let presentationFacts: readonly OfficialPublishedFact[] | undefined
    let presentationError: unknown
    const outcome = evaluateLoadedCurrentQualification(asOf, inputs, title, mode, (scope, selected, names, error) => {
      presentationScope = selected
      if (scope.length !== selected.length || scope.some((item, index) => item.evidenceId !== selected[index]!.evidenceId || item.eventId !== selected[index]!.eventId)) return
      if (names.availability === 'unavailable') presentationError = officialPublishedError(error)
      else presentationFacts = names.facts
    })
    if (presentationScope === undefined) throw new Error('Current published-name scope was not evaluated')
    if (!presentationFacts && !presentationError) {
      try {
        const facts = await readPostgresOfficialPublishedPresentation(tx, presentationScope, redact)
        presentationFacts = [...facts.values()]
      } catch (error) { presentationError = officialPublishedError(error) }
    }
    const rows = mode === 'workbook' ? [outcome.get(title)!.row] : [...outcome.values()].map(result => result.row)
    const base = { rows, snapshot: currentQualificationSnapshot(id, asOf, rows.map(row => row.assessment!)) }
    if (mode === 'workbook' && presentationError) throw presentationError
    const workbookPublished = new Map((presentationFacts ?? []).map(fact => [fact.evidenceId, fact]))
    let publishedPresentation: PublishedPresentation | undefined
    if (mode === 'detail') {
      try {
        if (presentationError) throw presentationError
        publishedPresentation = projectOfficialPublishedNames(presentationFacts!, presentationScope, 1, 2)
      } catch (error) {
        publishedPresentation = { availability: 'unavailable', error: officialPublishedError(error).code, facts: [] }
      }
    }
    hydrated.push([id, { ...base, publishedPresentation, workbookPublished }] as const)
  }
  return new Map(hydrated)
}

export function readPostgresCurrentDetailBatch(tx: PostgresQualificationTransaction, ids: readonly number[], title: CurrentTitle, asOf: number, readPlatform?: PostgresPlatformQualificationReader) {
  return readPostgresDetailedAssessments(tx, ids, title, asOf, 'detail', readPlatform)
}

export function readPostgresCurrentWorkbookBatch(tx: PostgresQualificationTransaction, ids: readonly number[], title: CurrentTitle, asOf: number, readPlatform?: PostgresPlatformQualificationReader) {
  return readPostgresDetailedAssessments(tx, ids, title, asOf, 'workbook', readPlatform)
}

/** Read all input families in bounded sets on the caller's fixed snapshot. */
export async function readPostgresEffectiveQualificationsBatch(tx: PostgresQualificationTransaction, enterpriseIds: readonly number[], asOf: number) {
  const completed = new Map<number, EffectiveQualification[]>()
  const readPlatform = createPostgresPlatformQualificationReader(tx)
  for (const block of currentCandidateIdBlocks([...new Set(enterpriseIds.filter(Number.isSafeInteger))])) {
    for (const [id, snapshot] of await readQualificationCandidates(tx, block, asOf, readPlatform)) completed.set(id, projectEffectiveQualifications(snapshot.titles))
  }
  return completed
}

export async function readPostgresCurrentQualification(tx: PostgresQualificationTransaction, enterpriseId: number, asOf: number) {
  if (!Number.isSafeInteger(enterpriseId)) return null
  return (await readQualificationCandidates(tx, [enterpriseId], asOf))[0]?.[1] ?? null
}

/** Read effective titles in the same transaction and asOf as the surrounding export. */
export async function readPostgresEffectiveQualifications(tx: PostgresQualificationTransaction, enterpriseId: number, asOf: number): Promise<EffectiveQualification[] | null> {
  const read = await readPostgresCurrentQualification(tx, enterpriseId, asOf)
  return read === null ? null : projectEffectiveQualifications(read.titles)
}
