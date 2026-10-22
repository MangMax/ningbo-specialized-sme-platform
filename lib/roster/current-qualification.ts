import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createDrizzleLogger } from '../logging/drizzle'
import { sql } from 'drizzle-orm'
import * as schema from '../../db/schema'
import { currentQualification102 } from '../../server/utils/decision-lifecycle-102'
import { listRecordCorrespondenceRefs } from '../../server/utils/record-correspondence'
import type Database from 'better-sqlite3'
import { identityFunctions } from './enterprise-read-snapshot'
import { readQueryAssessment } from './query-assessment'
import { relationScopeSql, TITLE_RDJB_CODES } from './current-platform-scope'
import { normalizeName, normalizeUscc } from '../domain'
import { identityKeys, type IdentityKeyVariants } from './current-identity-keys'
import { computeTitleLifecycle, type LifecycleEvent } from './lifecycle'
import { sourcePositionForSequence, RDJB_TITLE_CODES } from '../platform/recognized-evidence'
import { recognizedFilterFacts } from './recognized-filter-facts'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'
export { CURRENT_TITLES }
export type { CurrentTitle }

export const CURRENT_RULE_VERSION = 'current-roster-116-v8'
export type CurrentGroup = 'eligible' | 'pending' | 'excluded'
export interface CurrentQualificationWitness {
  cycle: { originYear: number; batchSeq: number | null }
  awardEventId: number | null
  recognition: { precision: 'year'; year: number }
  matchedValidYear: number | null
  matchedMaintenance: { year: number; batch: number | null } | null
  correspondenceId: number | null
  conditionQueryId: number | null
}
export interface CurrentRow {
  enterpriseId: number; name: string; uscc: string | null; district: string | null
  publishedNames: string[]; aliases: string[]; firstYear: number | null
  basis: string; reviews: string; publication: string; notes: string[]; references: string[]
  group: CurrentGroup
  qualificationWitnesses?: CurrentQualificationWitness[]
  recognition?: { precision: 'year'; year: number } | null
  matchedValidYears?: number[]
  matchedMaintenance?: { year: number; batch: number | null }[]
  /** Read-only facts used by the workbook; deliberately absent from task hash JSON. */
  workbookFacts?: CurrentWorkbookFacts
}
export interface CurrentWorkbookFacts {
  events: Array<{ id: number; eventType: string; year: number | null; batchSeq: number | null; decidedYear: number | null; reviewOutcome: string | null; source: string }>
  evidence: Array<{ eventId: number; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }>
  migration: Array<{ basis: string; awardYear: number | null; validFrom: string; validUntil: string; publicationScope: string }>
  platform: Array<{ interface: string; queriedAt: string }>
  assessments: Array<{ explanationValidity: string; queryCoverage: string; noRecord: boolean }>
  correspondenceNeedsRevalidation: boolean
}
const readers = new WeakMap<Database.Database, ReturnType<typeof drizzle<typeof schema>>>()
export function prepareCurrentReader(db: Database.Database) {
  let reader=readers.get(db)
  if (!reader) { reader=drizzle(db,{schema,logger:createDrizzleLogger({connection:'current_qualification'})}); readers.set(db,reader) }
  identityFunctions(reader)
  return reader
}
type QualificationEvent = LifecycleEvent & { batchSeq: number | null }
interface CycleJudgment {
  originYear: number
  batch: number | null
  lastAwardYear: number
  failureYears: number[]
  group: CurrentGroup
  notes: string[]
  awardEventIds: number[]
}
const awardTime = (e: QualificationEvent) => e.decidedYear ?? e.year
const originTime = (e: QualificationEvent) => e.year ?? (e.eventType === 'award' ? awardTime(e) : null)
const factTime = (e: QualificationEvent) => e.eventType === 'award' ? awardTime(e) : e.decidedYear
interface CycleFacts {
  awards: QualificationEvent[]
  passed: QualificationEvent[]
  failed: QualificationEvent[]
  gaps: QualificationEvent[]
  failureYears: number[]
  lastAward: number
  lastPassed: number
  lastFailure: number
}
const latestFact = (events: QualificationEvent[]) => Math.max(...events.map(e => factTime(e)!))
function hasUsableTime(event: QualificationEvent, originYear: number, year: number) {
  const time = factTime(event)
  return time != null && originYear <= time && time <= year
}

