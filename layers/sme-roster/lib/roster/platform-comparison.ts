/** #426 pure comparison interface. Formal qualification and annual selection retain their existing authorities. */
import type { CurrentQualificationAssessment as Assessment, CurrentQualificationSnapshot as Snapshot } from './current-qualification'
import { adjudicateQualificationCycles, originTime, type CycleJudgment, type QualificationEvent } from './qualification-cycles'
import type { AnnualProcessInput, AnnualProcessSourceRefs, EventAnnualProcessRead, AnnualFinalQualification } from './annual-process'
import type { PlatformBusinessGroup, PlatformBusinessObservationRef } from '../platform/business-record'
import type { RelationSource } from './correspondence-view'
import type { PlatformNormalizationConflict } from '../platform/normalization'
import type { QueryCoverageSource } from './query-assessment'
import type { PlatformLiveQueryResult } from '../platform/live-query'
import type { readAnnualDecisionRefs } from '../../server/utils/annual-correspondence'

type Immutable<T> = T extends readonly (infer E)[] ? readonly Immutable<E>[]
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T
// Never import a DB reader as a value. Actual current validity comes from the existing reader.
type CurrentProcessDecision = ReturnType<typeof readAnnualDecisionRefs>[number]
type FormalEvent = Assessment['evidence'][number]
type FormalCycle = Assessment['cycles'][number]
type NormalizedProcess = Pick<RelationSource, 'declareKind' | 'appliedAt' | 'status' | 'province'> & {
  normalizationConflicts: PlatformNormalizationConflict[]
}
// Replace open Record<string,unknown> evidence with the existing normalized projection only.
// No rawFields, raw_response, sourceText, personuuid or arbitrary scope payload.
type Observation = Omit<PlatformBusinessObservationRef, 'evidence'> & {
  evidence: {
    process: NormalizedProcess & { eventType: FormalEvent['eventType'] }
    temporal: { relationYear: RelationSource['year']; relationBatch: RelationSource['batch']; awardBatchLabel: RelationSource['awardBatchLabel'] }
    source: { identityOnly: boolean }
  }
}
type Group = Omit<PlatformBusinessGroup, 'observationRefs'> & { observationRefs: Observation[] }
type AnnualInput = Omit<AnnualProcessInput, 'groups'> & { groups: Group[] }
// Raw query metadata projection is needed for source/title/page/error/limits proof.
// QueryCoverageSource.status/outcome alone must never be reinterpreted as asOf truth.
type QueryMetadata = Pick<PlatformLiveQueryResult,
  'source' | 'status' | 'effectiveConditions' | 'titleScope' | 'pages' |
  'completeness' | 'fullRange' | 'unfinished' | 'error' | 'limits'>
type QueryWitness = {
  source: QueryCoverageSource
  queryKey: string
  metadata: QueryMetadata | null
}
export type CandidateComparisonInput = Immutable<{
  version: 'platform-comparison-410-v1'
  legacy: Snapshot // complete unchanged T2 including snapshotId, not a replacement digest
  titleCode: Assessment['titleCode']
  formal: {
    // Direct canonical assessment fields, not an eligible flag supplied by a caller.
    assessment: Pick<Assessment, 'titleCode' | 'group' | 'officialQualification' | 'subject' | 'region' |
      'cycles' | 'versions' | 'evidence' | 'sourceVersions' | 'completeness' | 'correspondence'>
    // Complete instance multiset selected by authority, validated without replacing legacy.
    // eventIds are direct members; ambiguous reviews are dependencies, not direct members.
    cycles: {
      cycle: FormalCycle
      judgment: Pick<CycleJudgment, 'anchor' | 'originYear' | 'batch' | 'group' | 'awardEventIds'>
      eventIds: FormalEvent['eventId'][]
    }[]
  }
  queries: { sources: QueryWitness[]; truncated: boolean }
  processes: {
    // No precomputed latest=true, terminal=true, confirmed=true or eligible=true.
    // core calls existing buildAnnualProcess with this complete normalized input.
    input: AnnualInput
    sourceRefs: AnnualProcessSourceRefs
    sourceGeneration: EventAnnualProcessRead['sourceGeneration']
    // All current/protective refs, not merely confirmed final refs. N has no finalCandidate.
    currentDecisionRefs: CurrentProcessDecision[]
    // Optional existing read enrichment; absent cannot be invented as confirmed.
    finalQualification: AnnualFinalQualification | null
  }[]
}>
// Candidate public name only; no implementation/factory exists yet.
// comparePlatformComparison(input: CandidateComparisonInput): versioned projection
// Output shape/reason order/digest protocol: Contract-one-page.md:7,16.
// Contract validation cross-checks scope, formal cycle/event revisions/evidence hashes,
// query IDs, group record/version/hash, sourceRefs generation and current decision refs.
// Inputs are already normalized by authority; a TS type is not authentication.

