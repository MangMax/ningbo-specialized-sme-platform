import { createHash } from 'node:crypto'
import { periodContains, type PlatformQualificationFact } from './platform-qualification'
import { adjudicateQualificationCycles as adjudicate407Cycles } from './qualification-cycles-407'
import type { evaluateEnterpriseFactEffects } from './enterprise-fact-effects'
import { formalValiditySchema } from './formal-validity'
import type { FormalValidity } from '../../../../db/record-event-formal-validity'
import { currentQualification102 } from '../../server/utils/decision-lifecycle/contract'
import type { publicVersion102 } from '../../server/utils/decision-lifecycle/contract'
import type { dispositionFactSchema } from '../../server/utils/title-cycle-disposition-model'
import type { QueryAssessment, QueryCoverageSource, projectQueryCoverage } from './query-assessment-projection'
import type { DifferenceObservation } from '../platform/difference-sources'
import type { PlatformInterface } from '../labels'
import type { z } from 'zod'
import type { OfficialPublishedFact, OfficialPublishedScope } from './official-published-presentation'
import { normalizeName, normalizeUscc } from '../domain'
import { computeTitleLifecycle, type LifecycleEvent } from './lifecycle'
import { adjudicateQualificationCycles, awardTime, originTime, factTime, qualificationEventAppliesAt } from './qualification-cycles'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'

export { CURRENT_TITLES }
export type { CurrentTitle }

export const CURRENT_RULE_VERSION = 'current-roster-116-v14'
export const LEGACY_CURRENT_RULE_VERSION = 'current-roster-116-v8'
export const LEGACY_QUALIFICATION_ASSESSMENT_VERSION = 'enterprise-qualification-407-v1'
export function qualificationDay(time: number) { return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) }
export type CurrentGroup = 'eligible' | 'pending' | 'excluded'
export const PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION = 'enterprise-qualification-407-v2'
export const INDEPENDENT_QUALIFICATION_ASSESSMENT_VERSION = 'enterprise-qualification-478-v3'
export const FROZEN_HIGHEST_HONOR_ASSESSMENT_VERSION = 'enterprise-qualification-687-v4'
export const QUALIFICATION_ASSESSMENT_VERSION = 'enterprise-qualification-807-v7'

export interface OfficialEventFieldGap {
  field: 'year' | 'decidedYear' | 'batchSeq' | 'reviewOutcome'
  valueState: 'unknown' | 'blank' | 'invalid'
  inputState: 'omitted' | 'null' | 'provided'
}
export interface OfficialEventFieldDiagnostics {
  values: { year: unknown; decidedYear: unknown; batchSeq: unknown; reviewOutcome: unknown }
  fieldGaps: OfficialEventFieldGap[]
}
/** Describes recorded fields only; never supplies a missing value or decides eligibility.
 * An award's existing year fallback and unnumbered batch remain the adjudicator's concern.
 */
export function diagnoseOfficialEventFields(event: { eventType: unknown; year?: unknown; decidedYear?: unknown; batchSeq?: unknown; reviewOutcome?: unknown }): OfficialEventFieldDiagnostics {
  const values = { year: event.year ?? null, decidedYear: event.decidedYear ?? null, batchSeq: event.batchSeq ?? null, reviewOutcome: event.reviewOutcome ?? null }
  const fieldGaps: OfficialEventFieldGap[] = []
  if (event.eventType !== 'award' && event.eventType !== 'review') return { values, fieldGaps }
  const fields: OfficialEventFieldGap['field'][] = ['year', 'decidedYear', 'batchSeq']
  if (event.eventType === 'review') fields.push('reviewOutcome')
  for (const field of fields) {
    const value = event[field]
    const known = field === 'reviewOutcome' ? value === 'passed' || value === 'failed'
      : typeof value === 'number' && Number.isSafeInteger(value)
        && (field === 'batchSeq' ? value > 0 : value >= 1900 && value <= 9999)
    if (!known) fieldGaps.push({ field,
      valueState: value == null ? 'unknown' : typeof value === 'string' && !value.trim() ? 'blank' : 'invalid',
      inputState: value === undefined ? 'omitted' : value === null ? 'null' : 'provided',
    })
  }
  return { values, fieldGaps }
}
export type PublishedNameAssessmentInput = { availability: 'available' | 'unavailable'; facts: OfficialPublishedFact[] }
// Private output observer, never a caller-supplied source reader or facts option.
export type CurrentPublishedNameObservation = (scope: readonly OfficialPublishedScope[], presentationScope: readonly OfficialPublishedScope[], input: { readonly availability: 'available' | 'unavailable'; readonly facts: readonly OfficialPublishedFact[] }, sourceError?: unknown) => void
export type QualificationAssessmentReadOptions = {
  /** Explicit compatibility boundary for published 407-v1 receipts. */
  assessmentVersion?: typeof FROZEN_HIGHEST_HONOR_ASSESSMENT_VERSION | typeof INDEPENDENT_QUALIFICATION_ASSESSMENT_VERSION | typeof QUALIFICATION_ASSESSMENT_VERSION | typeof PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION | typeof LEGACY_QUALIFICATION_ASSESSMENT_VERSION
  ownQueryIds?: readonly number[]
  publishedNames?: PublishedNameAssessmentInput
  coverageForTitle?: (title: CurrentTitle) => ReturnType<typeof projectQueryCoverage>
}
export interface CurrentQualificationAssessment {
  effectiveQualification?: { status: 'effective' | 'expired' | 'terminated' | 'moved_out' | 'unrecognized'; basis: string; presentationBasis?: string[]; localRuleBasis?: string[]; notes: string[]; source?: PlatformQualificationFact; supportingTitle?: CurrentTitle }
  titleCode: CurrentTitle
  group: CurrentGroup
  cycles: { originYear: number; batchSeq: number | null; precision: 'year' }[]
  versions: { facts: string; sources: string; decisions: string; observations: string }
  officialQualification: { group: CurrentGroup; message: string; basis: string; notes: string[] }
  subject: { status: 'terminated' | 'unresolved' | 'not_established'; message: string; decisionIds: number[] }
  region: { status: 'outside_ningbo' | 'ningbo' | 'unresolved' | 'not_established'; message: string; decisionIds: number[] }
  platform: {
    status: 'not_queried' | 'query_failed' | 'requires_verification'
    comparison: 'not_established'
    message: string
    truncated: boolean
    observations: (QueryCoverageSource & { applicability: 'at_or_before_as_of' | 'after_as_of' | 'unknown_time'; rows: { relationId: number; status: string | null; year: number | null; batch: string | null }[] })[]
  }
  /** The v1 receipt reader is the only producer of this historical field. */
  completeness: { status: 'incomplete' | 'recorded'; message: string; gaps: string[]; eventIds: number[]; fieldGaps?: (OfficialEventFieldGap & { eventId: number })[]; publishedNames: { evidenceId: number; availability: OfficialPublishedFact['availability']; nameKnown: boolean }[] }
  evidence: { eventId: number; revision: number; eventType: string; year: number | null; batchSeq: number | null; decidedYear: number | null; reviewOutcome: string | null; formalValidity?: FormalValidity | null; validityInvalid?: boolean; evidenceIds: number[] }[]
  sourceVersions: { evidenceId: number; eventId: number; sourceFile: string; storedFileId: number | null; sha256: string | null; bytes: number | null; removedAt: string | null; capturedRevision: number | null; capturedSha256: string | null }[]
  references: string[]
  notes: string[]
  shadow: { legacyGroup: CurrentGroup; difference: string | null }
}
export interface CurrentQualificationSnapshot {
  enterpriseId: number
  asOf: string
  ruleVersion: string
  assessmentVersion: string
  snapshotId: string
  titles: CurrentQualificationAssessment[]
}
export const assessmentDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Preserve legacy decision bytes when the additive reference column is null. */
function decisionVersionInput<T extends { factReferences?: unknown }>(row: T) {
  if (row.factReferences != null) return row
  const { factReferences: _unused, ...legacy } = row
  return legacy
}
export interface CurrentQualificationWitness {
  cycle: { originYear: number; batchSeq: number | null }
  awardEventId: number | null
  recognition: { precision: 'year'; year: number }
  matchedValidYear: number | null
  matchedMaintenance: { year: number; batch: number | null } | null
}
export interface CurrentRow {
  enterpriseId: number; name: string; uscc: string | null; district: string | null
  publishedNames: string[]; aliases: string[]; firstYear: number | null
  basis: string; reviews: string; publication: string; notes: string[]; references: string[]
  group: CurrentGroup
  /** Opt-in only: existing query/export consumers retain their response and hash. */
  assessment?: CurrentQualificationAssessment
  qualificationWitnesses?: CurrentQualificationWitness[]
  recognition?: { precision: 'year'; year: number } | null
  matchedValidYears?: number[]
  matchedMaintenance?: { year: number; batch: number | null }[]
  /** Read-only facts used by the workbook; deliberately absent from task hash JSON. */
  workbookFacts?: CurrentWorkbookFacts
}
export interface CurrentWorkbookFacts {
  events: Array<{ id: number; eventType: string; year: number | null; batchSeq: number | null; decidedYear: number | null; reviewOutcome: string | null; source: string }>
  evidence: Array<{ id: number; eventId: number; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }>
  dispositions?: Array<{ kind: 'not_applied' | 'not_recommended' | 'formal_failure'; source: string; statement: string; cycleYear: number | null; cycleBatch: number | null; effective: string | null; effectiveBasis: string | null; status: string; sourceCurrent: boolean }>
  qualificationSource?: PlatformQualificationFact
  migration: Array<{ basis: string; awardYear: number | null; validFrom: string; validUntil: string; publicationScope: string }>
  platform: Array<{ interface: string; queriedAt: string }>
  assessments: Array<{ explanationValidity: string; queryCoverage: string; noRecord: boolean }>
}
export type CurrentPlatformReference = { id: number; queryId: number } & CurrentWorkbookFacts['platform'][number]
export type CandidateEvent = LifecycleEvent & { batchSeq: number|null; nameRaw: string|null; usccRaw: string|null; source: string; revision: number; formalValidity?: FormalValidity; validityInvalid?: boolean; formalValidityInputHash?: string; recordId?: number }
export type CandidateFile = { id: number; sha256: string; bytes: number; removedAt: string | null }
type QualificationPlatformEffect = CurrentPlatformReference & {
  interface: PlatformInterface; status: string | null; year: number | null; batch: string | null
}
export type CandidateResult = { row: CurrentRow; group: CurrentGroup; effectiveStatus: import('./current-status').CurrentStatus; applicablePublication: boolean }
export type QualificationDisposition = {
  disposition: { id: string; revision: number; status: string; kind: z.infer<typeof dispositionFactSchema>['kind']; fact: z.infer<typeof dispositionFactSchema> }
  file: Pick<CandidateFile, 'removedAt' | 'sha256'> | null
  cycle: Pick<CandidateEvent, 'id' | 'revision' | 'eventType' | 'year' | 'batchSeq'> | null
  record: { enterpriseId: number; titleCode: string; source: string } | null
}
export type CandidateDetail = {
  expandAssessment?: boolean
  giant?: CurrentRow
  specialized?: CurrentRow
  qualificationOnly?: boolean
  platformEffects?: QualificationPlatformEffect[]
}
type CandidateReader = (
  enterpriseId: number, title: CurrentTitle, year: number, executionTime?: number,
  includeFilterFacts?: boolean, includeReferences?: boolean, assessmentOptions?: QualificationAssessmentReadOptions,
  includePendingFilterFacts?: boolean, suppliedPlatformRefs?: readonly CurrentPlatformReference[],
  observePublishedForCurrent?: CurrentPublishedNameObservation,
  detail?: CandidateDetail,
) => CandidateResult
export interface CandidateSource {
  enterprise: {
    id: number; name: string; name_norm: string; uscc_norm: string | null; district: string | null; city: string | null
  }
  events: CandidateEvent[]
  evidence: CurrentWorkbookFacts['evidence']
  readValidityRows(): {id:number;recordId:number;value:string|null}[]
  readFile(path: string): CandidateFile | undefined
  readAliases(): {id:number;name:string;version:number}[]
  readDispositions(): QualificationDisposition[]
  readPlatformEffects?(): QualificationPlatformEffect[]
  readLegacyHeads?(): Parameters<typeof publicVersion102>[0][]
  readLegacyAssessment?(title: string, direction: 'missing_in_miit' | 'extra_in_miit'): QueryAssessment
  readLegacyReceipt?(id: number): {basis:string;effectiveAt:string}|undefined
  readLegacyObservation?(id: number): DifferenceObservation | undefined
  readFactEffects(effectiveOnly: boolean): ReturnType<typeof evaluateEnterpriseFactEffects>
  readPlatformFacts(): PlatformQualificationFact[]
  readPublishedNames?(scope: OfficialPublishedScope[]): OfficialPublishedFact[]
  readCaptureVersion(id: number): {revision:number;sha256:string|null}|undefined
  readCoverage?(): ReturnType<typeof projectQueryCoverage>
}