/** Separate known facts from uncertain facts before deciding whether a gap matters. */
function cycleFacts(events: QualificationEvent[], ambiguous: QualificationEvent[], originYear: number, year: number): CycleFacts {
  const awards: QualificationEvent[] = [], passed: QualificationEvent[] = [], failed: QualificationEvent[] = [], gaps = [...ambiguous]
  for (const event of events) {
    const batchKnown = event.batchSeq != null || event.eventType === 'award'
    if (!hasUsableTime(event,originYear,year) || !batchKnown) gaps.push(event)
    else if (event.eventType === 'award') awards.push(event)
    else if (event.reviewOutcome === 'passed') passed.push(event)
    else if (event.reviewOutcome === 'failed') failed.push(event)
    else gaps.push(event)
  }
  // A known failure date survives uncertain batch applicability. It is still a
  // temporal witness for cross-cycle recovery, even when this cycle has a gap.
  const failureYears = [...events,...ambiguous].filter(e => e.eventType === 'review' && e.reviewOutcome === 'failed' && hasUsableTime(e,originYear,year)).map(e => e.decidedYear!)
  return {awards,passed,failed,gaps,failureYears,lastAward:latestFact(awards),lastPassed:latestFact(passed),lastFailure:latestFact(failed)}
}

/** A gap only yields to a later fact that neutralizes every possible effect.
 * A grant restores, a final failure terminates, and a pass only extends: it
 * cannot neutralize an earlier possible failure. Equal years prove no order.
 */
function gapResolvedBy(gap: QualificationEvent, facts: CycleFacts, originYear: number, year: number): string | null {
  if (!hasUsableTime(gap,originYear,year)) return null
  const time = factTime(gap)!
  if (time < facts.lastAward) return '后续明确重新认定'
  // A termination/renewal only settles its own known batch. An ambiguous batch
  // might refer to a different batch with a different validity window.
  if (gap.batchSeq != null && time < facts.lastFailure && facts.lastFailure > facts.lastAward && facts.lastFailure > facts.lastPassed) return '较晚明确终止'
  return null
}

/** Adjudicate an originating cycle using only applicable, unresolved evidence. */
function adjudicateCycle(events: QualificationEvent[], originYear: number, batch: number | null, year: number, ambiguous: QualificationEvent[] = []): CycleJudgment {
  const facts = cycleFacts(events,ambiguous,originYear,year)
  // Only the latest actual grant can support a restored qualification. Older
  // grants remain in the adjudication and evidence history, but not filters.
  const result: CycleJudgment = {originYear,batch,lastAwardYear:facts.lastAward,failureYears:facts.failureYears,group:'pending',notes:[],awardEventIds:facts.awards.filter(e => awardTime(e) === facts.lastAward).map(e => e.id)}
  const unresolved: QualificationEvent[] = []
  for (const gap of facts.gaps) {
    const resolved = gapResolvedBy(gap,facts,originYear,year)
    if (resolved) result.notes.push(`旧缺口 event:${gap.id}（日期/批次/结论）由${resolved}消解，历史及出处保留`)
    else unresolved.push(gap)
  }
  if (originYear > year) result.notes.push('原认定年份尚未生效，当前周期待确认')
  else if (unresolved.length) {
    for (const event of unresolved) result.notes.push(`event:${event.id} ${event.eventType === 'award' ? '认定日期/批次' : '复核结论/结论年份/批次'}不完整或无法证明被后续事实消解，当前周期待确认`)
  } else if (facts.lastFailure >= facts.lastAward && facts.failed.length) {
    if (facts.lastFailure === facts.lastAward || facts.lastPassed >= facts.lastFailure) result.notes.push('对应周期失败与通过/认定恢复冲突；未确认重新认定恢复，待确认')
    else { result.group='excluded'; result.notes.push('对应认定周期复核明确不通过，未见后续重新认定恢复') }
  } else {
    // Failure/recovery and gap applicability are settled first. The shared
    // lifecycle supplies the unchanged three-year calculation for known anchors.
    const current = computeTitleLifecycle([...facts.awards,...facts.passed])
    if (current.dueYear != null && current.dueYear > year) result.group='eligible'
    else result.notes.push('已到复核年份，未见明确延续结果，待确认')
  }
  return result
}