import { createHash } from 'node:crypto'
import { buildAnnualProcess } from './annual-process'

export const COMPARISON_VERSION = 'platform-comparison-410-v1' as const
export const COMPARISON_REASONS = [
  'no_record_in_applicable_scope', 'same_event_result_agrees', 'same_event_result_not_reflected',
  'query_failed', 'not_queried', 'observation_after_as_of', 'invalid_query_time', 'coverage_incomplete',
  'metadata_truncated', 'cycle_unresolved', 'temporal_order_unresolved', 'formal_unresolved',
  'source_requires_revalidation', 'source_conflict', 'platform_status_unmapped',
] as const
export type ComparisonReason = typeof COMPARISON_REASONS[number]
type State = 'synchronized' | 'unsynchronized' | 'not_established'
type ObservationState = 'records' | 'no_record' | 'query_failed' | 'not_queried' | 'unknown'
type Scope = Pick<Snapshot, 'enterpriseId' | 'asOf' | 'ruleVersion' | 'assessmentVersion'> & { titleCode: Assessment['titleCode']; legacySnapshotId: string }
export interface SafeComparisonRefs {
  eventIds: number[]; evidenceIds: number[]; queryIds: number[]; relationIds: number[]
  events: { id: number; revision: number }[]
  sources: { evidenceId: number; sha256: string | null }[]
  versions: { recordId: number; versionId: number; contentHash: string }[]
  decisions: { id: number; revision: number }[]
  sourceGenerations: string[]
}
export interface PlatformComparison {
  version: typeof COMPARISON_VERSION; scope: Scope
  observation: { state: ObservationState; sources: { queryId: number; queryStatus: string; outcome: QueryCoverageSource['outcome']; applicability: 'applicable' | 'inapplicable' | 'unknown'; reasons: ComparisonReason[] }[] }
  comparison: { state: State; cycles: { originYear: number; batchSeq: number | null; state: State; reasons: ComparisonReason[]; refs: SafeComparisonRefs }[] }
  inputDigest: string; resultDigest: string
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
/** Reject non-JSON, cycles, sparse arrays and explicit undefined; never let stringify drop them. */
function jsonCopy(value: unknown, seen = new Set<object>()): any {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || !value || seen.has(value)) throw new Error('invalid_json_input')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('invalid_json_input')
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new Error('invalid_json_input')
  seen.add(value)
  let out: any
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('invalid_json_input')
    out = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('invalid_json_input')
      out.push(jsonCopy(descriptor.value, seen))
    }
  } else {
    out = Object.create(null)
    for (const key of Object.keys(value).sort(compare)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('invalid_json_input')
      out[key] = jsonCopy(descriptor.value, seen)
    }
  }
  seen.delete(value)
  return out
}
const canonical = (value: unknown): string => JSON.stringify(jsonCopy(value))
function instant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null
  const date = value.slice(0, 10), day = Date.parse(date + 'T00:00:00Z'), time = Date.parse(value)
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === date && Number.isFinite(time) ? time : null
}
type CheckedEvent = CandidateComparisonInput['formal']['assessment']['evidence'][number]
type CheckedSource = CandidateComparisonInput['formal']['assessment']['sourceVersions'][number]
interface CheckedFormal {
  events: Map<number, CheckedEvent>
  dependencies: Map<Binding, { eventIds: number[]; sources: CheckedSource[] }>
}
const sortedIds = (ids: readonly number[]) => [...ids].sort((a,b)=>a-b)
const multiset = (rows: readonly unknown[]) => rows.map(canonical).sort(compare)
function narrowJudgment(j: Binding['judgment']) {
  const a=j.anchor
  return {originYear:j.originYear,batch:j.batch,group:j.group,awardEventIds:sortedIds(j.awardEventIds),
    anchor:a===null?null:{id:a.id,eventType:a.eventType,year:a.year,batchSeq:a.batchSeq,decidedYear:a.decidedYear,reviewOutcome:a.reviewOutcome}}
}
function guards(input: CandidateComparisonInput): CheckedFormal {
  jsonCopy(input)
  const { legacy, formal, titleCode } = input
  const scope = { enterpriseId: legacy.enterpriseId, asOf: legacy.asOf, ruleVersion: legacy.ruleVersion, assessmentVersion: legacy.assessmentVersion }
  if (input.version !== COMPARISON_VERSION || instant(legacy.asOf) == null || !Number.isSafeInteger(legacy.enterpriseId) || legacy.enterpriseId < 1 || legacy.snapshotId !== sha(JSON.stringify([scope, legacy.titles]))) throw new Error('invalid_legacy_snapshot')
  const selected = legacy.titles.filter(t => t.titleCode === titleCode)
  if (selected.length !== 1) throw new Error('invalid_selected_scope')
  const actual = selected[0]!
  const assessmentKeys = ['titleCode','group','officialQualification','subject','region','cycles','versions','evidence','sourceVersions','completeness','correspondence']
  if (!same(Object.keys(formal.assessment).sort(compare), assessmentKeys.sort(compare))) throw new Error('invalid_selected_assessment')
  if (actual.evidence.some(e=>!positiveId(e.eventId)||!positiveId(e.revision)||e.evidenceIds.some(id=>!positiveId(id)))) throw new Error('invalid_formal_reference')
  for (const key of Object.keys(formal.assessment) as (keyof typeof formal.assessment)[]) if (canonical(formal.assessment[key]) !== canonical(actual[key])) throw new Error('invalid_selected_assessment')
  if (formal.cycles.length !== actual.cycles.length || formal.cycles.length > 40) throw new Error('invalid_cycle_join')
  const events = new Map<number, CheckedEvent>()
  for(const e of actual.evidence){
    if(events.has(e.eventId))throw new Error('invalid_formal_reference')
    events.set(e.eventId,e)
  }
  const actualKeys=new Set(actual.cycles.map(canonical))
  // Keep existing local diagnostics before the stronger completeness checks.
  for (const binding of formal.cycles) {
    const { cycle, judgment, eventIds } = binding, key = canonical(cycle)
    if (!actualKeys.has(key) || judgment.originYear !== cycle.originYear || judgment.batch !== cycle.batchSeq || (judgment.anchor !== null && !eventIds.includes(judgment.anchor.id))) throw new Error('invalid_cycle_join')
    for (const id of [...eventIds, ...judgment.awardEventIds]) {
      const e = events.get(id)
      if (!e || originTime({ ...e, id: e.eventId }) !== cycle.originYear || e.batchSeq !== cycle.batchSeq) throw new Error('invalid_cycle_event')
    }
    if(judgment.anchor!==null){
      const e = events.get(judgment.anchor.id)!
      for (const key of ['eventType','year','decidedYear','reviewOutcome','batchSeq'] as const) if (e[key] !== judgment.anchor[key]) throw new Error('invalid_cycle_anchor')
    }
  }
  const facts:QualificationEvent[]=[]
  const byYear=new Map<number,Map<number|null,QualificationEvent[]>>()
  let latestOrigin=-Infinity
  for(const e of events.values()){
    if(!['award','review'].includes(e.eventType)||!e.evidenceIds.length)continue
    const fact={id:e.eventId,eventType:e.eventType,year:e.year,batchSeq:e.batchSeq,decidedYear:e.decidedYear,reviewOutcome:e.reviewOutcome}
    facts.push(fact)
    const origin=originTime(fact)
    if(origin===null)continue
    latestOrigin=Math.max(latestOrigin,origin)
    const batches=byYear.get(origin)??new Map<number|null,QualificationEvent[]>()
    const bucket=batches.get(fact.batchSeq)??[];bucket.push(fact);batches.set(fact.batchSeq,bucket);byYear.set(origin,batches)
  }
  facts.sort((a,b)=>a.id-b.id)
  const current=byYear.get(latestOrigin),unassigned=current?.get(null)??[]
  const reviews=unassigned.filter(e=>e.eventType==='review'),grants=unassigned.filter(e=>e.eventType==='award')
  const partitions=[...(current??[])].filter(([batch])=>batch!==null).map(([,rows])=>rows)
  partitions.push(...grants.map(e=>[e]))
  if(current&&!partitions.length&&reviews.length)partitions.push(reviews)
  if(partitions.length>40)throw new Error('invalid_cycle_join')
  // One full validation plus at most forty partition witnesses. Never replace supplied results.
  const year=new Date(legacy.asOf).getUTCFullYear(),authority=adjudicateQualificationCycles(facts,year)
  const skinny=authority.cycles.map(c=>({originYear:c.originYear,batchSeq:c.batch,precision:'year'}))
  if(!same(multiset(skinny),multiset(actual.cycles))||!same(multiset(skinny),multiset(formal.cycles.map(b=>b.cycle))))throw new Error('invalid_cycle_join')
  const expected=new Map<string,number>(),members=new Map<string,{eventIds:number[]}>(),witnesses:ReturnType<typeof narrowJudgment>[]=[]
  for(const direct of partitions){
    const dependencies=direct===reviews?direct:[...direct,...reviews]
    const local=adjudicateQualificationCycles([...dependencies].sort((a,b)=>a.id-b.id),year)
    if(local.cycles.length!==1)throw new Error('invalid_cycle_join')
    const judgment=local.cycles[0]!,ids=sortedIds(direct.map(e=>e.id))
    const tuple=canonical({cycle:{originYear:judgment.originYear,batchSeq:judgment.batch,precision:'year'},judgment:narrowJudgment(judgment),eventIds:ids})
    expected.set(tuple,(expected.get(tuple)??0)+1)
    members.set(canonical(ids),{eventIds:sortedIds(dependencies.map(e=>e.id))})
    witnesses.push(narrowJudgment(judgment))
  }
  if(!same(multiset(witnesses),multiset(authority.cycles.map(narrowJudgment))))throw new Error('invalid_cycle_join')
  const sourcesByEvidence=new Map<number,CheckedSource[]>()
  for(const source of actual.sourceVersions){const rows=sourcesByEvidence.get(source.evidenceId)??[];rows.push(source);sourcesByEvidence.set(source.evidenceId,rows)}
  const dependencies:CheckedFormal['dependencies']=new Map()
  for(const b of formal.cycles){
    if(new Set(b.eventIds).size!==b.eventIds.length)throw new Error('invalid_cycle_event')
    const ids=sortedIds(b.eventIds),member=members.get(canonical(ids))
    if(!member)throw new Error('invalid_cycle_event')
    if(new Set(b.judgment.awardEventIds).size!==b.judgment.awardEventIds.length)throw new Error('invalid_cycle_join')
    const tuple=canonical({cycle:b.cycle,judgment:narrowJudgment(b.judgment),eventIds:ids}),count=expected.get(tuple)??0
    if(!count)throw new Error('invalid_cycle_join')
    expected.set(tuple,count-1)
    const evidenceIds=new Set(member.eventIds.flatMap(id=>events.get(id)!.evidenceIds))
    dependencies.set(b,{eventIds:member.eventIds,sources:[...evidenceIds].flatMap(id=>sourcesByEvidence.get(id)??[])})
  }
  if([...expected.values()].some(count=>count!==0))throw new Error('invalid_cycle_join')
  return {events,dependencies}
}
// Only these arrays are sets. Pages and all other arrays retain their order.
const SET_ARRAYS = new Set(['titles','cycles','evidence','sourceVersions','groups','observationRefs','existingCorrespondenceIds','existingCorrespondences','currentDecisionRefs','decisionRefs','eventIds','awardEventIds','evidenceIds','decisionIds','relationIds','queryIds','observations','titleScopeRefs','coverage','scopeGaps','sources','publishedNames','fieldGaps'])
function normalized(value: any, key = ''): any {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const rows = value.map(v => normalized(v))
    return SET_ARRAYS.has(key) ? rows.sort((a,b) => compare(canonical(a), canonical(b))) : rows
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const k of Object.keys(value)) result[k] = normalized(value[k], k)
  // Explicit absent optional projections. Explicit undefined was already rejected.
  if ('fetchedCount' in value && 'page' in value && !('maxPage' in value)) result.maxPage = null
  if ('publishedNames' in value && 'gaps' in value && !('fieldGaps' in value)) result.fieldGaps = null
  if ('groups' in value && 'coverage' in value && 'event' in value && !('scopeGaps' in value)) result.scopeGaps = null
  return result
}
const reasons = (values: readonly ComparisonReason[]) => COMPARISON_REASONS.filter(r => values.includes(r))
const emptyRefs = (): SafeComparisonRefs => ({eventIds:[],evidenceIds:[],queryIds:[],relationIds:[],events:[],sources:[],versions:[],decisions:[],sourceGenerations:[]})
type Binding = CandidateComparisonInput['formal']['cycles'][number]
type Process = CandidateComparisonInput['processes'][number]
type Query = CandidateComparisonInput['queries']['sources'][number]
type CheckedQuery = { q: Query; time: number | null; usable: boolean; complete: boolean; unrestricted: boolean; outcome: QueryCoverageSource['outcome']; failed: boolean; notQueried: boolean; reasons: ComparisonReason[] }
const rdjb: Record<string,string> = {innovative_sme:'1',specialized_sme:'2',little_giant:'3'}
const sourceInterface: Record<string,string> = {recognized_list:'queryBusList',business_list:'businessList',apply_list:'queryList'}
const same = (a: unknown,b: unknown) => canonical(a) === canonical(b)
const positiveId = (v: number) => Number.isSafeInteger(v) && v > 0
function checkedQuery(q: Query, title: string, asOf: number): CheckedQuery {
  const s=q.source,m=q.metadata,t=instant(s.queriedAt)
  const r: CheckedQuery={q,time:t,usable:false,complete:false,unrestricted:false,outcome:'unknown',failed:false,notQueried:false,reasons:[]}
  if(t==null){r.reasons=['invalid_query_time'];return r}
  if(t>asOf){r.reasons=['observation_after_as_of'];return r}
  const nativeApply=s.interface==='apply_list'
  const titleScope=m && (nativeApply
    ? s.titleCode===null && s.rdjb==='' && m.titleScope.mode==='source_default' && m.titleScope.rdjb.length===0
    : s.titleCode===title && m.titleScope.rdjb.length===1 && m.titleScope.rdjb[0]===rdjb[title] && s.rdjb===rdjb[title])
  if(!positiveId(s.queryId) || !m || sourceInterface[s.interface]!==m.source || !titleScope) {r.reasons=['coverage_incomplete'];return r}
  r.usable=true
  r.notQueried=s.queryStatus==='not_queried' && m.status==='not_queried'
  r.failed=['failed','auth_failed'].includes(s.queryStatus) || ['failed','auth_failed'].includes(m.status) || m.error!==null || m.pages.some(p=>p.status!=='success')
  if(r.notQueried){r.reasons=['not_queried'];return r}
  if(r.failed){r.reasons=['query_failed'];return r}
  const consistent=s.queryStatus===m.status && same(s.conditions,m.effectiveConditions) && same(s.pages,m.pages) && s.fullRange===m.fullRange && s.completeness===m.completeness && same(s.unfinished,m.unfinished)
  const pages=m.pages,size=m.limits.pageSize
  const pageShape=pages.length>0 && pages.length<=50 && Number.isSafeInteger(size) && size>0 && size<=50 && pages[0]!.page===1 && pages.every((p,i)=>p.source===m.source && (nativeApply ? p.rdjb==null : p.rdjb===rdjb[title]) && p.status==='success' && p.error===null && p.page===i+1 && Number.isSafeInteger(p.fetchedCount) && p.fetchedCount>=0 && p.fetchedCount<=size)
  const totals=[...new Set(pages.map(p=>p.declaredTotal).filter(v=>v!==null))]
  const maxPages=[...new Set(pages.map(p=>p.maxPage).filter(v=>v!=null))]
  const count=pages.reduce((n,p)=>n+p.fetchedCount,0),last=pages.at(-1)
  const finished=totals.length===1 ? Number.isSafeInteger(totals[0]) && totals[0]!>=0 && count===totals[0] && pages.every(p=>p.fetchedCount===Math.min(size,Math.max(0,totals[0]!-(p.page-1)*size))) : totals.length===0 && (maxPages.length===1 ? maxPages[0]===last?.page && pages.slice(0,-1).every(p=>p.fetchedCount===size) : maxPages.length===0 && last?.fetchedCount===0 && pages.slice(0,-1).every(p=>p.fetchedCount===size))
  r.complete=consistent && pageShape && finished && m.fullRange && m.completeness==='complete' && !m.unfinished.length && ['success','no_record'].includes(m.status) && (m.status!=='no_record'||count===0)
  const c=m.effectiveConditions
  r.unrestricted=s.subjectMatch==='exact_uscc' && !!c.uscc && q.queryKey===c.uscc && c.combination==='and' && Object.keys(c).every(k=>['uscc','combination'].includes(k))
  if(r.complete && r.unrestricted) r.outcome=count===0?'no_record':s.outcome==='records'?'records':'unknown'
  if(!r.complete)r.reasons=['coverage_incomplete']
  else if(!r.unrestricted)r.reasons=['cycle_unresolved']
  return r
}
function cycleRefs(checked: CheckedFormal,b: Binding): SafeComparisonRefs {
  const out=emptyRefs(),dependency=checked.dependencies.get(b)!
  out.eventIds=[...dependency.eventIds]
  out.events=out.eventIds.map(id=>({id,revision:checked.events.get(id)!.revision}))
  out.evidenceIds=sortedIds([...new Set(out.eventIds.flatMap(id=>checked.events.get(id)!.evidenceIds))])
  const eventIds=new Set(out.eventIds)
  out.sources=dependency.sources.filter(s=>eventIds.has(s.eventId)&&checked.events.get(s.eventId)!.evidenceIds.includes(s.evidenceId)).map(s=>({evidenceId:s.evidenceId,sha256:s.sha256})).sort((a,b)=>a.evidenceId-b.evidenceId)
  return out
}
function processResult(p: Process,input: CandidateComparisonInput,b: Binding,queries: CheckedQuery[],historyQueries: CheckedQuery[],refs: SafeComparisonRefs): {state:State; reasons:ComparisonReason[]} {
  const a=input.formal.assessment,e=p.input.event,s=p.sourceRefs,official=a.evidence.find(v=>v.eventId===e.id)
  const result=(reason:ComparisonReason):{state:State;reasons:ComparisonReason[]}=>({state:'not_established',reasons:[reason]})
  if(!official || !b.eventIds.includes(e.id) || e.record.enterpriseId!==input.legacy.enterpriseId || e.record.titleCode!==input.titleCode || s.event.id!==e.id) return result('cycle_unresolved')
  if(s.event.revision!==official.revision || p.sourceGeneration!==sha(JSON.stringify(p.sourceRefs)))return result('source_requires_revalidation')
  if(['eventType','year','decidedYear','reviewOutcome'].some(k=>(e as any)[k] !== (official as any)[k] || (s.event as any)[k] !== (official as any)[k]))return result('source_requires_revalidation')
  if(s.scope.enterpriseId!==input.legacy.enterpriseId || s.scope.titleCode!==input.titleCode || s.scope.ruleVersion!=='annual-process-250-v1' || s.scope.businessYear!==(e.eventType==='review'?e.decidedYear:e.year) || s.scope.declareKind!==(e.eventType==='award'?'apply':'review'))return result('cycle_unresolved')
  if(!same(p.input.coverage,s.coverage))return result('coverage_incomplete')
  if(p.input.groups.some(g=>g.conflicts.length || g.observationRefs.some(r=>r.conflicts.length || r.evidence.process.normalizationConflicts.length)))return result('source_conflict')
  if(p.input.groups.some(g=>g.businessRecord.groupState!=='verified'||g.observationRefs.some(r=>r.businessRecord.groupState!=='verified')))return result('source_requires_revalidation')
  const annual=buildAnnualProcess(jsonCopy(p.input) as AnnualProcessInput)
  if(annual.reasons.some(r=>r.includes('potential_later')||r==='latest_archive_incomplete'))return result('coverage_incomplete')
  const latest=annual.steps.find(step=>step.id===annual.latestStepId)
  if(!latest)return result('cycle_unresolved')
  if(annual.reasons.includes('latest_status_not_terminal'))return result('platform_status_unmapped')
  if(annual.reasons.some(r=>r!=='official_result_mismatch'))return result('coverage_incomplete')
  const observations=latest.groups.flatMap(g=>g.observationRefs).filter(r=>latest.latestVersionRefs.some(v=>v.interface===r.interface && v.recordId===r.businessRecord.recordId && v.versionId===r.businessRecord.versionId && v.relationIds.includes(r.relationId)))
  if(!observations.length)return result('source_requires_revalidation')
  // annual uses every observation in the selected logical step for stable fields,
  // conflicts and chronology. Historical support must remain bound even though
  // only current endpoint versions need a current confirmation.
  const dependencies=latest.groups.flatMap(g=>g.observationRefs)
  for(const r of dependencies){
    const current=observations.includes(r)
    const m=r.businessRecord,q=(current?queries:historyQueries).find(q=>q.q.source.queryId===r.queryId && q.usable && q.complete && q.unrestricted && q.outcome==='records')
    if(!q)return result('coverage_incomplete')
    // Query IDs do not license borrowing another endpoint's coverage. Every
    // annual claim must match the actual query metadata and observation source.
    const coverage=p.input.coverage.filter(c=>c.queryId===r.queryId)
    if(q.q.source.interface!==r.interface || m.interface!==r.interface || q.q.source.queryStatus!==r.queryStatus || !coverage.length || coverage.some(c=>c.interface!==r.interface || c.queriedAt!==q.q.source.queriedAt || c.status!==q.q.source.queryStatus || c.completeness!==q.q.source.completeness || c.fullRange!==q.q.source.fullRange))return result('coverage_incomplete')
    const formalYear=official.decidedYear??official.year??Infinity
    if(current && new Date(q.time!).getUTCFullYear()<=formalYear)return result('temporal_order_unresolved')
    if(r.queryStatus!=='success' || r.queriedAt!==q.q.source.queriedAt || r.queryKey!==q.q.queryKey || r.titleCode!==input.titleCode || r.enterpriseId!==input.legacy.enterpriseId || r.target.eventId!==e.id || r.target.enterpriseId!==input.legacy.enterpriseId || r.target.titleCode!==input.titleCode || r.usccRaw!==e.record.usccRaw || e.record.usccRaw!==q.q.queryKey)return result('cycle_unresolved')
    // Protocol labels are explicit: retain legacy sha256; 64hex alone is not proof.
    if(m.groupState!=='verified'||m.identityState!=='resolved'||m.contentState!=='verified'||!m.recordId||!m.versionId||!['sha256','platform-row-json-v1'].includes(m.hashAlgorithm ?? '')||!m.contentHash||!/^[a-f0-9]{64}$/.test(m.contentHash))return result('source_requires_revalidation')
    if(!s.observations.some(v=>v.relationId===r.relationId && v.queryId===r.queryId && v.interface===r.interface && v.recordId===m.recordId && v.versionId===m.versionId && /^[a-f0-9]{64}$/.test(v.sourceFingerprint)) || !s.titleScopeRefs.some(v=>v.relationId===r.relationId && v.queryId===r.queryId && v.titleCode===input.titleCode && v.recordId===m.recordId && v.versionId===m.versionId))return result('source_requires_revalidation')
    // Latest capture comes from the trusted snapshot reader; its row counter is not the event counter.
    if(!s.evidence.length || !s.evidence.every(v=>official.evidenceIds.includes(v.id) && a.sourceVersions.some(src=>src.evidenceId===v.id && src.eventId===e.id && src.sha256===v.sha256 && src.removedAt===null && positiveId(src.capturedRevision ?? 0) && src.capturedSha256===src.sha256)))return result('source_requires_revalidation')
  }
  const current=p.currentDecisionRefs.filter(d=>observations.some(r=>r.relationId===d.relationId))
  if(p.currentDecisionRefs.some(d=>d.eventId===e.id && ['rejected','unlinked'].includes(d.status)) || current.some(d=>d.requiresRevalidation) || !current.some(d=>d.status==='confirmed'&&!d.requiresRevalidation&&d.endedAt===null&&d.eventId===e.id&&d.enterpriseId===input.legacy.enterpriseId&&d.titleCode===input.titleCode&&d.type==='event_process'&&d.role===(e.eventType==='award'?'supports_award':'supports_review')))return result('source_requires_revalidation')
  const mismatch=annual.reasons.includes('official_result_mismatch')
  if(!mismatch){const f=p.finalQualification;if(!annual.finalCandidateStepId||!f||f.stepId!==annual.finalCandidateStepId||f.status!=='confirmed'||f.reasons.length||!f.decisionRefs.length||!f.decisionRefs.every(d=>current.some(c=>c.id===d.id&&c.revision===d.revision&&c.relationId===d.relationId&&c.status==='confirmed'&&!c.requiresRevalidation)))return result('source_requires_revalidation')}
  refs.queryIds.push(...dependencies.map(r=>r.queryId));refs.relationIds.push(...dependencies.map(r=>r.relationId));refs.versions.push(...dependencies.map(r=>({recordId:r.businessRecord.recordId!,versionId:r.businessRecord.versionId!,contentHash:r.businessRecord.contentHash!})));refs.decisions.push(...current.filter(d=>d.status==='confirmed').map(d=>({id:d.id,revision:d.revision})));refs.sourceGenerations.push(p.sourceGeneration)
  return {state:mismatch?'unsynchronized':'synchronized',reasons:[mismatch?'same_event_result_not_reflected':'same_event_result_agrees']}
}
export function comparePlatformComparison(input: CandidateComparisonInput): PlatformComparison {
  const checked=guards(input)
  if(input.queries.sources.length>50 || input.processes.length>40)throw new Error('input_resource_limit')
  if(input.queries.sources.some(q=>Buffer.byteLength(canonical(q))>65536)||input.processes.some(p=>Buffer.byteLength(canonical(p.sourceRefs))>65536))throw new Error('input_resource_limit')
  const scope:Scope={enterpriseId:input.legacy.enterpriseId,titleCode:input.titleCode,asOf:input.legacy.asOf,ruleVersion:input.legacy.ruleVersion,assessmentVersion:input.legacy.assessmentVersion,legacySnapshotId:input.legacy.snapshotId}
  const all=input.queries.sources.map(q=>checkedQuery(q,input.titleCode,instant(scope.asOf)!))
  // Filter time before retry. Equal instants retain every statement, regardless of ID.
  const retryKey=(q:CheckedQuery)=>canonical([q.q.source.interface,q.q.metadata?.effectiveConditions??null,q.q.source.titleCode,q.q.metadata?.fullRange??null])
  const usable=all.filter(q=>q.usable)
  const selected=usable.filter(q=>!usable.some(other=>retryKey(q)===retryKey(other)&&other.time!>q.time!))
  const sufficient=selected.filter(q=>q.q.source.interface!=='apply_list'&&q.complete&&q.unrestricted&&q.outcome!=='unknown')
  const conflict=new Set(sufficient.map(q=>q.outcome)).size>1
  const truncated=input.queries.truncated
  const observationState:ObservationState=truncated||conflict?'unknown':sufficient.some(q=>q.outcome==='records')?'records':sufficient.some(q=>q.outcome==='no_record')?'no_record':selected.some(q=>q.failed)?'query_failed':all.some(q=>q.time==null)?'unknown':(!all.length||all.every(q=>q.reasons.includes('observation_after_as_of'))||selected.length>0&&selected.every(q=>q.notQueried))?'not_queried':'unknown'
  const observation:PlatformComparison['observation']={state:observationState,sources:all.map<PlatformComparison['observation']['sources'][number]>(q=>({queryId:q.q.source.queryId,queryStatus:['success','no_record','partial','failed','auth_failed','not_queried'].includes(q.q.source.queryStatus)?q.q.source.queryStatus:'unknown',outcome:q.usable&&q.complete?q.outcome:'unknown',applicability:q.usable?'applicable':q.time===null?'unknown':'inapplicable',reasons:reasons(q.reasons)})).sort((a,b)=>a.queryId-b.queryId||compare(canonical(a),canonical(b)))}
  const cycles:PlatformComparison['comparison']['cycles']=input.formal.cycles.map(b=>{
    const refs=cycleRefs(checked,b),rs:ComparisonReason[]=[],a=input.formal.assessment
    let state:State='not_established'
    if(truncated)rs.push('metadata_truncated')
    else if(conflict)rs.push('source_conflict')
    else if(b.cycle.batchSeq===null)rs.push('cycle_unresolved')
    else if(a.group!=='eligible'||a.officialQualification.group!=='eligible'||b.judgment.group!=='eligible')rs.push('formal_unresolved')
    else if(!refs.sources.length || refs.sources.some(s=>!s.sha256) || checked.dependencies.get(b)!.sources.some(s=>!s.sha256||s.removedAt!==null||s.sha256!==s.capturedSha256||!checked.events.get(s.eventId)?.evidenceIds.includes(s.evidenceId)||!refs.events.some(e=>e.id===s.eventId)||!positiveId(s.capturedRevision ?? 0)))rs.push('source_requires_revalidation')
    else {
      const applicable=input.processes.filter(p=>b.eventIds.includes(p.input.event.id))
      const processResults=applicable.map(p=>processResult(p,input,b,selected,all,refs))
      // Duplicate lineage pointing to a different event is a real assignment conflict.
      const relationEvents=new Map<number,Set<number>>()
      for(const p of input.processes)for(const g of p.input.groups)for(const r of g.observationRefs){const values=relationEvents.get(r.relationId)??new Set<number>();values.add(p.input.event.id);relationEvents.set(r.relationId,values)}
      if([...relationEvents.values()].some(v=>v.size>1))rs.push('source_conflict')
      else if(processResults.length){
        rs.push(...processResults.flatMap(r=>r.reasons))
        if(processResults.some(r=>r.reasons.includes('source_conflict')))state='not_established'
        else if(processResults.some(r=>r.state==='unsynchronized'))state='unsynchronized'
        else if(processResults.every(r=>r.state==='synchronized'))state='synchronized'
      }else if(sufficient.some(q=>q.outcome==='no_record')){
        const zeros=sufficient.filter(q=>q.outcome==='no_record'),year=Math.max(...b.eventIds.map(id=>{const e=checked.events.get(id)!;return e.decidedYear??e.year??Infinity}))
        if(zeros.some(q=>new Date(q.time!).getUTCFullYear()<=year))rs.push('temporal_order_unresolved')
        else {state='unsynchronized';rs.push('no_record_in_applicable_scope');refs.queryIds.push(...zeros.map(q=>q.q.source.queryId))}
      }else if(input.processes.length)rs.push('cycle_unresolved')
      else if(observationState==='records')rs.push(selected.some(q=>q.q.source.interface==='recognized_list')?'cycle_unresolved':'coverage_incomplete')
      else if(observationState==='query_failed')rs.push('query_failed')
      else if(!all.length||all.every(q=>q.notQueried))rs.push('not_queried')
      else rs.push(...all.flatMap(q=>q.reasons))
      if(!rs.length)rs.push('coverage_incomplete')
    }
    for(const key of Object.keys(refs) as (keyof SafeComparisonRefs)[]){
      const values=refs[key] as unknown[]
      ;(refs as any)[key]=[...new Map(values.map(v=>[canonical(v),v])).values()].sort((a,b)=>typeof a==='number'&&typeof b==='number'?a-b:compare(canonical(a),canonical(b)))
    }
    return {originYear:b.cycle.originYear,batchSeq:b.cycle.batchSeq,state,reasons:reasons(rs),refs}
  }).sort((a,b)=>a.originYear-b.originYear||(a.batchSeq??-1)-(b.batchSeq??-1)||compare(canonical(a),canonical(b)))
  let state:State='not_established'
  if(cycles.length&&!cycles.some(c=>c.reasons.includes('source_conflict'))){
    if(cycles.some(c=>c.state==='unsynchronized'))state='unsynchronized'
    else if(cycles.every(c=>c.state==='synchronized'))state='synchronized'
  }
  const comparison={state,cycles}
  const inputDigest=sha(canonical([COMPARISON_VERSION,scope,normalized(input)]))
  return {version:COMPARISON_VERSION,scope,observation,comparison,inputDigest,resultDigest:sha(canonical([inputDigest,observation,comparison]))}
}
