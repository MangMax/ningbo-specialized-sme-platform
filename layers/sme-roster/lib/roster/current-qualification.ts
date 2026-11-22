import { readTitleCycleDispositionInputs } from './title-cycle-disposition-inputs'
import { type PlatformQualificationFact, type PlatformQualificationFactsReader } from './platform-qualification'
import { readPlatformQualificationFacts } from './platform-qualification-sqlite'
import type { RecognizedWitnessReader } from './recognized-witness-reader'
import { createCurrentAssessmentInputs, type CurrentAssessmentInputs } from './current-assessment-inputs'
import { readEnterpriseFactEffects, evaluateEnterpriseFactEffects } from './enterprise-fact-effects'
import { canonicalEnterpriseId, hasEnterpriseMergeIdentity } from './enterprise-identity'
import { readPlatformComparisonProcesses } from '../../server/utils/platform-comparison-input'
import type { ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createDrizzleLogger } from '../../../core/lib/logging/drizzle'
import { eq, sql } from 'drizzle-orm'
import * as schema from '../../../../db/schema'
import { listRecordCorrespondenceRefs, createEnterpriseTitleCorrespondenceRefsReader } from '../../server/utils/record-correspondence'
import type Database from 'better-sqlite3'
import { projectOfficialPublishedNames, OfficialPublishedPresentationError, type OfficialPublishedFact, type OfficialPublishedScope } from './official-published-presentation'
import { readOfficialPublishedPresentation } from './official-published-presentation-sqlite'
import type { PublishedPresentation } from './correspondence-view'
import { identityFunctions } from './enterprise-read-snapshot'
import { readQueryAssessment, readQueryCoverage, readQueryCoverageBatch, readQueryComparisonWitnesses } from './query-assessment'
import { readDifferenceObservation } from '../platform/difference-sources'
import { differencePublicColumns } from '../platform/difference-reference-target'
import { readDifferencePlatformEffects, readDifferencePlatformEffectsByTitle } from './difference-platform-effects'
import type { IdentityKeyVariants } from './current-identity-keys'
import { createTargetRecognizedWitnessReader } from './recognized-witness-target'
import { targetSchema } from '../platform/target-schema'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'
import { projectEffectiveQualifications, type EffectiveQualification } from './effective-qualifications'
import { comparePlatformComparison, COMPARISON_VERSION, type CandidateComparisonInput } from './platform-comparison'
import {
  CURRENT_RULE_VERSION, LEGACY_CURRENT_RULE_VERSION, LEGACY_QUALIFICATION_ASSESSMENT_VERSION, qualificationDay,
  PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION, INDEPENDENT_QUALIFICATION_ASSESSMENT_VERSION,
  FROZEN_HIGHEST_HONOR_ASSESSMENT_VERSION, QUALIFICATION_ASSESSMENT_VERSION, assessmentDigest, evaluateCandidate, projectComparisonCycles,
  type PublishedNameAssessmentInput, type CurrentCycleObservation, type CurrentPublishedNameObservation, type QualificationAssessmentReadOptions,
  type CurrentQualificationSnapshot, type CurrentRow, type CurrentWorkbookFacts, type CurrentPlatformReference, type CandidateEvent,
  type CandidateFile, type CandidateResult, type CandidateDetail, type CandidateSource,
} from './current-qualification-model'

export * from './current-qualification-model'

const readers = new WeakMap<Database.Database, ReturnType<typeof drizzle<typeof schema>>>()
export function prepareCurrentReader(db: Database.Database) {
  let reader=readers.get(db)
  if (!reader) { reader=drizzle(db,{schema,logger:createDrizzleLogger({connection:'current_qualification'})}); readers.set(db,reader) }
  identityFunctions(reader)
  return reader
}
/** A bounded enterprise × title projection; source blobs never enter this reader. */
export function readCurrentCandidate(db: Database.Database, enterpriseId: number, title: CurrentTitle, year: number, executionTime = Date.now(), keys?: { queries: IdentityKeyVariants; relations: IdentityKeyVariants }, includeFilterFacts = false): CurrentRow {
  return createCurrentCandidateReader(db)(enterpriseId,title,year,executionTime,keys,includeFilterFacts)
}

/** One enterprise, one SQLite snapshot, one execution time; never creates facts or decisions.
 * asOf is the evaluation time of the current stored facts, not a historical replay.
 */
export function readCurrentQualificationAssessment(db: Database.Database, enterpriseId: number, asOf = Date.now(), options: QualificationAssessmentReadOptions = {}): CurrentQualificationSnapshot {
  return createCurrentQualificationAssessmentReader(db).read(enterpriseId, asOf, options).snapshot
}

/** Request-owned statements, never a result cache. The scan projection omits
 * display references; only read() publishes a complete three-title snapshot.
 * Both paths execute the same adjudication. Default read options and digests
 * remain those of readCurrentQualificationAssessment.
 */
