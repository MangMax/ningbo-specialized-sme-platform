import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, max, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import { importBatch } from '../../../../db/postgresql/import-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { maintainedDifferenceKind, reviewTarget } from '../../server/utils/decision-lifecycle/reviewed-decisions'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { officialEvidenceRowRevision } from '../../../../db/postgresql/official-evidence-tables'
import {
  platformApplyProjection, platformBusinessObservation, platformBusinessProjection, platformCollection,
  platformCollectionPage, platformObservationAssignment,
} from '../../../../db/postgresql/platform-tables'
import { enterpriseFactRevision, titleCycleDispositionRevision } from '../../../../db/postgresql/qualification-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  assessCurrentQualificationInputs, assessLegacyQualificationInputs, currentQualificationSnapshot, evaluateLoadedCurrentQualification, formatQualificationCorrespondence,
  type CandidateEvent, type CandidateFile, type CurrentQualificationInput, type LoadedCurrentQualificationInput, type LegacyQualificationInput, type QualificationDisposition,
} from './current-qualification-model'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'
import { evaluateEnterpriseFactEffects, type EnterpriseFactEffectRow } from './enterprise-fact-effects'
import { qualificationUsccCandidate, createPostgresPlatformQualificationReader, type PostgresPlatformQualificationReader } from './platform-qualification-postgres'
import { isCurrentPlatformObservation } from '../platform/current-observation-postgres'
import { platformEffectsForTitle } from './difference-platform-scope'
import { currentCandidateIdBlocks } from './current-candidate-reader'
import type { PlatformInterface } from '../labels'
import { normalizeUscc } from '../domain'
import { projectEffectiveQualifications, type EffectiveQualification } from './effective-qualifications'
import { readPostgresRecognizedWitnesses } from './recognized-witness-postgres'
import { readPostgresQueryCoverage } from './query-coverage-postgres'
import { createPostgresPublishedPresentationReader } from './official-published-presentation-postgres'
import { officialPublishedError, projectOfficialPublishedNames, type OfficialPublishedScope, type OfficialPublishedFact } from './official-published-presentation'
import type { PublishedPresentation } from './correspondence-view'
import { importPostgresReceiptRedactor } from '../../server/utils/import-receipt-redaction'
import type { ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import { platformObservationSourceValue, platformObservationVersionDefaults } from '../platform/postgres-observation-facts'
import { readPostgresCorrespondenceRefs } from '../../server/utils/record-correspondence-postgres-refs'

import { readPostgresQualificationDecisionHeads } from '../../server/utils/decision-lifecycle/postgres-reads'
import { readPostgresDifferenceObservations } from '../platform/difference-sources-postgres'
import { readPostgresQueryAssessments } from './query-assessment-postgres'

type Reader = Pick<NodePgDatabase, 'select'>
export type PostgresQualificationTransaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Enterprise = CurrentQualificationInput['enterprise']
const pgIds = (ids: readonly number[]) => sql`${sql.param(ids)}::bigint[]`

async function readEnterprises(db: Reader, ids: readonly number[]) {
  // Drizzle's CTE builder has no recursive or CYCLE mode. Keep traversal and its
  // cycle marker in one derived relation, within the caller's read snapshot.
  const identityChain = sql`(
    WITH RECURSIVE identity_chain(requested, id) AS (
      SELECT ${enterprise.id}, ${enterprise.id} FROM ${enterprise} WHERE ${enterprise.id} = ANY(${pgIds(ids)})
      UNION ALL
      SELECT i.requested, ${enterpriseMerge.intoEnterpriseId} FROM identity_chain i
      JOIN ${enterpriseMerge} ON ${enterpriseMerge.fromEnterpriseId} = i.id
    ) CYCLE id SET cycle USING path
    SELECT i.requested, i.id, i.cycle FROM identity_chain i
    WHERE i.cycle OR NOT EXISTS (SELECT 1 FROM ${enterpriseMerge} WHERE ${enterpriseMerge.fromEnterpriseId} = i.id)
  ) identity_chain`
  const rows = await db.select({
    requested: sql<number>`identity_chain.requested`.mapWith(Number),
    cycle: sql<boolean>`identity_chain.cycle`,
    isolation: sql<string>`current_setting('transaction_isolation')`,
    enterprise: {
      id: enterprise.id, name: enterprise.name, name_norm: enterprise.nameNorm,
      uscc_norm: enterprise.usccNorm, district: enterprise.district, city: enterprise.city,
    },
  }).from(enterprise).innerJoin(identityChain, eq(enterprise.id, sql`identity_chain.id`))
  return rows.map(({ requested, enterprise, cycle, isolation }) => {
    if (isolation !== 'repeatable read' && isolation !== 'serializable') {
      throw new Error('PostgreSQL qualification requires a repeatable-read or serializable transaction')
    }
    if (cycle) throw new Error('Enterprise identity merge cycle')
    return { requested, enterprise }
  })
}

async function readDispositions(db: Reader, ids: readonly number[]) {
  const disposition = titleCycleDispositionRevision
  const head = alias(disposition, 'disposition_head')
  const latestRevision = db.select({ revision: max(head.revision) }).from(head).where(eq(head.id, disposition.id))
  const rows = await db.select({
    owner: disposition.enterpriseId,
    disposition: getTableColumns(disposition),
    file: getTableColumns(storedFile),
    // The qualification digest hashes these full objects in SQLite field order.
    cycle: {
      id: recordEvent.id, recordId: recordEvent.recordId, eventType: recordEvent.eventType, year: recordEvent.year,
      batchSeq: recordEvent.batchSeq, sortKey: recordEvent.sortKey, reviewOutcome: recordEvent.reviewOutcome,
      decidedYear: recordEvent.decidedYear, formalValidity: recordEvent.formalValidity, revision: recordEvent.revision,
    },
    record: getTableColumns(record),
  }).from(disposition)
    .leftJoin(storedFile, eq(storedFile.id, disposition.sourceFileId))
    .leftJoin(recordEvent, eq(recordEvent.id, disposition.cycleEventId))
    .leftJoin(record, eq(record.id, recordEvent.recordId))
    .where(and(inArray(disposition.enterpriseId, ids), eq(disposition.revision, latestRevision)))
    .orderBy(disposition.revisionId)
  return Map.groupBy(rows.map(({ owner, disposition, file, cycle, record }) => {
    const input = {
      disposition: { ...disposition, fact: JSON.parse(disposition.fact), audit: JSON.parse(disposition.audit) },
      file: file && { ...file, bytes: Number(file.bytes) },
      cycle: cycle && { ...cycle, formalValidity: cycle.formalValidity === null ? null : JSON.parse(cycle.formalValidity) },
      record: record && { ...record, qualityFlags: record.qualityFlags === null ? null : JSON.parse(record.qualityFlags) },
    } as QualificationDisposition
    return { owner, input }
  }), row => row.owner)
}

type PlatformReference = CurrentQualificationInput['platformReferences'][number]
type PlatformEffect = PlatformReference & { interface: PlatformInterface; status: string | null; year: number | null; batch: string | null }
const titleScopeBits = { innovative_sme: 1, specialized_sme: 2, little_giant: 4 } satisfies Record<CurrentTitle, number>

async function readPlatformEffects(db: Reader, subjects: readonly Enterprise[], scope: 'references' | 'roster-detail' | 'hydration') {
  const hydrated = scope === 'hydration'
  const readFacts = scope !== 'references'
  const byUscc = Map.groupBy(subjects, owner => normalizeUscc(owner.uscc_norm))
  byUscc.delete('')
  const codes = [...byUscc.keys()]
  const ids = subjects.map(owner => owner.id)
  const observation = platformBusinessObservation
  const collection = platformCollection
  const assignment = platformObservationAssignment
  const first = alias(assignment, 'first_assignment')
  const head = alias(assignment, 'head_assignment')


  const apply = platformApplyProjection
  const business = platformBusinessProjection
  const uscc = hydrated ? assignment.usccRaw : first.usccRaw
  const latestRevision = db.select({ revision: max(head.revision) }).from(head).where(eq(head.observationId, observation.id))
  const query = db.select({
    id: observation.publicId, queryId: collection.publicId, interface: collection.interface, queriedAt: collection.queriedAt,
    collectionId: collection.id, sequenceNo: observation.sequenceNo, titleCode: collection.titleCode, rdjb: collection.rdjb,
    owner: assignment.enterpriseId, uscc,
    mask: observation.candidateScopeMask,
    ...(readFacts ? {
      sourceValues: observation.sourceValues,
      applyVersion: { id: apply.id, status: apply.status, declarationYear: apply.declarationYear },
      businessVersion: { id: business.id, status: business.status, businessYear: business.businessYear, batch: business.batch },
    } : {}),
  }).from(observation)
    .innerJoin(collection, eq(collection.id, observation.collectionId))
    .innerJoin(first, and(eq(first.observationId, observation.id), eq(first.revision, 1)))
    .innerJoin(assignment, and(eq(assignment.observationId, observation.id), eq(assignment.revision, latestRevision)))
    .where(and(isCurrentPlatformObservation(db), or(inArray(assignment.enterpriseId, ids), codes.length
      ? and(isNull(assignment.enterpriseId), qualificationUsccCandidate(sql`${uscc}`, codes)) : undefined)))
    .orderBy(observation.publicId)
  const rows = await (readFacts ? query
    .leftJoin(business, eq(business.versionId, observation.versionId))
    .leftJoin(apply, eq(apply.versionId, observation.versionId)) : query)
  const exact = rows.flatMap(row => {
    const owners = row.owner !== null ? [row.owner] : (byUscc.get(normalizeUscc(row.uscc)) ?? []).map(item => item.id)
    return owners.map(owner => ({ ...row, owner }))
  })
  const pageCollections = hydrated ? [] : [...new Set(exact.filter(row => row.rdjb.includes(',')).map(row => row.collectionId))]
  const page = platformCollectionPage
  const pages = pageCollections.length ? await db.select({
    collectionId: page.collectionId, status: page.status, sequenceStart: page.sequenceStart,
    sequenceEnd: page.sequenceEnd, rdjb: page.rdjb,
  // This set covers all observations of the batch and can exceed the bind limit.
  }).from(page).where(sql`${page.collectionId} = ANY(${pgIds(pageCollections)})`).orderBy(page.ordinal) : []
  const byOwner = Map.groupBy(exact, row => row.owner)
  return (owner: number, title: CurrentTitle): PlatformEffect[] => {
    const available = byOwner.get(owner) ?? []
    const selected = hydrated ? available.filter(row => {
      if (row.mask === null) throw new Error('Current hydration candidate capture unavailable')
      return Boolean(row.mask & titleScopeBits[title])
    }) : platformEffectsForTitle(available, pages, title)
    return selected.map(row => {
      const source = row.interface as PlatformInterface
      const version = source === 'apply_list' ? row.applyVersion : row.businessVersion
      const defaults = platformObservationVersionDefaults(source, version ?? null)
      const values = row.sourceValues ?? null
      return {
        id: row.id, queryId: row.queryId, interface: source, queriedAt: row.queriedAt,
        year: platformObservationSourceValue(values, defaults, 'year') as number | null,
        batch: platformObservationSourceValue(values, defaults, 'batch') as string | null,
        status: platformObservationSourceValue(values, defaults, 'status') as string | null,
      }
    })
  }
}

async function readQualificationInputs(tx: PostgresQualificationTransaction, enterpriseIds: readonly number[], asOf: number,
  selectionScope?: { mode: 'scan' | 'detail' | 'roster-detail' | 'workbook' | 'classify'; title: CurrentTitle }, readPlatform = createPostgresPlatformQualificationReader(tx)) {
  if (!enterpriseIds.length) return []
  const selection = await readEnterprises(tx, enterpriseIds)
  if (!selection.length) return []
  const subjects = [...new Map(selection.map(({ enterprise }) => [enterprise.id, enterprise])).values()]
  const ids = subjects.map(enterprise => enterprise.id)
  const events = await tx.select({
    owner: record.enterpriseId, title: record.titleCode, recordId: recordEvent.recordId, value: recordEvent.formalValidity,
    event: {
      id: recordEvent.id, eventType: recordEvent.eventType, year: recordEvent.year, decidedYear: recordEvent.decidedYear,
      batchSeq: recordEvent.batchSeq, reviewOutcome: recordEvent.reviewOutcome, revision: recordEvent.revision,
      nameRaw: record.nameRaw, usccRaw: record.usccRaw, source: record.source,
    },
  }).from(record).innerJoin(recordEvent, eq(recordEvent.recordId, record.id))
    .where(inArray(record.enterpriseId, ids)).orderBy(recordEvent.id)
  const revision = officialEvidenceRowRevision
  const latestCapture = tx.select({ revision: revision.revision, sha256: revision.sha256 }).from(revision)
    .where(eq(revision.evidenceId, recordEvidence.id)).orderBy(desc(revision.revision)).limit(1).as('capture')
  const evidence = await tx.select({
    owner: record.enterpriseId, title: record.titleCode,
    evidence: {
      id: recordEvidence.id, eventId: recordEvidence.recordEventId, sourceFile: recordEvidence.sourceFile,
      attachment: recordEvidence.attachment, listNo: recordEvidence.listNo, page: recordEvidence.page,
    },
    file: { id: storedFile.id, sha256: storedFile.sha256, bytes: storedFile.bytes, removedAt: storedFile.removedAt },
    captureRevision: latestCapture.revision, captureSha256: latestCapture.sha256,
  }).from(record)
    .innerJoin(recordEvent, eq(recordEvent.recordId, record.id))
    .innerJoin(recordEvidence, eq(recordEvidence.recordEventId, recordEvent.id))
    .leftJoin(storedFile, eq(storedFile.relPath, recordEvidence.sourceFile))
    .leftJoinLateral(latestCapture, isNotNull(latestCapture.revision))
    .where(inArray(record.enterpriseId, ids)).orderBy(recordEvidence.id)
  const aliases = await tx.select({
    owner: enterpriseAlias.enterpriseId,
    alias: { id: enterpriseAlias.id, name: enterpriseAlias.name, version: enterpriseAlias.version },
  }).from(enterpriseAlias)
    .where(and(inArray(enterpriseAlias.enterpriseId, ids), eq(enterpriseAlias.verificationStatus, 'confirmed')))
    .orderBy(enterpriseAlias.id)
  // Follow predecessor merges in one recursive set, deduplicating owner/ID
  // pairs as before. Drizzle does not expose WITH RECURSIVE.
  const members = sql`(
    WITH RECURSIVE members(owner, id) AS (
      SELECT requested, requested FROM unnest(${pgIds(ids)}) AS input(requested)
      UNION
      SELECT i.owner, ${enterpriseMerge.fromEnterpriseId} FROM ${enterpriseMerge}
      JOIN members i ON ${enterpriseMerge.intoEnterpriseId} = i.id
    )
    SELECT owner, id FROM members
  ) members`
  const fact = enterpriseFactRevision
  const facts = await tx.select({
    owner: sql<number>`members.owner`.mapWith(Number),
    fact: { enterpriseId: fact.enterpriseId, factId: fact.factId, revision: fact.revision, status: fact.status, fact: fact.fact, basis: fact.basis },
  }).from(fact).innerJoin(members, eq(fact.enterpriseId, sql`members.id`)).orderBy(fact.id)
  const dispositions = await readDispositions(tx, ids)
  const platformFacts = await readPlatform(subjects)
  const scanning = selectionScope?.mode === 'scan'
  const classifying = selectionScope?.mode === 'classify'
  const effectScope = selectionScope?.mode === 'detail' || selectionScope?.mode === 'workbook' ? 'hydration'
    : selectionScope?.mode === 'roster-detail' ? 'roster-detail' : 'references'
  const platformEffects = scanning || classifying ? undefined : await readPlatformEffects(tx, subjects, effectScope)
  const correspondence = classifying ? [] : await readPostgresCorrespondenceRefs(tx, ids, scanning ? selectionScope.title : undefined)
  const witnesses = selectionScope?.mode === 'detail' || scanning ? await readPostgresRecognizedWitnesses(tx, [...new Set(correspondence.flatMap(ref =>
    ref.type === 'event_recognized' && ref.role === 'recognized_corrob' && ref.status === 'confirmed' && !ref.requiresRevalidation
      && ref.relationId !== null ? [ref.relationId] : []))]) : undefined
  const eventsByOwner = Map.groupBy(events, row => row.owner)
  const evidenceByOwner = Map.groupBy(evidence, row => row.owner)
  const referencesByOwner = Map.groupBy(correspondence, row => row.enterpriseId)
  const aliasesByOwner = Map.groupBy(aliases, row => row.owner)
  const factsByOwner = Map.groupBy(facts, row => row.owner)
  const byCanonical = new Map(subjects.map(enterprise => {
    const { id } = enterprise
    const ownerEvidence = evidenceByOwner.get(id) ?? []
    const refsByTitle = Map.groupBy(referencesByOwner.get(id) ?? [], row => row.titleCode)
    const rowsByTitle = Map.groupBy(eventsByOwner.get(id) ?? [], row => row.title)
    const evidenceByTitle = Map.groupBy(ownerEvidence, row => row.title)
    const files = new Map<string, CandidateFile>(ownerEvidence.flatMap(row => row.file
      ? [[row.evidence.sourceFile, { ...row.file, bytes: Number(row.file.bytes) }]] : []))
    const captures = new Map(ownerEvidence.flatMap(row => row.captureRevision === null ? [] : [
      [row.evidence.id, { revision: row.captureRevision, sha256: row.captureSha256 }] as const,
    ]))
    const factRows: EnterpriseFactEffectRow[] = (factsByOwner.get(id) ?? []).map(row => row.fact)
    const aliasRows = (aliasesByOwner.get(id) ?? []).map(row => row.alias)
    const inputs = new Map(CURRENT_TITLES.map(title => {
      const titleEvents = rowsByTitle.get(title) ?? []
      const effects = platformEffects?.(id, title) ?? []
      const refs = refsByTitle.get(title) ?? []
      const input: LoadedCurrentQualificationInput = {
        enterprise,
        events: titleEvents.map(row => row.event as CandidateEvent),
        evidence: (evidenceByTitle.get(title) ?? []).map(row => row.evidence),
        readValidityRows: () => titleEvents.map(row => ({ id: row.event.id, recordId: row.recordId, value: row.value })),
        readFile: path => files.get(path),
        readAliases: () => aliasRows,
        readDispositions: () => dispositions.get(id)?.map(row => row.input) ?? [],
        platformReferences: effects.map(({ id, queryId, interface: kind, queriedAt }) => ({ id, queryId, interface: kind, queriedAt })),
        ...(selectionScope ? { readWitnesses: witnesses, readCorrespondences: () => refs }
          : { correspondenceReferences: () => refs.map(formatQualificationCorrespondence) }),
        ...(effectScope !== 'references' ? { readPlatformEffects: () => effects } : {}),
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

async function prepareDetailedQualificationSources(tx: PostgresQualificationTransaction,
  loaded: Awaited<ReturnType<typeof readQualificationInputs>>, titles: readonly CurrentTitle[], receiptRuntime?: ReceiptRuntimeContext) {
  const owners = [...new Map(loaded.map(([, inputs]) => {
    const subject = inputs.get(titles[0]!)!.enterprise
    return [subject.id, subject] as const
  })).values()]
  const coverage = await readPostgresQueryCoverage(tx, owners, titles)
  const redact = await importPostgresReceiptRedactor(tx, {}, receiptRuntime)
  const eventIds = [...new Set(loaded.flatMap(([, inputs]) => titles.flatMap(title => inputs.get(title)!.evidence.map(row => row.eventId))))]
  const readPublished = createPostgresPublishedPresentationReader(tx, redact, eventIds)
  for (const [, inputs] of loaded) {
    for (const title of titles) {
      const input = inputs.get(title)!
      const scope = input.evidence.map(row => ({ evidenceId: row.id, eventId: row.eventId }))
      try {
        const facts = await readPublished(scope)
        input.readPublishedNames = () => [...facts.values()]
      } catch (error) {
        input.readPublishedNames = () => { throw officialPublishedError(error) }
      }
      input.readCoverage = () => coverage.get(input.enterprise.id)!.get(title)!
    }
  }
  return { coverage, readPublished }
}

async function readPostgresDetailedAssessments(tx: PostgresQualificationTransaction, ids: readonly number[], title: CurrentTitle, asOf: number, mode: 'detail' | 'workbook', readPlatform?: PostgresPlatformQualificationReader, receiptRuntime?: ReceiptRuntimeContext) {
  const hydrated: [number, { rows: import('./current-qualification').CurrentRow[];
    snapshot: ReturnType<typeof currentQualificationSnapshot>; publishedPresentation?: PublishedPresentation;
    workbookPublished: Map<number, OfficialPublishedFact> }][] = []
  if (!ids.length) return new Map(hydrated)
  const loaded = await readQualificationInputs(tx, ids, asOf, { mode, title }, readPlatform)
  const titles = mode === 'workbook' ? CURRENT_TITLES.slice(0, CURRENT_TITLES.indexOf(title) + 1) : CURRENT_TITLES
  const { readPublished } = await prepareDetailedQualificationSources(tx, loaded, titles, receiptRuntime)
  for (const [id, inputs] of loaded) {
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
        const facts = await readPublished(presentationScope)
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

export function readPostgresCurrentWorkbookBatch(tx: PostgresQualificationTransaction, ids: readonly number[], title: CurrentTitle, asOf: number, readPlatform?: PostgresPlatformQualificationReader, receiptRuntime?: ReceiptRuntimeContext) {
  return readPostgresDetailedAssessments(tx, ids, title, asOf, 'workbook', readPlatform, receiptRuntime)
}

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

export async function readPostgresEffectiveQualifications(tx: PostgresQualificationTransaction, enterpriseId: number, asOf: number): Promise<EffectiveQualification[] | null> {
  const read = await readPostgresCurrentQualification(tx, enterpriseId, asOf)
  return read === null ? null : projectEffectiveQualifications(read.titles)
}

export async function readPostgresDifferenceQualifications(tx: PostgresQualificationTransaction, ids: readonly number[], asOf: number) {
  const loaded = await readQualificationInputs(tx, ids, asOf, { mode: 'detail', title: 'specialized_sme' })
  const { coverage } = await prepareDetailedQualificationSources(tx, loaded, CURRENT_TITLES)
  return {
    coverage,
    assessed: loaded.flatMap(([enterpriseId, inputs]) =>
      [...evaluateLoadedCurrentQualification(asOf, inputs).values()].map(result => ({ enterpriseId, assessment: result.row.assessment! }))),
    facts: loaded.flatMap(([, inputs]) => inputs.get('specialized_sme')!.readPlatformFacts()),
  }
}

export async function readPostgresRosterDetailQualification(tx: PostgresQualificationTransaction,
  requestedId: number, asOf: number, copies: (enterpriseId:number)=>Promise<OfficialPublishedScope[]>) {
  const loaded = await readQualificationInputs(tx, [requestedId], asOf, { mode: 'roster-detail', title: 'specialized_sme' })
  const inputs = loaded[0]?.[1]
  if (!inputs) return null
  const input = inputs.get('specialized_sme')!
  const owner = input.enterprise.id
  const displayScope = await copies(owner)
  const coverage = await readPostgresQueryCoverage(tx, [input.enterprise], CURRENT_TITLES)
  const redact = await importPostgresReceiptRedactor(tx)
  const readPublished = createPostgresPublishedPresentationReader(tx,redact)
  const scope = [...inputs.values()].flatMap(facts=>facts.evidence).sort((a,b)=>a.id-b.id)
    .map(row=>({ evidenceId:row.id,eventId:row.eventId }))
  let publishedPresentation: PublishedPresentation
  let facts: OfficialPublishedFact[] | undefined
  let failure: unknown
  try { facts = [...(await readPublished(scope)).values()] }
  catch (error) { failure = officialPublishedError(error) }
  for (const [title, source] of inputs) {
    source.readPublishedNames = () => { if (failure) throw failure; return facts! }
    source.readCoverage = () => coverage.get(owner)!.get(title)!
  }
  const assessed = [...evaluateLoadedCurrentQualification(asOf,inputs).values()].map(result=>result.row.assessment!)
  try {
    if (failure) throw failure
    publishedPresentation = projectOfficialPublishedNames(facts!,displayScope)
  } catch (error) {
    publishedPresentation = { availability:'unavailable',error:officialPublishedError(error).code,facts:[] }
  }
  return { snapshot:currentQualificationSnapshot(owner,asOf,assessed),coverage,
    platformFacts:input.readPlatformFacts(),publishedPresentation }
}

export async function readPostgresLegacyQualification(tx: PostgresQualificationTransaction, enterpriseId: number, asOf: number) {
  const loaded = await readQualificationInputs(tx, [enterpriseId], asOf, { mode: 'detail', title: 'specialized_sme' })
  const inputs = loaded[0]?.[1]
  if (!inputs) throw new Error('Qualification enterprise not found')
  const owner = inputs.get('specialized_sme')!.enterprise.id
  const { coverage } = await prepareDetailedQualificationSources(tx, loaded, CURRENT_TITLES)
  const heads = await readPostgresQualificationDecisionHeads(tx, owner, CURRENT_TITLES)
  const active = heads.filter(row => row.lifecycleAction !== 'withdraw' && row.verificationStatus === 'confirmed' && row.status === 'confirmed_reason'
    && !['pending_review','platform_stale','renamed'].includes(row.reasonCode ?? ''))
  const assessments = await readPostgresQueryAssessments(tx, active.map(row => ({
    enterpriseId: owner, titleCode: row.titleCode, direction: row.direction as 'missing_in_miit' | 'extra_in_miit',
  })), coverage)
  const byScope = new Map(assessments.map(result => [result.currentDecision.titleCode + ':' + result.currentDecision.direction, result]))
  const observations = await readPostgresDifferenceObservations(tx, active.flatMap(row => row.evidenceRelationId === null ? [] : [row.evidenceRelationId]))
  const d = differenceReason
  const receipts = active.length ? await tx.selectDistinctOn([d.id], {
    id: d.id, receipt: { basis: d.basis, effectiveAt: d.effectiveAt },
    kind: importBatch.sourceKind, summary: importBatch.summary,
  }).from(d).innerJoin(importBatch, reviewTarget(d.id)).where(inArray(d.id, active.map(row => row.id)))
    .orderBy(d.id, desc(importBatch.id)) : []
  const byDecision = new Map(receipts.map(row => [row.id, row.kind === maintainedDifferenceKind
    ? (JSON.parse(row.summary!) as { qualification: typeof row.receipt }).qualification : row.receipt] as const))
  const projected = new Map<CurrentTitle, LegacyQualificationInput>([...inputs].map(([title, input]) => [title, {
    ...input,
    readLegacyHeads: () => heads,
    readLegacyAssessment: (target, direction) => byScope.get(target + ':' + direction)!,
    readLegacyReceipt: id => byDecision.get(id) as ReturnType<NonNullable<LegacyQualificationInput['readLegacyReceipt']>>,
    readLegacyObservation: id => observations.get(id),
  }]))
  return assessLegacyQualificationInputs(enterpriseId, asOf, projected)
}