export function evaluateCandidate(
  source: CandidateSource, readCandidate: CandidateReader,
  enterpriseId: number, title: CurrentTitle, year: number, executionTime = Date.now(),
  includeFilterFacts = false, includeReferences = true, assessmentOptions?: QualificationAssessmentReadOptions,
  includePendingFilterFacts = false, suppliedPlatformRefs?: readonly CurrentPlatformReference[],
  observePublishedForCurrent?: CurrentPublishedNameObservation,
  detail: CandidateDetail = {},
): CandidateResult {
  const { enterprise, events, evidence } = source
  const expandAssessment = detail.expandAssessment ?? assessmentOptions != null
  const legacy = assessmentOptions?.assessmentVersion === LEGACY_QUALIFICATION_ASSESSMENT_VERSION
  const currentRules = !assessmentOptions?.assessmentVersion || assessmentOptions.assessmentVersion === QUALIFICATION_ASSESSMENT_VERSION
  const effectiveMode = assessmentOptions?.assessmentVersion === FROZEN_HIGHEST_HONOR_ASSESSMENT_VERSION || !assessmentOptions?.assessmentVersion || assessmentOptions.assessmentVersion === QUALIFICATION_ASSESSMENT_VERSION || assessmentOptions.assessmentVersion === INDEPENDENT_QUALIFICATION_ASSESSMENT_VERSION
  if (!legacy) {
    const validityRows = source.readValidityRows()
    for (const raw of validityRows) {
      const event = events.find(e => e.id === raw.id)!
      if (!raw.value) continue
      event.formalValidityInputHash=assessmentDigest(raw.value)
      let parsed: ReturnType<typeof formalValiditySchema.safeParse>
      try { parsed = formalValiditySchema.safeParse(JSON.parse(raw.value)) } catch { event.validityInvalid=true; continue }
      if (!parsed.success) { event.validityInvalid=true; continue }
      const fact = parsed.data
      const ref = evidence.find(e => e.id === fact.evidenceId && e.eventId === event.id)
      const file = ref && source.readFile(ref.sourceFile)
      const origin = fact.originAwardEventId == null ? undefined : events.find(e => e.id === fact.originAwardEventId)
      const originRecord = origin && validityRows.find(e => e.id === origin.id)?.recordId
      const originValid = fact.originAwardEventId == null || !!origin && originRecord === raw.recordId && origin.eventType === 'award' && origin.year != null && origin.year === event.year && !(origin.batchSeq != null && event.batchSeq != null && origin.batchSeq !== event.batchSeq)
      if (!file || file.removedAt || file.sha256 !== fact.sourceSha256 || !originValid) event.validityInvalid=true
      // Source availability is diagnostic; it cannot replace a recorded business interval.
      if (effectiveMode) event.formalValidity=originValid ? fact : { ...fact, originAwardEventId: undefined, continuation: undefined }
      else if (!event.validityInvalid) event.formalValidity=fact
    }
  }
  const publicationEvents = events.filter(e => e.source === 'jxj' && ['award','review'].includes(e.eventType))
  const formal = publicationEvents.filter(e => evidence.some(v => v.eventId === e.id))
  const lifecycle = computeTitleLifecycle(formal)
  const row: CurrentRow = { enterpriseId, name: enterprise.name, uscc: enterprise.uscc_norm, district: enterprise.district, publishedNames: [...new Set(formal.map(e => e.nameRaw).filter((n): n is string => !!n))], aliases: [], firstYear: lifecycle.firstRecognitionYear, basis: formal.map(e => `event:${e.id}@${e.revision} ${e.eventType} ${e.year ?? ''}/${e.batchSeq ?? ''} 结论年:${e.decidedYear ?? ''}`).join('\n'), reviews: formal.filter(e => e.eventType === 'review').map(e => `${e.year ?? '?'}年原认定批次；结论年${e.decidedYear ?? '?'}；${e.reviewOutcome ?? '未知'}`).join('\n'), publication: formal.length ? '已见本称号宁波公布记录' : '尚未完成公布匹配核实', notes: [], references: evidence.map(v => `evidence:${v.id} ${v.sourceFile} ${v.attachment ?? ''} 序号:${v.listNo ?? ''}`), group: 'pending' }
  const dispositionInputs = currentRules && title === 'little_giant'
    ? source.readDispositions() : []
  const disposedAwards = new Set<number>()
  const dispositionBasis: string[] = []
  const workbookDispositions: NonNullable<CurrentWorkbookFacts['dispositions']> = []
  for (const { disposition: d, file, cycle, record } of dispositionInputs) {
    const f = d.fact
    const sourceCurrent = !!file && !file.removedAt && file.sha256 === f.source.sha256 &&
      !!cycle && cycle.revision === f.cycle?.revision && cycle.eventType === 'award' &&
      record?.enterpriseId === enterpriseId && record.titleCode === title && record.source === 'jxj' &&
      (f.kind !== 'formal_failure' || events.some(e => e.id === f.formalEvent?.eventId && e.revision === f.formalEvent.revision &&
        e.eventType === 'review' && e.reviewOutcome === 'failed' && e.formalValidity?.originAwardEventId === cycle.id))
    const applies = d.status === 'confirmed' && d.kind !== 'formal_failure' && sourceCurrent &&
      f.effective.precision === 'day' && !!f.effectiveBasis?.trim() && f.effective.value! <= qualificationDay(executionTime) &&
      events.some(e => e.id === cycle!.id && (factTime(e) != null && factTime(e)! <= year))
    if (applies) disposedAwards.add(cycle!.id)
    const statement = `disposition:${d.id}@${d.revision} ${d.kind} 原周期event:${f.cycle?.eventId ?? '?'}；${f.source.reference}；${f.source.statement}；生效:${f.effective.value ?? '?'}；${f.effectiveBasis ?? '生效依据未知'}；${applies ? '适用该原周期' : '不据此排除或延长资格'}`
    workbookDispositions.push({kind:d.kind,source:f.source.reference,statement:f.source.statement,cycleYear:cycle?.year ?? null,cycleBatch:cycle?.batchSeq ?? null,effective:f.effective.precision === 'day' ? f.effective.value : null,effectiveBasis:f.effectiveBasis,status:d.status,sourceCurrent})
    dispositionBasis.push(statement)
    row.references.push(statement)
  }
  // Formal failures remain owned by their original events. Apply only an
  // evidenced same-title cycle; a later pass is not a new award.
  if (currentRules && title === 'little_giant') {
    const day = qualificationDay(executionTime)
    const applicableAwards = formal.filter(e => e.eventType === 'award' && qualificationEventAppliesAt(e, year, day))
    for (const failure of formal) {
      if (failure.eventType !== 'review' || failure.reviewOutcome !== 'failed' || failure.decidedYear == null ||
          !qualificationEventAppliesAt(failure, year, day)) continue
      for (const award of applicableAwards) if (
        failure.formalValidity?.originAwardEventId === award.id ||
        !failure.formalValidity?.originAwardEventId && failure.year != null && failure.batchSeq != null && failure.year === award.year && failure.batchSeq === award.batchSeq &&
        awardTime(award) != null && awardTime(award)! <= failure.decidedYear &&
        applicableAwards.filter(e => e.year === failure.year && e.batchSeq === failure.batchSeq).length === 1
      ) disposedAwards.add(award.id)
    }
  }
  const qualification: ReturnType<typeof adjudicateQualificationCycles> = effectiveMode
    ? adjudicateQualificationCycles(publicationEvents.map(e => ({...e, validityInvalid:false})), year, qualificationDay(executionTime), true, disposedAwards, currentRules && title === 'little_giant', new Set(formal.map(e => e.id)), currentRules && title !== 'little_giant', currentRules && title === 'little_giant')
    : adjudicate407Cycles(formal, year, legacy ? undefined : qualificationDay(executionTime))
  let qualificationSource: 'formal' | 'migration' = 'formal'
  let migrationAwardYears: number[] = []
  row.group = qualification.group
  if (formal.length) row.notes.push(...qualification.notes)
  if (!formal.length && events.length && events.every(e => e.eventType === 'nurture')) {
    row.group='excluded'; row.notes.push('纯入库培育，不构成称号')
  }
  const aliases = source.readAliases()
  row.aliases = [...new Set(aliases.map(a => a.name))]
  row.references.push(...aliases.map(a => 'alias:' + a.id + '@' + a.version))
  const knownNames = new Set([enterprise.name,...row.aliases].map(name => normalizeName(name)))
  const unverifiedName = row.publishedNames.some(name => !knownNames.has(normalizeName(name)) && !formal.some(e => e.nameRaw === name && !!enterprise.uscc_norm && normalizeUscc(e.usccRaw) === enterprise.uscc_norm))
  let identityGap = unverifiedName || !row.publishedNames.length && !!formal.length && !enterprise.uscc_norm
  if (identityGap) {
    row.group='pending'; row.publication='尚未完成公布匹配核实'; row.notes.push('公布名称与当前身份尚未完成确认对应')
  } else {
    if (!row.publishedNames.length && formal.length) row.notes.push('公布名未留档；正式出处按稳定企业标识关联，未将现名补作公布名')
    for (const name of row.publishedNames.filter(n => normalizeName(n) !== normalizeName(row.name))) row.notes.push('已公布，公布名称为' + name + '；现已更名为' + row.name)
  }
  if (formal.some(e => normalizeUscc(e.usccRaw) && enterprise.uscc_norm && normalizeUscc(e.usccRaw) !== normalizeUscc(enterprise.uscc_norm))) { identityGap=true; row.group='pending'; row.notes.push('公布统代与当前主体存在身份冲突') }
  let officialGroup = row.group
  // #102 owns the head; #108 owns evidence applicability, including legacy reviews.
  const targetEffects = detail.platformEffects ?? (includeReferences ? source.readPlatformEffects?.() : undefined)
  const platformRefs=includeReferences ? suppliedPlatformRefs ?? targetEffects ?? [] : []
  row.references.push(...platformRefs.map(r => 'platform-relation:' + r.id + ' query:' + r.queryId))
  // Default effective reads never execute legacy difference/assessment/receipt decisions.
  // Explicit prior versions retain those diagnostics and their historical behavior.
  const headRows = effectiveMode ? [] : source.readLegacyHeads!()
  const heads = CURRENT_TITLES.flatMap(titleCode => (['missing_in_miit','extra_in_miit'] as const).flatMap(direction => headRows.filter(d => d.titleCode === titleCode && d.direction === direction))).map(d => ({...d,queryId:d.evidenceQueryId,relationId:d.evidenceRelationId,movedTitle:d.movedInTitleCode,movedCity:d.movedInCity,movedYear:d.movedInYear,movedBatch:d.movedInBatch}))
  const subjectFacts: any[] = []
  const workbookAssessments: CurrentWorkbookFacts['assessments'] = []
  const workbookMigration: CurrentWorkbookFacts['migration'] = heads.filter(d => d.titleCode === title && d.reasonCode === 'moved_in' && d.lifecycleAction !== 'withdraw').flatMap(d => {
    const parsed = currentQualification102.safeParse(d.currentQualification)
    return parsed.success ? [{basis:parsed.data.basis,awardYear:parsed.data.awardYear ?? null,validFrom:parsed.data.validFrom,validUntil:parsed.data.validUntil,publicationScope:parsed.data.publicationCheck.scope}] : []
  })
  let subjectGap = false
  let qualificationGap = false
  const decisionAssessments: unknown[] = []
  for (const d of heads) {
    const subjectFact = ['moved_out','deregistered','moved_in'].includes(d.reasonCode ?? '')
    // Qualification explanations remain title-scoped. Legal-entity facts do not.
    if (d.titleCode !== title && !subjectFact && d.lifecycleAction !== 'withdraw') continue
    row.references.push('decision:' + d.id)
    if (d.lifecycleAction === 'withdraw') { row.notes.push('旧决定已撤回，不作为当前排除依据'); continue }
    if (d.verificationStatus !== 'confirmed' || d.status !== 'confirmed_reason') {
      if (subjectFact) { subjectGap=true; row.notes.push('主体事实尚未确认（decision:' + d.id + '）') }
      else if (d.titleCode === title && d.reasonCode && !['pending_review','platform_stale','renamed'].includes(d.reasonCode)) { qualificationGap=true; row.notes.push('本称号解释尚未确认（decision:' + d.id + '）') }
      continue
    }
    if (['pending_review','platform_stale','renamed'].includes(d.reasonCode ?? '')) continue
    const assessment = source.readLegacyAssessment!(d.titleCode, d.direction as 'missing_in_miit'|'extra_in_miit')
    if (d.titleCode === title) workbookAssessments.push({explanationValidity:assessment.explanationValidity.status,queryCoverage:assessment.queryCoverage.status,
      noRecord:assessment.queryCoverage.sources.find(source => source.titleCode === d.titleCode && source.subjectMatch === 'exact_uscc')?.outcome === 'no_record'})
    row.references.push(`decision:${d.id} explanationValidity:${assessment.explanationValidity.status} queryCoverage:${assessment.queryCoverage.status}`)
    // A maintain receipt can adopt legacy facts without rewriting their null metadata.
    const reviewed = source.readLegacyReceipt!(d.id)
    const effectiveAt=d.effectiveAt ?? reviewed?.effectiveAt
    if (assessmentOptions) decisionAssessments.push({ id: d.id, assessment: {
      ...assessment,
      currentDecision: { ...assessment.currentDecision, current: assessment.currentDecision.current == null
        ? assessment.currentDecision.current : decisionVersionInput(assessment.currentDecision.current) },
    }, reviewed })
    const gap = assessment.explanationValidity.status !== 'valid' || !(d.basis ?? reviewed?.basis) || !effectiveAt || !Number.isFinite(Date.parse(effectiveAt)) || Date.parse(effectiveAt) > executionTime
    const observation=d.relationId ? source.readLegacyObservation!(d.relationId) : undefined
    const ownUscc=normalizeUscc(enterprise.uscc_norm), sourceUscc=normalizeUscc(observation?.uscc)
    const sourceConflict=observation && (observation.enterpriseId != null && observation.enterpriseId !== enterpriseId || sourceUscc && ownUscc && sourceUscc !== ownUscc)
    const sourceGap=!!d.currentQualification && (!observation || observation.verificationStatus !== 'confirmed' || observation.enterpriseId == null && (!ownUscc || sourceUscc !== ownUscc))
    if (sourceConflict) { identityGap=true; row.notes.push('决定来源与当前主体存在身份冲突（decision:' + d.id + '）') }
    if (gap || d.reasonCode === 'other' || sourceConflict || sourceGap) { if (subjectFact) subjectGap=true; else qualificationGap=true; row.group='pending'; row.notes.push(`旧决定适用前提需重新核实（decision:${d.id}；explanationValidity:${assessment.explanationValidity.status}；queryCoverage:${assessment.queryCoverage.status}）`); continue }
    d.effectiveAt=effectiveAt
    if (['moved_out','deregistered','moved_in'].includes(d.reasonCode ?? '')) subjectFacts.push(d)
  }
  // Current #102 heads already resolve explicit replacement/withdrawal. Legal
  // existence is independent of location: migration is not a resurrection.
  const terminations = subjectFacts.filter(d => d.reasonCode === 'deregistered')
  const locations = subjectFacts.filter(d => d.reasonCode === 'moved_out' || d.reasonCode === 'moved_in')
  const latestTime = Math.max(...locations.map(d => Date.parse(d.effectiveAt)))
  const latest = locations.filter(d => Date.parse(d.effectiveAt) === latestTime)
  const attested = subjectFacts.filter(f => f.reasonCode === 'moved_in' && f.titleCode === title).flatMap(f => {
    const parsed=currentQualification102.safeParse(f.currentQualification)
    return parsed.success && parsed.data.titleCode === title ? [{decision:f,qualification:parsed.data}] : []
  })
  const applicable = (currentRules ? [] : attested).filter(({qualification:q}) => Date.parse(q.validFrom) <= executionTime && executionTime < Date.parse(q.validUntil))
  const current = applicable.filter(a => {
    const q=a.qualification
    if (q.publicationCheck.status !== 'not_found') return false
    if (!formal.length) return true
    // A current interval is not a re-award. It can supersede an expired,
    // otherwise settled history; failures/gaps need an explicit new grant.
    // Strict years preserve the existing same-year/unknown-order boundary.
    const anchor=q.awardYear ?? new Date(q.validFrom).getUTCFullYear()
    if (anchor > year || formal.some(e => factTime(e) == null || factTime(e)! >= anchor || originTime(e) != null && originTime(e)! >= anchor || originTime(e) == null && (e.eventType === 'award' || q.awardYear == null))) return false
    if (q.awardYear == null && formal.some(e => e.eventType === 'review' && (e.reviewOutcome !== 'passed' || e.batchSeq == null))) return false
    return true
  })
  if (new Set(latest.map(d => d.reasonCode)).size > 1) { row.group='pending'; row.notes.push('同一生效时点主体事实冲突，待确认') }
  else if (latest.length) {
    const d = latest[0]
    if (d.reasonCode === 'moved_out') { row.group='excluded'; row.notes.push('已确认外迁') }
    else {
      row.notes.push('已确认迁入宁波' + (d.movedCity ? '；原城市：' + d.movedCity : ''))
      if (d.titleCode === title && d.movedTitle && d.movedTitle !== title) { qualificationGap=true; row.group='pending'; row.notes.push('迁入资格依据不属于本称号') }
      {
        row.basis=[row.basis,...attested.map(a => `decision:${a.decision.id} ${a.qualification.basis} [${a.qualification.validFrom},${a.qualification.validUntil})${a.qualification.awardYear == null ? '' : ' 明确认定年:'+a.qualification.awardYear}`)].filter(Boolean).join('\n')
        row.notes.push(...attested.map(a => '迁入资格断言；公布核对范围：' + a.qualification.publicationCheck.scope))
        if (current.length) {
          if (qualification.group !== 'eligible') {
            qualificationSource='migration'
            migrationAwardYears=[...new Set(current.flatMap(({qualification:q}) => q.awardYear == null ? [] : [q.awardYear]))]
          }
          row.group='eligible'; if (!formal.length) row.publication='迁入；未见宁波该称号公布记录（限已核对范围）'
          officialGroup='eligible'
          row.notes=row.notes.filter(n => !qualification.notes.includes(n))
          row.notes.push('迁入资格已确认')
          if (row.aliases.length) row.notes.push('已确认曾用名：' + row.aliases.join('、') + '；现名：' + row.name)
        } else if (!formal.length) {
          row.group='pending'; row.publication='尚未完成公布匹配核实'
          row.notes.push('缺少已复核本称号当前资格及宁波公布核对范围；迁入事实不能代替资格依据')
        } else if (applicable.length && row.group !== 'eligible') {
          row.group='pending'; row.notes.push('迁入资格与正式周期/失败/日期顺序尚未消解，保留全部历史依据')
        }
      }
    }
  }
  if (terminations.length) { row.group='excluded'; row.notes.push('已确认注销/主体终止；独立迁入不构成主体状态更正') }
  if (subjectGap) { row.group='pending'; row.notes.push('相关主体事实适用性未确认，不能确认为当前有效主体') }
  if (identityGap || qualificationGap) { row.group='pending'; row.notes.push('身份或本称号解释存在未决缺口，当前资格待确认') }
  const incomplete = events.filter(e => e.source === 'jxj' && ['award','review'].includes(e.eventType) && !formal.some(f => f.id === e.id))
  const allHistory=computeTitleLifecycle(events.filter(e => e.source === 'jxj'))
  const first=events.find(e => e.id === allHistory.firstRecognitionEventId)
  if (allHistory.undatedAwardIds.length || first && incomplete.some(e => e.id === first.id)) {
    row.firstYear=null; row.notes.push('首次认定补充依据不完整，年份留空；不据此丢弃已确认当前资格')
  }
  row.references.push(...incomplete.map(e => 'event:' + e.id + ' 正式出处待补'))
  // Applicability compares originating cycles. A late decision date on an old
  // award does not associate it with an independent, formally renewed cycle.
  const currentSourceGap = incomplete.some(e => originTime(e) == null || originTime(e)! >= qualification.originYear)
  if (currentSourceGap) {
    row.group='pending'; row.notes.push('存在影响当前周期的无正式出处/未确认认定或复核，当前资格待确认')
  }
  if (!formal.length && row.group === 'pending') {
    row.notes.push(...qualification.notes)
  }
  const factEffects = (effectiveOnly = false) => source.readFactEffects(effectiveOnly)
  const independent = factEffects()
  if (independent) row.references.push(...independent.refs)
  // #478: one effective decision; legacy diagnostics remain readable but cannot
  // supply eligibility. Only formal periods and complete typed exclusions enter.
  const exclusions = effectiveMode ? factEffects(true) : independent
  const effectiveFormal = qualification
  const platformFacts = currentRules ? (source.readPlatformFacts()).filter(f => f.enterpriseId === enterpriseId && f.title === title) : []
  const at = new Date(executionTime + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)
  const day = at.slice(0, 10)
  // Business time is independent of capture time. Future business facts do not
  // grant or revoke a current period; unknown submission time is never a grant year.
  const visible = platformFacts.filter(f => !(f.businessTime.value && f.businessTime.value > at) && !(f.businessYear != null && f.businessYear > year))
  const sourceOrder = ['recognized_list', 'business_list', 'apply_list'] as const
  // Published facts govern this title, including an expired or failed result.
  // Platform qualification is a fallback only while no publication applies.
  const hasApplicablePublication = publicationEvents.some(event => qualificationEventAppliesAt(event, year, day))
  let platformSource: PlatformQualificationFact | undefined
  if (!hasApplicablePublication) for (const source of sourceOrder) {
    const facts = visible.filter(f => f.source === source)
    const selected = facts.filter(f => {
      const futureInvalidation = !!f.invalidatedAt.value && f.invalidatedAt.value > at
      if (f.conclusion !== 'passed' && !(f.conclusion === 'invalid' && futureInvalidation)) return false
      if (f.invalidatedAt.value && !futureInvalidation) return false
      const city = f.location.city
      if (city ? !/^宁波(?:市)?$/.test(city) : enterprise.city && !/^宁波(?:市)?$/.test(enterprise.city)) return false
      const explicit = periodContains(f.period.from, f.period.until, at)
      const startYear = f.period.from.value ? Number(f.period.from.value.slice(0, 4)) : f.businessYear
      if (explicit === false || explicit == null && (f.period.from.raw != null || f.period.until.raw != null)) return false
      if (explicit == null && (f.matter === 'update' || startYear == null || startYear > year || title !== 'little_giant' && year >= startYear + 3)) return false
      const independentGrantAfter = (boundary: string) => visible.some(grant => {
          if (!['recognition','apply'].includes(grant.matter) || grant.conclusion !== 'passed') return false
          if (grant.invalidatedAt.value && grant.invalidatedAt.value <= at) return false
          if (grant.location.city ? !/^宁波(?:市)?$/.test(grant.location.city) : enterprise.city && !/^宁波(?:市)?$/.test(enterprise.city)) return false
          const grantStart = grant.period.from.value ?? (grant.businessYear == null ? null : `${grant.businessYear}-01-01`)
          return grantStart != null && grantStart > boundary && startYear != null && Number(grantStart.slice(0, 4)) <= startYear
        })
      // An explicit negative from a higher-priority current source cannot be
      // bypassed by an older lower-priority pass. A later independent grant can.
      if (visible.some(n => {
        if (sourceOrder.indexOf(n.source) > sourceOrder.indexOf(f.source) || n.conclusion !== 'invalid' || n.invalidatedAt.value && n.invalidatedAt.value > at) return false
        const boundary = n.invalidatedAt.value ?? n.period.until.value
        if (f.matter === 'review' && boundary) return !independentGrantAfter(boundary)
        const grantStart = f.period.from.value ?? (f.businessYear == null ? null : `${f.businessYear}-01-01`)
        return !['recognition','apply'].includes(f.matter) || !grantStart || !boundary || grantStart <= boundary
      })) return false
      return true
    }).sort((a,b) => (b.period.from.value ?? String(b.businessYear ?? '')).localeCompare(a.period.from.value ?? String(a.businessYear ?? '')) || b.recordId-a.recordId)[0]
    if (selected) { platformSource = selected; break }
  }
  if (platformSource) {
    row.basis = [row.basis, `${platformSource.source} record:${platformSource.recordId} version:${platformSource.versionId} observation:${platformSource.observationId}`].filter(Boolean).join('\n')
    row.references.push(`platform-record:${platformSource.recordId}@${platformSource.versionId}`)
    row.publication = formal.length ? row.publication : '平台资格；未见本称号公布记录'
  }
  let effectiveStatus = exclusions?.terminated ? 'terminated' as const
    : exclusions?.region === 'outside_ningbo' ? 'moved_out' as const
    : effectiveFormal.group === 'eligible' || platformSource || current.length > 0 ? 'effective' as const
    : events.some(e => e.source === 'jxj' && e.eventType === 'award') ? 'expired' as const : 'unrecognized' as const
  // Frozen v4 keeps its historical gate. Current inheritance flows only downward;
  // each title keeps its own formal history and prefers its own effective period.
  const frozenInheritance = assessmentOptions?.assessmentVersion === FROZEN_HIGHEST_HONOR_ASSESSMENT_VERSION
  const inheritanceMode = frozenInheritance || !assessmentOptions?.assessmentVersion || assessmentOptions.assessmentVersion === QUALIFICATION_ASSESSMENT_VERSION
  const historyTimeKnown = (event: typeof formal[number]) => factTime(event) != null ||
    (!event.validityInvalid && event.formalValidity?.publishedOn != null)
  const history = formal.filter(event => {
    const time = factTime(event)
    const published = event.formalValidity?.publishedOn
    return (time != null ? time <= year : historyTimeKnown(event)) &&
      (!published || published <= qualificationDay(executionTime))
  })
  if (frozenInheritance && title !== 'little_giant' && formal.some(event => !historyTimeKnown(event))) row.notes.push('本称号正式历史发生时点未知，不能用作小巨人规则前提')
  const localRuleBasis: string[] = []
  let supportingTitle: CurrentRow | undefined
  let giant: CurrentRow | undefined
  const needsGiant = !detail.qualificationOnly || effectiveStatus === 'expired' || effectiveStatus === 'unrecognized'
  if (inheritanceMode && title !== 'little_giant' && (!frozenInheritance || history.length || expandAssessment) && needsGiant) {
    giant = detail.giant ?? readCandidate(enterpriseId, 'little_giant', year, executionTime, false, includeReferences,
      { ...assessmentOptions, assessmentVersion: frozenInheritance ? INDEPENDENT_QUALIFICATION_ASSESSMENT_VERSION : QUALIFICATION_ASSESSMENT_VERSION }, false, undefined, undefined, { expandAssessment }).row
    if ((frozenInheritance ? history.length > 0 : effectiveStatus !== 'effective') && giant.group === 'eligible' && effectiveStatus !== 'terminated' && effectiveStatus !== 'moved_out') {
      effectiveStatus = 'effective'
      supportingTitle = giant
      const explanation = frozenInheritance ? '按有效小巨人资格计入；本称号正式历史：' + history.map(e => `event:${e.id}`).join('、') : '按有效小巨人资格计入；实际支撑称号：小巨人'
      localRuleBasis.push(explanation, ...giant.references.map(ref => '小巨人实际来源：' + ref))
      row.basis += '\n' + explanation + '\n' + giant.basis
      row.references.push(...giant.references.map(ref => '小巨人依据：' + ref))
    }
  }
  let specialized: CurrentRow | undefined
  const needsSpecialized = !detail.qualificationOnly || effectiveStatus === 'expired' || effectiveStatus === 'unrecognized'
  if (inheritanceMode && !frozenInheritance && title === 'innovative_sme' && needsSpecialized) {
    specialized = detail.specialized ?? readCandidate(enterpriseId, 'specialized_sme', year, executionTime, false, includeReferences,
      assessmentOptions, false, undefined, undefined, { expandAssessment, giant, qualificationOnly: detail.qualificationOnly }).row
    if (effectiveStatus !== 'effective' && effectiveStatus !== 'terminated' && effectiveStatus !== 'moved_out' && specialized.group === 'eligible') {
      effectiveStatus = 'effective'
      supportingTitle = specialized
      const explanation = '按有效专精特新中小企业资格计入；实际支撑称号：专精特新中小企业'
      localRuleBasis.push(explanation, specialized.basis, ...specialized.references.map(ref => '省专实际来源：' + ref))
      row.basis += '\n' + explanation + '\n' + specialized.basis
      row.references.push(...specialized.references.map(ref => '省专依据：' + ref))
    }
  }
  const legacyGroup = row.group
  if (effectiveMode) {
    row.notes = row.notes.map(note => '历史诊断（不参与有效判定）：' + note)
    if (events.some(e => e.validityInvalid)) row.notes.push('正式有效期资料来源缺失或版本/周期引用需核实，仅备注；保留已录入业务期间')
    if (exclusions?.pending) row.notes.push('排除事实证据或生效时间不完整，仅备注，不改变正式资格')
    officialGroup = effectiveFormal.group === 'eligible' ? 'eligible' : 'excluded'
    row.group = effectiveStatus === 'effective' ? 'eligible' : 'excluded'
    qualificationSource = effectiveFormal.group === 'eligible' || !current.length ? 'formal' : 'migration'
    if (qualificationSource === 'migration') migrationAwardYears = [...new Set(current.flatMap(a => a.qualification.awardYear == null ? [] : [a.qualification.awardYear]))]
    if (current.length) {
      row.notes.push('迁入资格已确认')
      if (!formal.length) row.publication = '迁入；未见宁波该称号公布记录（限已核对范围）'
      row.basis = [row.basis, ...current.map(a => `decision:${a.decision.id} ${a.qualification.basis} [${a.qualification.validFrom},${a.qualification.validUntil})`)].filter(Boolean).join('\n')
      row.references.push(...current.map(a => `decision:${a.decision.id}`))
      workbookMigration.push(...current.map(({qualification:q}) => ({basis:q.basis,awardYear:q.awardYear ?? null,validFrom:q.validFrom,validUntil:q.validUntil,publicationScope:q.publicationCheck.scope})))
    }
  }
  row.basis = [row.basis, ...dispositionBasis].filter(Boolean).join('\n')
  row.notes.push(...localRuleBasis)
  if (includeFilterFacts && (row.group === 'eligible' || includePendingFilterFacts)) {
    // The selected adjudication already separates current cycles and feasible
    // unknown-batch grants. Never reconstruct them from basis/reviews strings.
    const awards = qualificationSource === 'formal' ? (effectiveMode ? effectiveFormal : qualification).cycles.flatMap(cycle => cycle.awardEventIds.map(awardEventId => ({ cycle, awardEventId }))) : []
    row.qualificationWitnesses = awards.map(({ cycle, awardEventId }) => {
      const event = events.find(item => item.id === awardEventId)!
      return {
        cycle: { originYear: cycle.originYear, batchSeq: cycle.batch },
        awardEventId,
        recognition: { precision: 'year', year: awardTime(event)! },
        matchedValidYear: null,
        matchedMaintenance: null,
      }
    })
    if (qualificationSource === 'migration') row.qualificationWitnesses = migrationAwardYears.map(awardYear => ({cycle:{originYear:awardYear,batchSeq:null},awardEventId:null,recognition:{precision:'year',year:awardYear},matchedValidYear:null,matchedMaintenance:null}))
    if (platformSource) {
      const originYear = platformSource.period.from.value ? Number(platformSource.period.from.value.slice(0,4)) : platformSource.businessYear
      row.qualificationWitnesses = originYear == null ? [] : [{cycle:{originYear,batchSeq:null},awardEventId:null,recognition:{precision:'year',year:originYear},matchedValidYear:platformSource.period.until.value ? Number(platformSource.period.until.value.slice(0,4)) : null,matchedMaintenance:null}]
    }
    row.recognition = row.qualificationWitnesses[0]?.recognition ?? null
    row.matchedValidYears = [...new Set(row.qualificationWitnesses.flatMap(witness => witness.matchedValidYear == null ? [] : [witness.matchedValidYear]))].sort((a,b) => a-b)
    row.matchedMaintenance = row.qualificationWitnesses.flatMap(witness => witness.matchedMaintenance ? [witness.matchedMaintenance] : []).filter((fact,index,all) => all.findIndex(other => other.year === fact.year && other.batch === fact.batch) === index).sort((a,b) => a.year-b.year || (a.batch ?? 0)-(b.batch ?? 0))
  }
  Object.defineProperty(row,'workbookFacts',{value:{
    events:events.map(({id,eventType,year,batchSeq,decidedYear,reviewOutcome,source}) => ({id,eventType,year,batchSeq,decidedYear,reviewOutcome,source})),
    evidence:evidence.map(({id,eventId,sourceFile,attachment,listNo,page}) => ({id,eventId,sourceFile,attachment,listNo,page})),
    ...(platformSource ? {qualificationSource:platformSource} : {}),
    migration:workbookMigration,
    ...(currentRules ? { dispositions:workbookDispositions } : {}),
    platform:[...new Map(platformRefs.map(({queryId,interface:interfaceName,queriedAt}) => [queryId,{interface:interfaceName,queriedAt}])).values()],
    assessments:workbookAssessments,
  } satisfies CurrentWorkbookFacts,enumerable:false})
  // One canonical assessment-group decision for both the scan projection and
  // full T2. Keep the legacy row.group unchanged for existing consumers.
  const group: CurrentGroup = effectiveMode ? row.group : independent?.terminated || terminations.length ? 'excluded' : independent?.pending ? 'pending' : independent?.region === 'outside_ningbo' ? 'excluded' : row.group
  if (expandAssessment && assessmentOptions) {
    // These dimensions reuse the facts and applicability decisions above. Platform
    // observations never feed back into eligibility.
    if (!effectiveMode && current.length) officialGroup='eligible'
    if (!effectiveMode && (identityGap || qualificationGap || currentSourceGap)) officialGroup='pending'
    const migrationBasis = current.map(a => `decision:${a.decision.id} ${a.qualification.basis} [${a.qualification.validFrom},${a.qualification.validUntil})`)
    const officialNotes = effectiveMode ? [...effectiveFormal.notes] : current.length && qualification.group !== 'eligible' ? ['已复核本称号独立资格期间；地域和主体状态另行判断'] : [...qualification.notes]
    let publishedFacts = assessmentOptions.publishedNames
    let publishedReadError: unknown
    if (!publishedFacts && source.readPublishedNames) {
      try { publishedFacts = {availability:'available',facts:source.readPublishedNames(evidence.map(v => ({evidenceId:v.id,eventId:v.eventId})))} }
      catch (error) { publishedReadError = error; publishedFacts = {availability:'unavailable',facts:[]} }
    }
    // One-way observation of this owned verified read, before the existing T2
    // completeness calculation. Presentation failures cannot change its input.
    if (publishedFacts) observePublishedForCurrent?.(evidence.map(v => ({ evidenceId: v.id, eventId: v.eventId })), evidence.filter(v => formal.some(event => event.id === v.eventId)).map(v => ({ evidenceId: v.id, eventId: v.eventId })), publishedFacts, publishedReadError)
    const publishedNames = publishedFacts ? evidence.filter(v => formal.some(e => e.id === v.eventId)).map(v => {
      const fact = publishedFacts!.facts.find(f => f.evidenceId === v.id && f.eventId === v.eventId)
      return {evidenceId:v.id,availability:publishedFacts!.availability === 'unavailable' ? 'unavailable' as const : fact?.availability ?? 'unknown_legacy' as const,nameKnown:fact?.availability === 'captured' && !!fact.nameRaw?.trim()}
    }) : []
    const sourceVersions = evidence.map(v => {
      const file = source.readFile(v.sourceFile)
      const capture = source.readCaptureVersion(v.id)
      return { evidenceId:v.id, eventId:v.eventId, sourceFile:v.sourceFile, storedFileId:file?.id ?? null, sha256:file?.sha256 ?? null, bytes:file?.bytes ?? null, removedAt:file?.removedAt ?? null, capturedRevision:capture?.revision ?? null, capturedSha256:capture?.sha256 ?? null }
    })
    const coverage = assessmentOptions.coverageForTitle?.(title) ?? source.readCoverage?.()
    const observedRows = platformRefs.map(ref => {
      const target = targetEffects?.find(r => r.id === ref.id)
      const r = target ? {status:target.status,year:target.year,batch:target.batch} : {status:null,year:null,batch:null}
      return {queryId:ref.queryId,relationId:ref.id,...r}
    })
    const observations = (coverage?.sources ?? []).map(s => {
      const time = Date.parse(s.queriedAt)
      const applicability = !Number.isFinite(time) ? 'unknown_time' as const : time > executionTime ? 'after_as_of' as const : 'at_or_before_as_of' as const
      return {...s,applicability,rows:observedRows.filter(r => r.queryId === s.queryId).map(({queryId:_,...r}) => r)}
    })
    const executed = observations.filter(s => s.applicability === 'at_or_before_as_of' && s.queryStatus !== 'not_queried')
    const platformStatus = coverage?.truncated || observations.some(s => s.applicability === 'unknown_time') ? 'requires_verification' : !executed.length ? 'not_queried' : executed.every(s => s.status === 'failed') ? 'query_failed' : 'requires_verification'
    const gaps = [
      ...(incomplete.length ? ['missing_official_source'] : []),
      ...(formal.some(e => originTime(e) == null || e.eventType === 'review' && (e.decidedYear == null || e.reviewOutcome == null || e.batchSeq == null)) ? ['missing_cycle_semantics'] : []),
      ...(identityGap ? ['identity_unresolved'] : []),
      ...(publishedNames.some(f => f.availability === 'unknown_legacy') ? ['published_name_not_retained'] : []),
      ...(publishedNames.some(f => f.availability === 'captured' && !f.nameKnown) ? ['published_name_unknown'] : []),
      ...(publishedNames.some(f => f.availability === 'unavailable') ? ['published_name_read_unavailable'] : []),
      ...(sourceVersions.some(s => !s.sha256 || s.removedAt) ? ['source_version_unavailable'] : []),
    ]
    const locationConflict = new Set(latest.map(d => d.reasonCode)).size > 1
    const subjectStatus = independent?.terminated || terminations.length ? 'terminated' : independent?.pending ? 'unresolved' : subjectGap ? 'unresolved' : 'not_established'
    const regionStatus = independent ? independent.region : locationConflict || subjectGap ? 'unresolved' : latest[0]?.reasonCode === 'moved_out' ? 'outside_ningbo' : latest[0]?.reasonCode === 'moved_in' ? 'ningbo' : 'not_established'
    const versionHeads = heads.map(decisionVersionInput)
    // A proven termination remains an exclusion even if another independent
    // dimension is unresolved. The old projection is retained explicitly below.
    const formalEvidence = events.filter(e => e.source === 'jxj').map(e => ({eventId:e.id,revision:e.revision,eventType:e.eventType,year:e.year,batchSeq:e.batchSeq,decidedYear:e.decidedYear,reviewOutcome:e.reviewOutcome,...(!legacy && (e.formalValidity || e.validityInvalid) ? {formalValidity:e.formalValidity ?? null,validityInvalid:e.validityInvalid ?? false} : {}),evidenceIds:evidence.filter(v => v.eventId === e.id).map(v => v.id)}))
    const formalBasis = events.filter(e => e.source === 'jxj').map(e => `event:${e.id}@${e.revision}`).join('\n')
    const platformPresentation: string[] = []
    if (platformSource) {
      const sourceLabel = { recognized_list:'认定目录', business_list:'关联办理', apply_list:'申报记录' }[platformSource.source]
      const matter = { recognition:'认定', apply:'申请', review:'复核', update:'更新', unknown:'事项未知' }[platformSource.matter]
      platformPresentation.push(`采用来源：${sourceLabel}；事项：${matter}；结果：${platformSource.source === 'recognized_list' ? '有效' : platformSource.statusRaw ?? '通过'}；平台原名：${platformSource.platformName ?? '未知'}`)
      if (platformSource.businessYear != null) platformPresentation.push(`业务年度：${platformSource.businessYear}`)
      if (platformSource.businessTime.raw) platformPresentation.push(`${platformSource.businessTimeKind === 'submission' ? '申报时间' : '认定时间'}：${platformSource.businessTime.raw}`)
      if (platformSource.period.from.raw && platformSource.period.until.raw) {
        platformPresentation.push(`有效期间：${platformSource.period.from.raw} 至 ${platformSource.period.until.raw}（含首尾）`)
      } else if (platformSource.businessYear != null && title !== 'little_giant') {
        platformPresentation.push(`有效期间（年度规则）：${platformSource.businessYear}–${platformSource.businessYear + 3}；${platformSource.businessYear + 3} 年起到期`)
      } else platformPresentation.push('有效期间未提供明确起止；小巨人按资格保留规则判断')
    }
    const decisionVersionInputs = [versionHeads, decisionAssessments, []]
    row.assessment = {
      titleCode:title,group,
      ...(effectiveMode ? {effectiveQualification:{status:effectiveStatus,...(platformSource ? {source:platformSource} : {}),localRuleBasis,presentationBasis:[...platformPresentation,...dispositionBasis,...(supportingTitle && !frozenInheritance ? [] : effectiveFormal.cycles).flatMap(c => { const validity = c.anchor?.formalValidity; const source = validity && evidence.find(e => e.id === validity.evidenceId); return c.periodBasis ? [c.periodBasis + (source ? `；正式来源：${source.sourceFile}；第 ${validity!.statementPages.join('、')} 页` : '')] : [] }),...current.map(a => `${a.qualification.basis} [${a.qualification.validFrom},${a.qualification.validUntil})`),...(exclusions?.statements ?? [])],basis:[formalBasis,...(platformSource ? [row.basis] : []),...dispositionBasis,...migrationBasis,...localRuleBasis,...(exclusions?.refs ?? [])].filter(Boolean).join('\n'),notes:[...row.notes,...effectiveFormal.notes,...gaps.map(gap => ({missing_official_source:'正式公布出处缺失',missing_cycle_semantics:'认定或复核周期资料不完整',identity_unresolved:'主体身份对应尚未核实',published_name_not_retained:'公布名称未留档',published_name_unknown:'公布名称未知',published_name_read_unavailable:'公布名称读取不可用',source_version_unavailable:'来源文件版本不可用'}[gap] ?? '资料缺口待核实'))]}} : {}),
      cycles:qualification.cycles.map(c => ({originYear:c.originYear,batchSeq:c.batch,precision:'year'})),
      versions:{facts:assessmentDigest(independent ? [enterprise,events,aliases,independent] : [enterprise,events,aliases]),sources:assessmentDigest(currentRules ? [evidence,sourceVersions,publishedNames,dispositionInputs,...platformFacts] : [evidence,sourceVersions,publishedNames]),decisions:assessmentDigest(currentRules ? [...decisionVersionInputs,dispositionInputs,...platformFacts] : decisionVersionInputs),observations:assessmentDigest([coverage,observedRows])},
      officialQualification:{group:officialGroup,message:officialGroup === 'eligible' ? '正式资格当前有效（按已录入的年份或已核实有效期间）' : officialGroup === 'excluded' ? '正式资格不纳入当前有效；历史依据保留' : '正式资格待核；已有公布及具体缺口保留',basis:effectiveMode ? formalBasis : [row.basis,...migrationBasis].filter(Boolean).join('\n'),notes:officialNotes},
      subject:{status:subjectStatus,message:subjectStatus === 'terminated' ? '已确认注销或主体终止，全部称号排除；迁回不恢复主体' : subjectStatus === 'unresolved' ? '主体事实适用性待核' : '未见可适用的已确认主体终止事实；不据此证明存续',decisionIds:terminations.map(d => d.id)},
      region:{status:regionStatus,message:regionStatus === 'outside_ningbo' ? '已确认迁出，不纳入宁波当前结果；不据此认定全国称号撤销' : regionStatus === 'ningbo' ? '已确认迁回或迁入宁波；主体及称号资格分别判断' : regionStatus === 'unresolved' ? '主体地域事实适用性或生效顺序待核' : '未见可适用的迁移决定；沿用正式公布地域范围',decisionIds:latest.map(d => d.id)},
      platform:{status:platformStatus,comparison:'not_established',message:platformStatus === 'not_queried' ? '截至评估时点尚无可适用平台查询；其它观察保留' : platformStatus === 'query_failed' ? '平台查询失败，不等于平台无记录，也不否定正式资格' : '平台观察已保留；同主体、称号、周期、时点及覆盖尚需核实，未自动确认一致或未同步',truncated:coverage?.truncated ?? false,observations},
      completeness:{status:gaps.length ? 'incomplete' : 'recorded',message:gaps.length ? '资料仍有缺口；未留档名称或来源版本未知不等于资格无效' : '既有字段已记录；未推断具体有效日或未录入的政策条款',gaps,publishedNames,eventIds:events.filter(e => incomplete.some(v => v.id === e.id) || e.source === 'jxj' && e.eventType === 'review' && (e.year == null || e.batchSeq == null || e.decidedYear == null || e.reviewOutcome == null)).map(e => e.id),fieldGaps:events.filter(e => e.source === 'jxj').flatMap(e => diagnoseOfficialEventFields(e).fieldGaps.map(gap => ({eventId:e.id,...gap})))},
      evidence:formalEvidence,sourceVersions,references:[...row.references],notes:[...row.notes],
      shadow:{legacyGroup,difference:group === legacyGroup ? null : '已确认主体终止优先排除；旧投影的其它未决缺口保留'},
    }
  }
  for (const upper of [giant, specialized]) if (upper?.assessment && row.assessment) {
    // Dependencies apply even while ineligible, so revocation/restoration changes
    // the lower title version without rewriting any formal history.
    row.assessment.versions.facts = assessmentDigest([row.assessment.versions.facts, upper.assessment.versions.facts])
    row.assessment.versions.sources = assessmentDigest([row.assessment.versions.sources, upper.assessment.versions.sources])
    if (frozenInheritance) row.assessment.effectiveQualification?.presentationBasis?.push(...localRuleBasis)
    else {
      row.assessment.versions.decisions = assessmentDigest([row.assessment.versions.decisions, upper.assessment.versions.decisions])
      if (upper === supportingTitle && upper.assessment.effectiveQualification && row.assessment.effectiveQualification) {
        row.assessment.effectiveQualification.supportingTitle = upper.assessment.titleCode
        row.assessment.effectiveQualification.presentationBasis?.push(...upper.assessment.effectiveQualification.presentationBasis ?? [])
        if (upper.assessment.effectiveQualification.source) row.assessment.effectiveQualification.source = upper.assessment.effectiveQualification.source
      }
    }
  }
  return { row, group, effectiveStatus, applicablePublication: formal.some(event => qualificationEventAppliesAt(event, year, day)) }
}