export function createCurrentQualificationAssessmentReader(db: Database.Database, receiptRuntime?: ReceiptRuntimeContext) {
  return createCurrentQualificationAssessmentReaderBody(db,receiptRuntime,createTargetRecognizedWitnessReader(drizzle(db,{schema:targetSchema})))
}

/** Explicit same-connection witnesses and optional caller-snapshot fact reader. */
export function createCurrentQualificationAssessmentReaderWithWitnesses(db:Database.Database,witnesses:RecognizedWitnessReader,receiptRuntime?:ReceiptRuntimeContext,platformFactsReader?:PlatformQualificationFactsReader) {
  if(witnesses.connection!==db)throw new Error('Recognized witnesses require the same SQLite connection')
  return createCurrentQualificationAssessmentReaderBody(db,receiptRuntime,witnesses,platformFactsReader)
}

function createCurrentQualificationAssessmentReaderBody(db:Database.Database,receiptRuntime:ReceiptRuntimeContext|undefined,witnesses:RecognizedWitnessReader,platformFactsReader?:PlatformQualificationFactsReader) {
  const evaluate = createCurrentCandidateEvaluationReader(db, receiptRuntime, witnesses, platformFactsReader)
  // Resolve the fixed schema binding before a caller starts a candidate iterator.
  // Only prepared statements are retained; correspondence rows remain read-local.
  const correspondenceReader = createEnterpriseTitleCorrespondenceRefsReader(prepareCurrentReader(db))
  type Reference = ReturnType<typeof correspondenceReader>[number]
  let referenceBatch: Map<number, Reference[]> | undefined
  const preparedCorrespondences = (enterpriseId: number, titleCode: string) => {
    const rows = referenceBatch?.get(enterpriseId)
    return rows ? rows.filter(row => row.titleCode === titleCode) : correspondenceReader(enterpriseId, titleCode)
  }
  const withinReferences = <T>(ids: readonly number[], read: () => T, titles?: readonly CurrentTitle[], scope?: 'recognition-witnesses'): T => {
    const previous = referenceBatch
    const refs = correspondenceReader.readBatch(ids, titles, scope)
    referenceBatch = new Map(ids.map(id => [id, refs.filter(row => row.enterpriseId === id)]))
    const relationIds = refs.flatMap(row => row.type === 'event_recognized' && row.role === 'recognized_corrob' && row.status === 'confirmed' && !row.requiresRevalidation && row.relationId != null ? [row.relationId] : [])
    try { return witnesses.withinBatch ? witnesses.withinBatch(relationIds, read) : read() }
    finally { referenceBatch = previous }
  }
  // Only statement handles survive this request. Reference rows/maps belong to
  // one readSnapshot invocation and are discarded after its three title reads.
  const readHydrationReferences = (enterpriseId: number) => {
    const reader=prepareCurrentReader(db)
    const effects=readDifferencePlatformEffectsByTitle(reader,enterpriseId)
    const references=new Map<CurrentTitle,CurrentPlatformReference[]>(CURRENT_TITLES.map(title=>[
      title,effects.get(title)!.map(({id,queryId,interface:kind,queriedAt})=>({id,queryId,interface:kind,queriedAt})),
    ]))
    return {references,effects}
  }
  const readSnapshotBody = (enterpriseId: number, asOf: number, options: QualificationAssessmentReadOptions, filterTitle?: CurrentTitle, presentationTitle?: CurrentTitle, workbookTitle?: CurrentTitle, comparisons?: ReadonlyMap<CurrentTitle, CurrentCycleObservation>, assessedTitle?: CurrentTitle) => {
    const readOptions = options
    // No filterTitle means the existing default reader follows its original SQL.
    const hydration = filterTitle == null && workbookTitle == null ? undefined : readHydrationReferences(enterpriseId)
    const references = hydration?.references
    let publishedPresentation: PublishedPresentation | undefined
    let presentationScope: readonly OfficialPublishedScope[] | undefined
    const unavailable = (error: unknown): PublishedPresentation => ({ availability: 'unavailable', error: error instanceof OfficialPublishedPresentationError ? error.code : 'read_failed', facts: [] })
    const observePublishedForCurrent: CurrentPublishedNameObservation = (scope, selected, input, sourceError) => {
      presentationScope = selected
      // Reuse only the exact ordered scope. Broader/narrower reads retain their
      // independent validation/error order; never shrink a full T2 source read.
      if (scope.length !== selected.length || scope.some((item, i) => item.evidenceId !== selected[i]!.evidenceId || item.eventId !== selected[i]!.eventId)) return
      if (input.availability === 'unavailable') { publishedPresentation = unavailable(sourceError); return }
      try { publishedPresentation = projectOfficialPublishedNames(input.facts, selected, 1, 2) }
      catch (error) { publishedPresentation = unavailable(error) }
    }
    // Per-call, owned verified output only. Nothing is cached on the reader.
    let workbookScope: readonly OfficialPublishedScope[] | undefined
    let workbookPublished: ReadonlyMap<number, OfficialPublishedFact> | undefined
    let workbookSourceError: unknown
    const observePublishedForWorkbook: CurrentPublishedNameObservation = (scope, selected, input, sourceError) => {
      workbookScope = selected
      if (scope.length !== selected.length || scope.some((item, i) => item.evidenceId !== selected[i]!.evidenceId || item.eventId !== selected[i]!.eventId)) return
      if (input.availability === 'unavailable') {
        workbookSourceError = sourceError instanceof OfficialPublishedPresentationError ? sourceError : new OfficialPublishedPresentationError('read_failed')
      } else {
        workbookPublished = new Map(input.facts.map(fact => [fact.evidenceId, fact]))
      }
    }
    // Owned by this invocation and its pinned snapshot, never by the reader.
    // The giant has no inherited dependency; its v4 and independent v3 facts
    // are identical. Preserve public title order while sharing the full result.
    let giant: CurrentRow | undefined
    let specialized: CurrentRow | undefined
    const evaluateTitle = (title: CurrentTitle) => evaluate(enterpriseId, title, (readOptions.assessmentVersion === LEGACY_QUALIFICATION_ASSESSMENT_VERSION ? new Date(asOf).getUTCFullYear() : Number(qualificationDay(asOf).slice(0,4))), asOf, undefined, title === filterTitle, true, readOptions, title === filterTitle, references?.get(title), references == null ? undefined : preparedCorrespondences, title === workbookTitle ? observePublishedForWorkbook : title === presentationTitle ? observePublishedForCurrent : undefined, comparisons?.get(title), { giant, specialized, platformEffects:hydration?.effects?.get(title) }).row
    if (!readOptions.assessmentVersion || readOptions.assessmentVersion === QUALIFICATION_ASSESSMENT_VERSION || readOptions.assessmentVersion === FROZEN_HIGHEST_HONOR_ASSESSMENT_VERSION) giant = evaluateTitle('little_giant')
    if ((!assessedTitle || assessedTitle !== 'little_giant') && (!readOptions.assessmentVersion || readOptions.assessmentVersion === QUALIFICATION_ASSESSMENT_VERSION)) specialized = evaluateTitle('specialized_sme')
    const rows = (assessedTitle ? [assessedTitle] : CURRENT_TITLES).map(title => title === 'little_giant' && giant ? giant : title === 'specialized_sme' && specialized ? specialized : evaluateTitle(title))
    if (presentationTitle != null && publishedPresentation === undefined) {
      if (presentationScope === undefined) throw new Error('Current published-name scope was not evaluated')
      try {
        const facts = readOfficialPublishedPresentation(prepareCurrentReader(db), presentationScope, undefined, receiptRuntime)
        publishedPresentation = projectOfficialPublishedNames([...facts.values()], presentationScope, 1, 2)
      } catch (error) { publishedPresentation = unavailable(error) }
    }
    if (workbookTitle != null) {
      if (workbookScope === undefined) throw new Error('Workbook published-name scope was not evaluated')
      // Same ordered scope: retain typed failure without retry. A different scope
      // keeps its own independent validation and error order, within this read.
      if (workbookSourceError !== undefined) throw workbookSourceError
      workbookPublished ??= readOfficialPublishedPresentation(prepareCurrentReader(db), workbookScope, undefined, receiptRuntime)
    }
    const titles = rows.map(row => row.assessment!)
    const scope = { enterpriseId, asOf: new Date(asOf).toISOString(), ruleVersion: readOptions.assessmentVersion === LEGACY_QUALIFICATION_ASSESSMENT_VERSION ? LEGACY_CURRENT_RULE_VERSION : readOptions.assessmentVersion === PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION ? 'current-roster-116-v9' : readOptions.assessmentVersion === INDEPENDENT_QUALIFICATION_ASSESSMENT_VERSION ? 'current-roster-116-v10' : readOptions.assessmentVersion === FROZEN_HIGHEST_HONOR_ASSESSMENT_VERSION ? 'current-roster-116-v11' : CURRENT_RULE_VERSION, assessmentVersion: readOptions.assessmentVersion ?? QUALIFICATION_ASSESSMENT_VERSION }
    return { rows, snapshot: { ...scope, snapshotId: assessmentDigest([scope, titles]), titles }, ...(publishedPresentation === undefined ? {} : { publishedPresentation }), ...(workbookPublished === undefined ? {} : { workbookPublished }) }
  }
  // Preserve the original default wrapper, including caller-owned SAVEPOINT semantics.
  const readSnapshot = db.transaction(readSnapshotBody)
  const readWorkbookBatch = (ids: readonly number[], asOf: number, title: CurrentTitle, queryKeys: IdentityKeyVariants | undefined, scoped: boolean) => {
    const titles = scoped ? [...new Set<CurrentTitle>(['little_giant', ...(title === 'innovative_sme' ? ['specialized_sme' as const] : []), title])] : CURRENT_TITLES
    return evaluate.withinBatch(ids, inputs => withinReferences([...inputs.canonical.values()], () => {
      const coverages = readQueryCoverageBatch(prepareCurrentReader(db), ids.flatMap(enterpriseId => titles.map(titleCode => ({ enterpriseId, titleCode, direction: 'missing_in_miit' as const }))), queryKeys)
      return ids.map(id => {
        const options: QualificationAssessmentReadOptions = { coverageForTitle: titleCode => coverages.get(id)!.get(titleCode)! }
        const read = readSnapshot(id, asOf, options, undefined, undefined, title, undefined, scoped ? title : undefined)
        if (read.workbookPublished === undefined) throw new Error('Workbook published-name facts missing')
        return { ...read, workbookPublished: read.workbookPublished }
      })
    }, titles))
  }
  const comparisonCollector = () => {
    let cycles: CandidateComparisonInput['formal']['cycles'] = []
    const collect: CurrentCycleObservation = (judgments, formal) => {
      cycles = projectComparisonCycles(judgments, formal)
    }
    return { collect, cycles: () => cycles }
  }
  // Only this reader's owned full snapshot and observed cycles enter this seam.
  const compareOwnedSnapshot = (enterpriseId: number, title: CurrentTitle, legacy: CurrentQualificationSnapshot, cycles: CandidateComparisonInput['formal']['cycles']) => {
    const assessment = legacy.titles.find(item => item.titleCode === title)!
    const { titleCode, group, officialQualification, subject, region, versions, evidence, sourceVersions, completeness, correspondence } = assessment
    const queries = readQueryComparisonWitnesses(prepareCurrentReader(db), { enterpriseId, titleCode: title, direction: 'missing_in_miit' })
    const queryOnly: CandidateComparisonInput = { version: COMPARISON_VERSION, legacy, titleCode: title,
      formal: { assessment: { titleCode, group, officialQualification, subject, region, cycles: assessment.cycles,
        versions, evidence, sourceVersions, completeness, correspondence }, cycles }, queries, processes: [] }
    // Dispatch this necessarily invalid join to its original authority. Preserve
    // earlier guards and error priority; never manufacture a preliminary result.
    if (cycles.length > 40) return comparePlatformComparison(queryOnly)
    const processes = readPlatformComparisonProcesses(db, { enterpriseId, titleCode: title, eventIds: cycles.flatMap(cycle => cycle.eventIds), selectedQueryIds: queries.sources.map(query => query.source.queryId) })
    return comparePlatformComparison({ ...queryOnly, processes })
  }
  const readComparison = db.transaction((enterpriseId: number, asOf: number, title: CurrentTitle) => {
    const collector = comparisonCollector()
    const { snapshot: legacy } = readSnapshotBody(enterpriseId, asOf, { assessmentVersion: LEGACY_QUALIFICATION_ASSESSMENT_VERSION }, undefined, undefined, undefined, new Map([[title, collector.collect]]))
    return compareOwnedSnapshot(enterpriseId, title, legacy, collector.cycles())
  })
  const readComparisons = db.transaction((enterpriseId: number, asOf: number, titles: readonly CurrentTitle[]) => {
    const collectors = new Map(titles.map(title => [title, comparisonCollector()]))
    const observers = new Map([...collectors].map(([title, collector]) => [title, collector.collect]))
    const { snapshot } = readSnapshotBody(enterpriseId, asOf, { assessmentVersion: LEGACY_QUALIFICATION_ASSESSMENT_VERSION }, undefined, undefined, undefined, observers)
    const comparisons = titles.map(title => compareOwnedSnapshot(enterpriseId, title, snapshot, collectors.get(title)!.cycles()))
    return { snapshot, comparisons }
  })
  return {
    readPlatformComparisons(enterpriseId: number, asOf: number, titles: readonly CurrentTitle[]) {
      // Validate data descriptors before reading values: no caller iterator or
      // array-index accessor executes. The normalized array is reader-owned.
      if (!Array.isArray(titles)) throw new Error('invalid_comparison_titles')
      const length = Object.getOwnPropertyDescriptor(titles, 'length')
      if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 1) throw new Error('invalid_comparison_titles')
      const selected = new Set<CurrentTitle>()
      for (let index = 0; index < length.value; index++) {
        const item = Object.getOwnPropertyDescriptor(titles, String(index))
        if (!item || !('value' in item) || !CURRENT_TITLES.includes(item.value)) throw new Error('invalid_comparison_titles')
        selected.add(item.value)
      }
      return readComparisons(enterpriseId, asOf, CURRENT_TITLES.filter(title => selected.has(title)))
    },
    readPlatformComparison(enterpriseId: number, asOf: number, title: CurrentTitle) {
      // One snapshot; never open the default wrapper inside this transaction.
      // SQLite rejects busy caller iterators. No fallback, commit or retry.
      return readComparison(enterpriseId, asOf, title)
    },
    read(enterpriseId: number, asOf = Date.now(), options: QualificationAssessmentReadOptions = {}, filterTitle?: CurrentTitle) {
      return readSnapshot(enterpriseId, asOf, options, filterTitle)
    },
    /** Detail composition only: caller owns the enterprise transaction/asOf.
     * Complete verified inputs feed assessment; final display budgets run later.
     * Neither results nor platform facts survive this invocation.
     */
    readDetail(enterpriseId: number, asOf: number, copies: readonly OfficialPublishedScope[], options: Pick<QualificationAssessmentReadOptions, 'ownQueryIds' | 'coverageForTitle'> = {}) {
      return evaluate.withinBatch([enterpriseId], inputs => {
        const evidence = [...(inputs.evidence.get(enterpriseId)?.values() ?? [])].flat().sort((a, b) => a.id - b.id)
        const scope = evidence.map(row => ({ evidenceId: row.id, eventId: row.eventId }))
        let publishedNames: PublishedNameAssessmentInput
        let sourceError: unknown
        try {
          publishedNames = { availability: 'available', facts: [...readOfficialPublishedPresentation(prepareCurrentReader(db), scope, undefined, receiptRuntime).values()] }
        } catch (error) {
          sourceError = error
          publishedNames = { availability: 'unavailable', facts: [] }
        }
        const { snapshot } = readSnapshot(enterpriseId, asOf, { ...options, publishedNames })
        let publishedPresentation: PublishedPresentation
        try {
          if (sourceError !== undefined) throw sourceError
          publishedPresentation = projectOfficialPublishedNames(publishedNames.facts, copies)
        } catch (error) {
          publishedPresentation = { availability: 'unavailable', error: error instanceof OfficialPublishedPresentationError ? error.code : 'read_failed', facts: [] }
        }
        return { snapshot, platformFacts: inputs.platformFacts, publishedPresentation }
      })
    },
    readCurrent(enterpriseId: number, asOf: number, title: CurrentTitle, queryKeys?: IdentityKeyVariants) {
      // Reuse this snapshot's complete key variants for indexed three-title coverage.
      const options: QualificationAssessmentReadOptions = queryKeys === undefined ? {} : {
        coverageForTitle: titleCode => readQueryCoverage(prepareCurrentReader(db), { enterpriseId, titleCode, direction: 'missing_in_miit' }, queryKeys),
      }
      const read = readSnapshot(enterpriseId, asOf, options, title, title)
      if (read.publishedPresentation === undefined) throw new Error('Current published-name presentation missing')
      return { ...read, publishedPresentation: read.publishedPresentation }
    },
    readWorkbook(enterpriseId: number, asOf: number, title: CurrentTitle, queryKeys?: IdentityKeyVariants) {
      // Full default T2 SQL/options/context; no caller-provided sources or facts.
      const options: QualificationAssessmentReadOptions = queryKeys === undefined ? {} : {
        coverageForTitle: titleCode => readQueryCoverage(prepareCurrentReader(db), { enterpriseId, titleCode, direction: 'missing_in_miit' }, queryKeys),
      }
      const read = readSnapshot(enterpriseId, asOf, options, undefined, undefined, title)
      if (read.workbookPublished === undefined) throw new Error('Workbook published-name facts missing')
      return { ...read, workbookPublished: read.workbookPublished }
    },
    /** Count projection: correspondence diagnostics and platform filter witnesses
     * never participate in v10 eligibility. Full detail still uses readTitle. */
    readEffectiveTitle(enterpriseId: number, title: CurrentTitle, asOf: number) {
      const assessed = evaluate(enterpriseId, title, Number(qualificationDay(asOf).slice(0,4)), asOf, undefined, false, false, undefined, false, undefined, () => [])
      return { effectiveStatus: assessed.effectiveStatus, basis: assessed.row.basis }
    },
    readTitle(enterpriseId: number, title: CurrentTitle, asOf: number, keys?: { queries: IdentityKeyVariants; relations: IdentityKeyVariants }) {
      return evaluate(enterpriseId, title, Number(qualificationDay(asOf).slice(0,4)), asOf, keys, true, false, undefined, true, undefined, preparedCorrespondences)
    },
    readFilterCandidates(ids: readonly number[], title: CurrentTitle, asOf: number, keys: { queries: IdentityKeyVariants; relations: IdentityKeyVariants }, status: import('./current-status').CurrentStatus) {
      return evaluate.withinBatch(ids, inputs => {
        const minimal = ids.map(id => ({ id, ...evaluate(id, title, Number(qualificationDay(asOf).slice(0,4)), asOf, undefined, false, false, undefined, false, undefined, () => [], undefined, undefined, { qualificationOnly: true }) }))
        const needsWitnesses = (item: typeof minimal[number]) => item.effectiveStatus === 'effective' || item.effectiveStatus === status
        const owners = [...new Set(minimal.filter(needsWitnesses).map(item => inputs.canonical.get(item.id) ?? item.id))]
        return withinReferences(owners, () => minimal.map(item => {
          const assessed = needsWitnesses(item)
            ? evaluate(item.id, title, Number(qualificationDay(asOf).slice(0,4)), asOf, keys, true, false, undefined, true, undefined, preparedCorrespondences, undefined, undefined, { qualificationOnly: true })
            : item
          const { name, aliases, uscc, district, qualificationWitnesses } = assessed.row
          return { id: item.id, row: { name, aliases, uscc, district, qualificationWitnesses }, effectiveStatus: assessed.effectiveStatus }
        }), [title], 'recognition-witnesses')
      })
    },
    readEffectiveTitleSummaries(ids: readonly number[], asOf: number, title: CurrentTitle) {
      return evaluate.withinBatch(ids, () => new Map(ids.map(id => {
        const assessed = evaluate(id, title, Number(qualificationDay(asOf).slice(0,4)), asOf, undefined, false, false, undefined, false, undefined, () => [], undefined, undefined, { qualificationOnly: true })
        return [id, { effectiveStatus: assessed.effectiveStatus, basis: assessed.row.basis }]
      })))
    },
    readEffectiveTitles(ids: readonly number[], asOf: number, title: CurrentTitle) {
      return evaluate.withinBatch(ids, () => new Map(ids.map(id => [id,
        evaluate(id, title, Number(qualificationDay(asOf).slice(0,4)), asOf, undefined, false, false, undefined, false, undefined, () => [], undefined, undefined, { qualificationOnly: true }).effectiveStatus,
      ])))
    },
    /** One selected differences page, on the caller's transaction/asOf. Full
     * coverage also serves cross-title subject decisions; assessment hydration
     * is restricted to the requested title and its real inheritance dependencies. */
    readDifferenceBatch(scopes: readonly { enterpriseId: number; titleCode: string }[], asOf: number) {
      const ids = [...new Set(scopes.map(scope => scope.enterpriseId))]
      const coverages = readQueryCoverageBatch(prepareCurrentReader(db), ids.flatMap(enterpriseId => CURRENT_TITLES.map(titleCode => ({ enterpriseId, titleCode, direction: 'missing_in_miit' as const }))))
      const snapshots: { snapshot: CurrentQualificationSnapshot }[] = []
      const platformFacts: PlatformQualificationFact[] = []
      for (let offset = 0; offset < ids.length; offset += 100) {
        const chunk = ids.slice(offset, offset + 100)
        evaluate.withinBatch(chunk, inputs => withinReferences([...inputs.canonical.values()], () => {
          platformFacts.push(...inputs.platformFacts)
          for (const id of chunk) {
            const titles = CURRENT_TITLES.filter(title => scopes.some(scope => scope.enterpriseId === id && scope.titleCode === title))
            for (const title of titles) {
              const read = readSnapshot(id, asOf, { coverageForTitle: titleCode => {
                const coverage = coverages.get(id)?.get(titleCode)
                if (!coverage) throw new Error('Difference coverage scope missing')
                return coverage
              } }, title, undefined, undefined, undefined, title)
              snapshots.push({ snapshot: read.snapshot })
            }
          }
        }))
      }
      return { snapshots, platformFacts, coverages }
    },
    readCurrentBatch(ids: readonly number[], asOf: number, title: CurrentTitle, queryKeys?: IdentityKeyVariants) {
      return evaluate.withinBatch(ids, inputs => withinReferences([...inputs.canonical.values()], () => {
        const coverages = readQueryCoverageBatch(prepareCurrentReader(db), ids.flatMap(enterpriseId => CURRENT_TITLES.map(titleCode => ({ enterpriseId, titleCode, direction: 'missing_in_miit' as const }))), queryKeys)
        return ids.map(id => {
          const read = readSnapshot(id, asOf, { coverageForTitle: titleCode => coverages.get(id)!.get(titleCode)! }, title, title)
          if (read.publishedPresentation === undefined) throw new Error('Current published-name facts missing')
          return { ...read, publishedPresentation: read.publishedPresentation }
        })
      }))
    },
    readWorkbookBatch(ids: readonly number[], asOf: number, title: CurrentTitle, queryKeys?: IdentityKeyVariants) {
      return readWorkbookBatch(ids, asOf, title, queryKeys, false)
    },
    /** Export rows bind only their title and its actual giant dependency. */
    readWorkbookRowsBatch(ids: readonly number[], asOf: number, title: CurrentTitle, queryKeys?: IdentityKeyVariants) {
      return readWorkbookBatch(ids, asOf, title, queryKeys, true)
    },
    readFilterCandidate(enterpriseId: number, title: CurrentTitle, asOf: number, keys: { queries: IdentityKeyVariants; relations: IdentityKeyVariants }) {
      const { row, effectiveStatus } = evaluate(enterpriseId, title, Number(qualificationDay(asOf).slice(0,4)), asOf, keys, true, false, undefined, true, undefined, preparedCorrespondences, undefined, undefined, { qualificationOnly: true })
      // This projection cannot publish explanations or dependency versions.
      const { name, aliases, uscc, district, qualificationWitnesses } = row
      return { row: { name, aliases, uscc, district, qualificationWitnesses }, effectiveStatus }
    },
  }
}