function hasUnresolvedRecovery(current: CycleJudgment[], history: CycleJudgment[]) {
  for (const cycle of current) {
    // A definite final termination no longer depends on whether the earlier
    // grant restored eligibility. Otherwise only the last grant is applicable.
    if (cycle.group === 'excluded') continue
    for (const older of history) {
      if (older.originYear < cycle.originYear && older.failureYears.includes(cycle.lastAwardYear)) return true
    }
  }
  return false
}

function adjudicateCurrentCycles(formal: QualificationEvent[], year: number): { group: CurrentGroup; notes: string[]; originYear: number; cycles: CycleJudgment[] } {
  const byYear = new Map<number, Map<number | null, QualificationEvent[]>>()
  const unknown: QualificationEvent[] = []
  for (const event of formal) {
    const origin = originTime(event)
    if (origin == null) { unknown.push(event); continue }
    let batches = byYear.get(origin)
    if (!batches) { batches = new Map(); byYear.set(origin,batches) }
    const events = batches.get(event.batchSeq) ?? []
    events.push(event); batches.set(event.batchSeq,events)
  }
  const judgments = [...byYear].flatMap(([origin,batches]) => {
    const known = [...batches].filter(([batch]) => batch != null)
    const unassigned = batches.get(null) ?? []
    const grants = unassigned.filter(e => e.eventType === 'award')
    const reviews = unassigned.filter(e => e.eventType === 'review')
    // Retain the possibility that each unassigned grant is a separate batch;
    // do not borrow it to repair a known batch. Each possible batch must also
    // withstand the unassigned reviews. If all are eligible, merging any subset
    // of these grants into an eligible batch cannot invalidate it. This proves
    // eligibility without choosing a batch or enumerating partitions. An expired
    // or unresolved separate grant keeps its effect instead of vanishing in the
    // latest known grant. Unknown reviews remain applicability gaps.
    const possible = [
      ...known.map(([batch,events]) => adjudicateCycle(events,origin,batch,year,reviews)),
      ...grants.map(grant => adjudicateCycle([grant],origin,null,year,reviews)),
    ]
    return possible.length ? possible : [adjudicateCycle(reviews,origin,null,year)]
  })
  // Selection follows adjudication, retains *every* batch of the current year,
  // and never uses the latest passed event to erase another batch or a failure.
  const originYear = Math.max(...judgments.map(c => c.originYear))
  const current = judgments.filter(c => c.originYear === originYear)
  const notes = current.flatMap(c => c.notes.map(note => `${c.originYear}年/批次${c.batch ?? '?'}：${note}`))
  let group: CurrentGroup = current[0]?.group ?? 'pending'
  if (!current.length) notes.push('缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格')
  if (new Set(current.map(c => c.group)).size > 1) { group='pending'; notes.push('同年各批次裁定不一致，保留全部批次的结论及未决缺口') }
  // A new award may resolve old unknown-origin history. A renewal never supplies
  // this recovery boundary, even if its conclusion is more recent.
  const latestAward = Math.max(...judgments.map(c => c.lastAwardYear))
  const unknownReviews = unknown.filter(e => e.eventType === 'review')
  const relevantUnknown = unknownReviews.filter(e => e.decidedYear == null || e.decidedYear >= latestAward)
  if (unknownReviews.length > relevantUnknown.length) notes.push('较早复核原周期未知；后续明确新认定恢复，旧缺口及出处保留')
  if (relevantUnknown.length) { group='pending'; notes.push('复核对应原认定周期未知，待确认') }
  if (unknown.some(e => e.eventType === 'award')) { group='pending'; notes.push('认定日期缺失，当前周期待确认') }
  // Preserve #116's same-year re-award ordering boundary, using actual award
  // dates and already partitioned older cycles, never a renewal's anchor year.
  if (hasUnresolvedRecovery(current,judgments)) { group='pending'; notes.push('同年认定恢复与旧周期失败结论顺序冲突，待确认') }
  return { group, notes, originYear, cycles: current }
}