export type CurrentQualificationTitle = Pick<CurrentQualificationAssessment,
  'titleCode' | 'group' | 'cycles' | 'officialQualification' | 'subject' | 'region' | 'evidence' | 'sourceVersions' | 'shadow'>
  & { effectiveQualification: NonNullable<CurrentQualificationAssessment['effectiveQualification']>;
    applicablePublication: boolean; fieldGaps: NonNullable<CurrentQualificationAssessment['completeness']['fieldGaps']> }

export type CurrentQualificationInput = Omit<CandidateSource,
  'readLegacyHeads' | 'readLegacyAssessment' | 'readLegacyReceipt' | 'readLegacyObservation' | 'readCoverage' | 'readPublishedNames' | 'readPlatformEffects'>
  & { platformReferences: readonly CurrentPlatformReference[] }

export type LoadedCurrentQualificationInput = CurrentQualificationInput & Pick<CandidateSource,
  'readCoverage' | 'readPublishedNames' | 'readPlatformEffects'>

export function evaluateLoadedCurrentQualification(
  asOf: number, inputs: ReadonlyMap<CurrentTitle, LoadedCurrentQualificationInput>,
  filterTitle?: CurrentTitle, mode: 'scan' | 'detail' | 'workbook' = 'detail', observePresentation?: CurrentPublishedNameObservation,
) {
  const evaluated = new Map<CurrentTitle, CandidateResult>()
  const year = Number(qualificationDay(asOf).slice(0, 4))
  const titles = mode === 'workbook' ? CURRENT_TITLES.slice(0, CURRENT_TITLES.indexOf(filterTitle!) + 1) : CURRENT_TITLES
  for (const title of titles) {
    const input = inputs.get(title)!
    const filtering = title === filterTitle && mode !== 'workbook'
    const result = evaluateCandidate(input, () => { throw new Error('Qualification dependencies must be evaluated in title order') },
      input.enterprise.id, title, year, asOf, filtering, mode !== 'scan', mode === 'scan' ? undefined : {},
      filtering, input.platformReferences, title === filterTitle ? observePresentation : undefined,
      { giant: evaluated.get('little_giant')?.row, specialized: evaluated.get('specialized_sme')?.row, qualificationOnly: mode === 'scan' })
    evaluated.set(title, result)
  }
  return evaluated
}