/** Request-local prepared queries only: no rows or qualification results survive a read. */
export function createCurrentCandidateReader(db: Database.Database) {
  const evaluate = createCurrentCandidateEvaluationReader(db, undefined, createTargetRecognizedWitnessReader(drizzle(db,{schema:targetSchema})))
  // Preserve the previous public argument tuple; the output observer stays private.
  return (...args: [enterpriseId: number, title: CurrentTitle, year: number, executionTime?: number, keys?: { queries: IdentityKeyVariants; relations: IdentityKeyVariants }, includeFilterFacts?: boolean, includeReferences?: boolean, assessmentOptions?: QualificationAssessmentReadOptions, includePendingFilterFacts?: boolean, suppliedPlatformRefs?: readonly CurrentPlatformReference[], preparedCorrespondences?: (enterpriseId: number, titleCode: string) => ReturnType<ReturnType<typeof createEnterpriseTitleCorrespondenceRefsReader>>]) => evaluate(...args).row
}

function createCurrentCandidateEvaluationReader(db: Database.Database, receiptRuntime: ReceiptRuntimeContext | undefined, witnesses:RecognizedWitnessReader, platformFactsReader?:PlatformQualificationFactsReader) {
  const reader=prepareCurrentReader(db)
  const readPlatformFacts: PlatformQualificationFactsReader = platformFactsReader ?? (subjects => readPlatformQualificationFacts(reader, subjects))
  const mergedIdentities = hasEnterpriseMergeIdentity(reader)
  let batch: CurrentAssessmentInputs | undefined
  const statements = new Map<string, Database.Statement>()
  const statement = (text: string) => {
    let prepared = statements.get(text)
    if (!prepared) { prepared=db.prepare(text); statements.set(text,prepared) }
    return prepared
  }
  const d=schema.differenceReason
  // Same six #102 scopes and recordedAt/id descending head as latestDecision102.
  // Build/map the Drizzle query once, rather than rebuilding six queries per row.
  const headIds=sql.join(CURRENT_TITLES.flatMap(titleCode => (['missing_in_miit','extra_in_miit'] as const).map(direction =>
    sql`select (select id from difference_reason where enterprise_id=${sql.placeholder('enterpriseId')}
      and title_code=${titleCode} and direction=${direction} order by recorded_at desc,id desc limit 1)`)),sql` union all `)
  // Prepare only when an explicit legacy assessment requests this dependency.
  const prepareLegacyHeads = () => reader.select(differencePublicColumns(reader)).from(d).where(sql`${d.id} in (${headIds})`).prepare()
  let headsQuery: ReturnType<typeof prepareLegacyHeads> | undefined
  const legacyHeads = () => headsQuery ??= prepareLegacyHeads()
  function readCandidate(
    enterpriseId: number, title: CurrentTitle, year: number, executionTime = Date.now(),
    keys?: { queries: IdentityKeyVariants; relations: IdentityKeyVariants },
    includeFilterFacts = false, includeReferences = true, assessmentOptions?: QualificationAssessmentReadOptions,
    includePendingFilterFacts = false, suppliedPlatformRefs?: readonly CurrentPlatformReference[],
    preparedCorrespondences?: (enterpriseId: number, titleCode: string) => ReturnType<ReturnType<typeof createEnterpriseTitleCorrespondenceRefsReader>>,
    observePublishedForCurrent?: CurrentPublishedNameObservation, observeCycles?: CurrentCycleObservation,
    detail: CandidateDetail = {},
  ): CandidateResult {
    if (batch) enterpriseId = batch.canonical.get(enterpriseId) ?? enterpriseId
    else if (mergedIdentities) enterpriseId = canonicalEnterpriseId(reader, enterpriseId) ?? enterpriseId
    const enterprise = batch ? batch.enterprises.get(enterpriseId)! : statement('select id,name,name_norm,uscc_norm,district,city from enterprise where id=?').get(enterpriseId) as CandidateSource['enterprise']
    const events = batch ? (batch.events.get(enterpriseId)?.get(title) ?? []).map(({ enterpriseId: _owner, titleCode: _title, ...event }) => event) as CandidateEvent[] : statement(`select e.id,e.event_type as eventType,e.year,e.decided_year as decidedYear,e.batch_seq as batchSeq,e.review_outcome as reviewOutcome,e.revision,r.name_raw as nameRaw,r.uscc_raw as usccRaw,r.source from record r join record_event e on e.record_id=r.id where r.enterprise_id=? and r.title_code=? order by e.id`).all(enterpriseId,title) as CandidateEvent[]
    const evidence = batch ? (batch.evidence.get(enterpriseId)?.get(title) ?? []).map(({ enterpriseId: _owner, titleCode: _title, ...row }) => row) : statement(`select v.id,v.record_event_id as eventId,v.source_file as sourceFile,v.attachment,v.list_no as listNo,v.page from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id where r.enterprise_id=? and r.title_code=? order by v.id`).all(enterpriseId,title) as (CurrentWorkbookFacts['evidence'][number] & {id:number})[]
    const source: CandidateSource = {
      enterprise, events, evidence,
      readValidityRows: () => batch ? batch.validityRows.get(enterpriseId)?.get(title) ?? [] : statement(`select e.id,e.record_id as recordId,e.formal_validity as value from record_event e join record r on r.id=e.record_id where r.enterprise_id=? and r.title_code=? order by e.id`).all(enterpriseId,title) as {id:number;recordId:number;value:string|null}[],
      readFile: path => batch ? batch.files.get(path) : statement('select id,sha256,bytes,removed_at as removedAt from stored_file where rel_path=?').get(path) as CandidateFile | undefined,
      readAliases: () => batch ? (batch.aliases.get(enterpriseId) ?? []).map(({ enterpriseId: _owner, ...row }) => row) : statement("select id,name,version from enterprise_alias where enterprise_id=? and verification_status='confirmed' order by id").all(enterpriseId) as {id:number;name:string;version:number}[],
      readDispositions: () => (batch ? batch.dispositions : readTitleCycleDispositionInputs(reader, [enterpriseId])).get(enterpriseId) ?? [],
      readPlatformEffects: () => readDifferencePlatformEffects(reader, enterpriseId, title),
      readCorrespondences: () => listRecordCorrespondenceRefs(reader,{enterpriseId,titleCode:title}),
      readLegacyHeads: () => legacyHeads().all({enterpriseId}),
      readLegacyAssessment: (titleCode, direction) => readQueryAssessment(reader,{enterpriseId,titleCode,direction},keys?.queries,assessmentOptions?.coverageForTitle?.(titleCode as CurrentTitle)),
      readLegacyReceipt: id => statement('select basis,effective_at as effectiveAt from evidence_review_receipt_114 where decision_id=? and reviewed_revision_id is not null order by id desc limit 1').get(id) as {basis:string;effectiveAt:string}|undefined,
      readLegacyObservation: id => readDifferenceObservation(reader,id),
      readFactEffects: effectiveOnly => batch
        ? evaluateEnterpriseFactEffects(batch.facts.get(enterpriseId) ?? [], executionTime, effectiveOnly)
        : readEnterpriseFactEffects(db, enterpriseId, executionTime, statement, effectiveOnly),
      readPlatformFacts: () => batch ? batch.platformFacts : readPlatformFacts([{ enterpriseId, uscc: enterprise.uscc_norm ?? '' }]),
      readWitnesses: subject => witnesses.readMany(subject),
      readPublishedNames: scope => [...readOfficialPublishedPresentation(reader,scope,undefined,receiptRuntime).values()],
      readCaptureVersion: id => statement('select revision,sha256 from official_evidence_row_revision where evidence_id=? order by revision desc limit 1').get(id) as {revision:number;sha256:string|null}|undefined,
      readCoverage: () => readQueryCoverage(reader, {enterpriseId,titleCode:title,direction:'missing_in_miit'}, keys?.queries, assessmentOptions?.ownQueryIds),
    }
    return evaluateCandidate(source, readCandidate, enterpriseId, title, year, executionTime, keys, includeFilterFacts, includeReferences, assessmentOptions, includePendingFilterFacts, suppliedPlatformRefs, preparedCorrespondences, observePublishedForCurrent, observeCycles, detail)
  }

  return Object.assign(readCandidate, {
    withinBatch<T>(ids: readonly number[], read: (inputs: CurrentAssessmentInputs) => T): T {
      if (!db.inTransaction) throw new Error('Assessment batch requires the caller snapshot')
      const previous = batch
      batch = createCurrentAssessmentInputs(reader, ids, readPlatformFacts)
      try { return read(batch) } finally { batch = previous }
    },
  })
}

/** Offline SQLite qualification projection for same-source migration comparison. */
export function readEffectiveQualifications(db: Database.Database, enterpriseId: number, asOf: number): EffectiveQualification[] | null {
  const found = prepareCurrentReader(db).select({ id: schema.enterprise.id }).from(schema.enterprise)
    .where(eq(schema.enterprise.id, enterpriseId)).get()
  return found ? projectEffectiveQualifications(readCurrentQualificationAssessment(db, enterpriseId, asOf).titles) : null
}