/** A bounded enterprise × title projection; source blobs never enter this reader. */
export function readCurrentCandidate(db: Database.Database, enterpriseId: number, title: CurrentTitle, year: number, executionTime = Date.now(), keys?: { queries: IdentityKeyVariants; relations: IdentityKeyVariants }, includeFilterFacts = false): CurrentRow {
  return createCurrentCandidateReader(db)(enterpriseId,title,year,executionTime,keys,includeFilterFacts)
}

/** Request-local prepared queries only: no rows or qualification results survive a read. */
export function createCurrentCandidateReader(db: Database.Database) {
  const reader=prepareCurrentReader(db)
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
  const headsQuery=reader.select().from(d).where(sql`${d.id} in (${headIds})`).prepare()
  return function readCandidate(enterpriseId: number, title: CurrentTitle, year: number, executionTime = Date.now(), keys?: { queries: IdentityKeyVariants; relations: IdentityKeyVariants }, includeFilterFacts = false, includeReferences = true): CurrentRow {
  const enterprise = statement('select id,name,name_norm,uscc_norm,district,city from enterprise where id=?').get(enterpriseId) as any
  const events = statement(`select e.id,e.event_type as eventType,e.year,e.decided_year as decidedYear,e.batch_seq as batchSeq,e.review_outcome as reviewOutcome,e.revision,r.name_raw as nameRaw,r.uscc_raw as usccRaw,r.source from record r join record_event e on e.record_id=r.id where r.enterprise_id=? and r.title_code=?`).all(enterpriseId,title) as (LifecycleEvent & { batchSeq: number|null; nameRaw: string|null; usccRaw: string|null; source: string; revision: number })[]
  const evidence = statement(`select v.id,v.record_event_id as eventId,v.source_file as sourceFile,v.attachment,v.list_no as listNo,v.page from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id where r.enterprise_id=? and r.title_code=? order by v.id`).all(enterpriseId,title) as (CurrentWorkbookFacts['evidence'][number] & {id:number})[]
  const formal = events.filter(e => e.source === 'jxj' && ['award','review'].includes(e.eventType) && evidence.some(v => v.eventId === e.id))
  const lifecycle = computeTitleLifecycle(formal)
  const row: CurrentRow = { enterpriseId, name: enterprise.name, uscc: enterprise.uscc_norm, district: enterprise.district, publishedNames: [...new Set(formal.map(e => e.nameRaw).filter((n): n is string => !!n))], aliases: [], firstYear: lifecycle.firstRecognitionYear, basis: formal.map(e => `event:${e.id}@${e.revision} ${e.eventType} ${e.year ?? ''}/${e.batchSeq ?? ''} 结论年:${e.decidedYear ?? ''}`).join('\n'), reviews: formal.filter(e => e.eventType === 'review').map(e => `${e.year ?? '?'}年原认定批次；结论年${e.decidedYear ?? '?'}；${e.reviewOutcome ?? '未知'}`).join('\n'), publication: formal.length ? '已见本称号宁波公布记录' : '尚未完成公布匹配核实', notes: [], references: evidence.map(v => `evidence:${v.id} ${v.sourceFile} ${v.attachment ?? ''} 序号:${v.listNo ?? ''}`), group: 'pending' }
  const qualification = adjudicateCurrentCycles(formal, year)
  let qualificationSource: 'formal' | 'migration' = 'formal'
  let migrationAwardYears: number[] = []
  row.group = qualification.group
  if (formal.length) row.notes.push(...qualification.notes)
  if (!formal.length && events.length && events.every(e => e.eventType === 'nurture')) {
    row.group='excluded'; row.notes.push('纯入库培育，不构成称号')
  }
  const aliases = statement("select id,name,version from enterprise_alias where enterprise_id=? and verification_status='confirmed' order by id").all(enterpriseId) as {id:number;name:string;version:number}[]
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
  // #102 owns the head; #108 owns evidence applicability, including legacy reviews.
  const rdjb=TITLE_RDJB_CODES[title]
  const relationKeys=keys ? identityKeys(keys.relations,enterprise.uscc_norm) : null
  const unassigned=relationKeys ? 'r.uscc_raw in (select value from json_each(@relationKeys))' : 'roster84_uscc(r.uscc_raw)=@uscc'
  const platformRefs=includeReferences ? statement(`select r.id,r.query_id as queryId,q.interface,q.queried_at as queriedAt from platform_relation r join platform_query q on q.id=r.query_id where r.id in (select id from platform_relation where enterprise_id=@enterpriseId union select r.id from platform_relation r ${relationKeys ? 'indexed by platform_relation_uscc_query_idx' : ''} where r.enterprise_id is null and ${unassigned}) and ${relationScopeSql} order by r.id`).all({enterpriseId,...(relationKeys ? {relationKeys:JSON.stringify(relationKeys)} : {uscc:normalizeUscc(enterprise.uscc_norm)||null}),title,rdjb}) as ({id:number;queryId:number} & CurrentWorkbookFacts['platform'][number])[] : []
  row.references.push(...platformRefs.map(r => 'platform-relation:' + r.id + ' query:' + r.queryId))
  const headRows = headsQuery.all({enterpriseId})
  const heads = CURRENT_TITLES.flatMap(titleCode => (['missing_in_miit','extra_in_miit'] as const).flatMap(direction => headRows.filter(d => d.titleCode === titleCode && d.direction === direction))).map(d => ({...d,queryId:d.evidenceQueryId,relationId:d.evidenceRelationId,movedTitle:d.movedInTitleCode,movedCity:d.movedInCity,movedYear:d.movedInYear,movedBatch:d.movedInBatch}))
  const correspondences=listRecordCorrespondenceRefs(reader,{enterpriseId,titleCode:title})
  row.references.push(...correspondences.map(c => 'correspondence:' + c.id + '@' + c.revision + ' ' + c.status + (c.requiresRevalidation ? ' 来源需重新核实' : '')))
  const subjectFacts: any[] = []
  const workbookAssessments: CurrentWorkbookFacts['assessments'] = []
  const workbookMigration: CurrentWorkbookFacts['migration'] = heads.filter(d => d.titleCode === title && d.reasonCode === 'moved_in' && d.lifecycleAction !== 'withdraw').flatMap(d => {
    const parsed = currentQualification102.safeParse(d.currentQualification)
    return parsed.success ? [{basis:parsed.data.basis,awardYear:parsed.data.awardYear ?? null,validFrom:parsed.data.validFrom,validUntil:parsed.data.validUntil,publicationScope:parsed.data.publicationCheck.scope}] : []
  })
  let subjectGap = false
  let qualificationGap = false
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
    const assessment = readQueryAssessment(reader,{enterpriseId,titleCode:d.titleCode,direction:d.direction as 'missing_in_miit'|'extra_in_miit'},keys?.queries)
    if (d.titleCode === title) workbookAssessments.push({explanationValidity:assessment.explanationValidity.status,queryCoverage:assessment.queryCoverage.status,
      noRecord:assessment.queryCoverage.sources.find(source => source.titleCode === d.titleCode && source.subjectMatch === 'exact_uscc')?.outcome === 'no_record'})
    row.references.push(`decision:${d.id} explanationValidity:${assessment.explanationValidity.status} queryCoverage:${assessment.queryCoverage.status}`)
    // A maintain receipt can adopt legacy facts without rewriting their null metadata.
    const reviewed = statement('select basis,effective_at as effectiveAt from evidence_review_receipt_114 where decision_id=? and reviewed_revision_id is not null order by id desc limit 1').get(d.id) as {basis:string;effectiveAt:string}|undefined
    const effectiveAt=d.effectiveAt ?? reviewed?.effectiveAt
    const gap = assessment.explanationValidity.status !== 'valid' || !(d.basis ?? reviewed?.basis) || !effectiveAt || !Number.isFinite(Date.parse(effectiveAt)) || Date.parse(effectiveAt) > executionTime
    const source=d.relationId ? statement('select enterprise_id as enterpriseId,uscc_raw as uscc,verification_status as verificationStatus from platform_relation where id=?').get(d.relationId) as {enterpriseId:number|null;uscc:string|null;verificationStatus:string}|undefined : undefined
    const ownUscc=normalizeUscc(enterprise.uscc_norm), sourceUscc=normalizeUscc(source?.uscc)
    const sourceConflict=source && (source.enterpriseId != null && source.enterpriseId !== enterpriseId || sourceUscc && ownUscc && sourceUscc !== ownUscc)
    const sourceGap=!!d.currentQualification && (!source || source.verificationStatus !== 'confirmed' || source.enterpriseId == null && (!ownUscc || sourceUscc !== ownUscc))
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
  if (new Set(latest.map(d => d.reasonCode)).size > 1) { row.group='pending'; row.notes.push('同一生效时点主体事实冲突，待确认') }
  else if (latest.length) {
    const d = latest[0]
    if (d.reasonCode === 'moved_out') { row.group='excluded'; row.notes.push('已确认外迁') }
    else {
      row.notes.push('已确认迁入宁波' + (d.movedCity ? '；原城市：' + d.movedCity : ''))
      if (d.titleCode === title && d.movedTitle && d.movedTitle !== title) { qualificationGap=true; row.group='pending'; row.notes.push('迁入资格依据不属于本称号') }
      {
        const attested = subjectFacts.filter(f => f.reasonCode === 'moved_in' && f.titleCode === title).flatMap(f => {
          const parsed=currentQualification102.safeParse(f.currentQualification)
          return parsed.success && parsed.data.titleCode === title ? [{decision:f,qualification:parsed.data}] : []
        })
        row.basis=[row.basis,...attested.map(a => `decision:${a.decision.id} ${a.qualification.basis} [${a.qualification.validFrom},${a.qualification.validUntil})${a.qualification.awardYear == null ? '' : ' 明确认定年:'+a.qualification.awardYear}`)].filter(Boolean).join('\n')
        row.notes.push(...attested.map(a => '迁入资格断言；公布核对范围：' + a.qualification.publicationCheck.scope))
        const applicable = attested.filter(({qualification:q}) => Date.parse(q.validFrom) <= executionTime && executionTime < Date.parse(q.validUntil))
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
        if (current.length) {
          if (qualification.group !== 'eligible') {
            qualificationSource='migration'
            migrationAwardYears=[...new Set(current.flatMap(({qualification:q}) => q.awardYear == null ? [] : [q.awardYear]))]
          }
          row.group='eligible'; if (!formal.length) row.publication='迁入；未见宁波该称号公布记录（限已核对范围）'
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
  if (incomplete.some(e => originTime(e) == null || originTime(e)! >= qualification.originYear)) {
    row.group='pending'; row.notes.push('存在影响当前周期的无正式出处/未确认认定或复核，当前资格待确认')
  }
  if (!formal.length && row.group === 'pending') {
    row.notes.push(...qualification.notes)
    if (correspondences.length) row.notes.push('对应边不是已确认当前资格；需核实具体资格与公布匹配范围')
  }
  if (includeFilterFacts && row.group === 'eligible') {
    // The selected adjudication already separates current cycles and feasible
    // unknown-batch grants. Never reconstruct them from basis/reviews strings.
    const awards = qualificationSource === 'formal' ? qualification.cycles.flatMap(cycle => cycle.awardEventIds.map(awardEventId => ({ cycle, awardEventId }))) : []
    const linked = correspondences.filter(ref => ref.type === 'event_recognized' && ref.role === 'recognized_corrob' && ref.status === 'confirmed' && !ref.requiresRevalidation && ref.eventId != null && ref.relationId != null)
    const filterSource = statement(`select q.id as queryId,q.title_code as titleCode,q.rdjb,r.sequence_no as sequenceNo,
      json_extract(q.collection_evidence,'$.pages') as pages,
      json_extract(q.collection_evidence,'$.effectiveConditions.rddqrq') as conditionValidYear,
      json_extract(q.collection_evidence,'$.effectiveConditions.whpcyear') as conditionMaintenanceYear,
      json_extract(q.collection_evidence,'$.effectiveConditions.whpc') as conditionMaintenanceBatch,
      json_extract(r.raw_fields,'$.rddqrq') as rawValid,
      json_extract(r.raw_fields,'$.whpcyear') as rawMaintenanceYear,
      json_extract(r.raw_fields,'$.whpc') as rawMaintenanceBatch
      from platform_relation r join platform_query q on q.id=r.query_id
      where r.id=@relationId and (r.enterprise_id=@enterpriseId or (r.enterprise_id is null and @uscc is not null and roster84_uscc(r.uscc_raw)=@uscc)) and r.verification_status='confirmed'
      and q.interface='recognized_list' and q.status='success'
      and json_extract(q.collection_evidence,'$.status')='success'
      and json_extract(q.collection_evidence,'$.source')='queryBusList'
      and json_extract(q.collection_evidence,'$.effectiveConditions.combination')='and'
      and json_extract(q.collection_evidence,'$.completeness')='complete'
      and json_extract(q.collection_evidence,'$.fullRange')=1`)
    row.qualificationWitnesses = awards.flatMap<CurrentQualificationWitness>(({cycle,awardEventId}) => {
      const event = formal.find(item => item.id === awardEventId)!
      const base = { cycle: { originYear: cycle.originYear, batchSeq: cycle.batch }, awardEventId, recognition: { precision: 'year' as const, year: awardTime(event)! } }
      const matches = linked.filter(ref => ref.eventId === awardEventId).flatMap(ref => {
        const source = filterSource.get({relationId:ref.relationId,enterpriseId,uscc:normalizeUscc(enterprise.uscc_norm)||null,title,rdjb}) as {queryId:number;titleCode:string|null;rdjb:string;sequenceNo:number;pages:string|null;conditionValidYear:unknown;conditionMaintenanceYear:unknown;conditionMaintenanceBatch:unknown;rawValid:unknown;rawMaintenanceYear:unknown;rawMaintenanceBatch:unknown}|undefined
        if (!source) return []
        let pages: unknown
        try { pages = source.pages ? JSON.parse(source.pages) : null } catch { return [] }
        const positioned = Array.isArray(pages) ? sourcePositionForSequence({pages} as Parameters<typeof sourcePositionForSequence>[0],source.sequenceNo).sourceRdjb : null
        const scope = source.rdjb.split(',').filter(Boolean)
        const fromScope = scope.length === 1 ? RDJB_TITLE_CODES[scope[0]!] : null
        const fromPosition = positioned ? RDJB_TITLE_CODES[positioned] : null
        if (source.titleCode && source.titleCode !== title || fromScope && fromScope !== title || fromPosition && fromPosition !== title
          || (fromPosition ?? source.titleCode ?? fromScope) !== title) return []
        const projected = recognizedFilterFacts(
          {titleCode:fromPosition ?? source.titleCode ?? fromScope!,schema:'queryBusList'},
          {rddqrq:source.rawValid,whpcyear:source.rawMaintenanceYear,whpc:source.rawMaintenanceBatch},
          {rddqrq:source.conditionValidYear,whpcyear:source.conditionMaintenanceYear,whpc:source.conditionMaintenanceBatch})
        return [{...base,matchedValidYear:projected.validYear,matchedMaintenance:projected.maintenance,correspondenceId:ref.id,conditionQueryId:source.queryId}]
      })
      return matches.length ? matches : [{...base,matchedValidYear:null,matchedMaintenance:null,correspondenceId:null,conditionQueryId:null}]
    })
    // Independent returned rows for one grant can disagree. Preserve every
    // source witness, but do not turn either conflicting value into a filter hit.
    // Missing batches do not contradict a known value or inherit it from another row.
    for (const awardEventId of new Set(row.qualificationWitnesses.map(w => w.awardEventId))) {
      const witnesses = row.qualificationWitnesses.filter(w => w.awardEventId === awardEventId)
      if (new Set(witnesses.flatMap(w => w.matchedValidYear == null ? [] : [w.matchedValidYear])).size > 1)
        for (const witness of witnesses) witness.matchedValidYear = null
      const maintenanceYears = new Set(witnesses.flatMap(w => w.matchedMaintenance == null ? [] : [w.matchedMaintenance.year]))
      const maintenanceBatches = new Set(witnesses.flatMap(w => w.matchedMaintenance?.batch == null ? [] : [w.matchedMaintenance.batch]))
      if (maintenanceYears.size > 1)
        for (const witness of witnesses) witness.matchedMaintenance = null
      else if (maintenanceBatches.size > 1)
        for (const witness of witnesses) if (witness.matchedMaintenance) witness.matchedMaintenance.batch = null
    }
    if (qualificationSource === 'migration') row.qualificationWitnesses = migrationAwardYears.map(awardYear => ({cycle:{originYear:awardYear,batchSeq:null},awardEventId:null,recognition:{precision:'year',year:awardYear},matchedValidYear:null,matchedMaintenance:null,correspondenceId:null,conditionQueryId:null}))
    row.recognition = row.qualificationWitnesses[0]?.recognition ?? null
    row.matchedValidYears = [...new Set(row.qualificationWitnesses.flatMap(witness => witness.matchedValidYear == null ? [] : [witness.matchedValidYear]))].sort((a,b) => a-b)
    row.matchedMaintenance = row.qualificationWitnesses.flatMap(witness => witness.matchedMaintenance ? [witness.matchedMaintenance] : []).filter((fact,index,all) => all.findIndex(other => other.year === fact.year && other.batch === fact.batch) === index).sort((a,b) => a.year-b.year || (a.batch ?? 0)-(b.batch ?? 0))
  }
  Object.defineProperty(row,'workbookFacts',{value:{
    events:events.map(({id,eventType,year,batchSeq,decidedYear,reviewOutcome,source}) => ({id,eventType,year,batchSeq,decidedYear,reviewOutcome,source})),
    evidence:evidence.map(({eventId,sourceFile,attachment,listNo,page}) => ({eventId,sourceFile,attachment,listNo,page})),
    migration:workbookMigration,
    platform:[...new Map(platformRefs.map(({queryId,interface:interfaceName,queriedAt}) => [queryId,{interface:interfaceName,queriedAt}])).values()],
    assessments:workbookAssessments,
    correspondenceNeedsRevalidation:correspondences.some(c => c.requiresRevalidation),
  } satisfies CurrentWorkbookFacts,enumerable:false})
  return row
}
}