export type LegacyQualificationInput = LoadedCurrentQualificationInput & Pick<CandidateSource,
  'readLegacyHeads' | 'readLegacyAssessment' | 'readLegacyReceipt' | 'readLegacyObservation'>

export function assessLegacyQualificationInputs(enterpriseId: number, asOf: number, inputs: ReadonlyMap<CurrentTitle, LegacyQualificationInput>): CurrentQualificationSnapshot {
  const assessmentVersion = LEGACY_QUALIFICATION_ASSESSMENT_VERSION
  const date = new Date(asOf)
  const titles = CURRENT_TITLES.map(title => {
    const input = inputs.get(title)!
    const result = evaluateCandidate(input, () => { throw new Error('Legacy qualification does not inherit titles') },
      input.enterprise.id, title, date.getUTCFullYear(), asOf, false, true, { assessmentVersion }, false, undefined, undefined)
    return result.row.assessment!
  })
  const scope = { enterpriseId, asOf: date.toISOString(), ruleVersion: LEGACY_CURRENT_RULE_VERSION, assessmentVersion }
  return { ...scope, snapshotId: assessmentDigest([scope, titles]), titles }
}

export function currentQualificationSnapshot(enterpriseId: number, asOf: number, titles: CurrentQualificationAssessment[]): CurrentQualificationSnapshot {
  const scope = { enterpriseId, asOf: new Date(asOf).toISOString(), ruleVersion: CURRENT_RULE_VERSION, assessmentVersion: QUALIFICATION_ASSESSMENT_VERSION }
  return { ...scope, snapshotId: assessmentDigest([scope, titles]), titles }
}

export function assessCurrentQualificationInputs(enterpriseId: number, asOf: number, inputs: ReadonlyMap<CurrentTitle, CurrentQualificationInput>) {
  const titles: CurrentQualificationTitle[] = [...evaluateLoadedCurrentQualification(asOf, inputs).values()].map(result => {
    const { titleCode, group, cycles, officialQualification, subject, region, evidence, sourceVersions, effectiveQualification, shadow, completeness } = result.row.assessment!
    return { titleCode, group, cycles, officialQualification, subject, region, evidence, sourceVersions,
      effectiveQualification: effectiveQualification!, shadow, fieldGaps: completeness.fieldGaps ?? [],
      applicablePublication: result.applicablePublication }
  })
  return { enterpriseId, asOf: new Date(asOf).toISOString(), ruleVersion: CURRENT_RULE_VERSION, assessmentVersion: QUALIFICATION_ASSESSMENT_VERSION, titles }
}
