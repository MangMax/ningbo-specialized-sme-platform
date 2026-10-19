import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { latestDecision102 } from '../../server/utils/decision-lifecycle-102'
import { listRecordCorrespondenceRefs } from '../../server/utils/record-correspondence'
import type Database from 'better-sqlite3'
import { normalizeName, normalizeUscc } from '../domain'
import { computeTitleLifecycle, type LifecycleEvent } from './lifecycle'

export const CURRENT_RULE_VERSION = 'current-roster-116-v6'
export const CURRENT_TITLES = ['little_giant', 'specialized_sme', 'innovative_sme'] as const
export type CurrentTitle = typeof CURRENT_TITLES[number]
export type CurrentGroup = 'eligible' | 'pending' | 'excluded'
export interface CurrentRow {
  enterpriseId: number; name: string; uscc: string | null; district: string | null
  publishedNames: string[]; aliases: string[]; firstYear: number | null
  basis: string; reviews: string; publication: string; notes: string[]; references: string[]
  group: CurrentGroup
}
const readers = new WeakMap<Database.Database, ReturnType<typeof drizzle<typeof schema>>>()
function domainReader(db: Database.Database) {
  let reader=readers.get(db)
  if (!reader) { reader=drizzle(db,{schema}); readers.set(db,reader) }
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
  const result: CycleJudgment = {originYear,batch,lastAwardYear:facts.lastAward,failureYears:facts.failureYears,group:'pending',notes:[]}
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

function adjudicateCurrentCycles(formal: QualificationEvent[], year: number): { group: CurrentGroup; notes: string[]; originYear: number } {
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
  return { group, notes, originYear }
}

/** A bounded enterprise × title projection; source blobs never enter this reader. */
export function readCurrentCandidate(db: Database.Database, enterpriseId: number, title: CurrentTitle, year: number, executionTime = Date.now()): CurrentRow {
  const enterprise = db.prepare('select id,name,name_norm,uscc_norm,district,city from enterprise where id=?').get(enterpriseId) as any
  const events = db.prepare(`select e.id,e.event_type as eventType,e.year,e.decided_year as decidedYear,e.batch_seq as batchSeq,e.review_outcome as reviewOutcome,e.revision,r.name_raw as nameRaw,r.uscc_raw as usccRaw,r.source from record r join record_event e on e.record_id=r.id where r.enterprise_id=? and r.title_code=?`).all(enterpriseId,title) as (LifecycleEvent & { batchSeq: number|null; nameRaw: string|null; usccRaw: string|null; source: string; revision: number })[]
  const evidence = db.prepare(`select v.id,v.record_event_id as eventId,v.source_file as sourceFile,v.attachment,v.list_no as listNo,v.page from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id where r.enterprise_id=? and r.title_code=? order by v.id`).all(enterpriseId,title) as any[]
  const formal = events.filter(e => e.source === 'jxj' && ['award','review'].includes(e.eventType) && evidence.some(v => v.eventId === e.id))
  const lifecycle = computeTitleLifecycle(formal)
  const row: CurrentRow = { enterpriseId, name: enterprise.name, uscc: enterprise.uscc_norm, district: enterprise.district, publishedNames: [...new Set(formal.map(e => e.nameRaw).filter((n): n is string => !!n))], aliases: [], firstYear: lifecycle.firstRecognitionYear, basis: formal.map(e => `event:${e.id}@${e.revision} ${e.eventType} ${e.year ?? ''}/${e.batchSeq ?? ''} 结论年:${e.decidedYear ?? ''}`).join('\n'), reviews: formal.filter(e => e.eventType === 'review').map(e => `${e.year ?? '?'}年原认定批次；结论年${e.decidedYear ?? '?'}；${e.reviewOutcome ?? '未知'}`).join('\n'), publication: formal.length ? '已见本称号宁波公布记录' : '尚未完成公布匹配核实', notes: [], references: evidence.map(v => `evidence:${v.id} ${v.sourceFile} ${v.attachment ?? ''} 序号:${v.listNo ?? ''}`), group: 'pending' }
  const qualification = adjudicateCurrentCycles(formal, year)
  row.group = qualification.group
  row.notes.push(...qualification.notes)
  if (!formal.length && events.length && events.every(e => e.eventType === 'nurture')) {
    row.group='excluded'; row.notes.push('纯入库培育，不构成称号')
  }
  const aliases = db.prepare("select id,name,version from enterprise_alias where enterprise_id=? and verification_status='confirmed' order by id").all(enterpriseId) as {id:number;name:string;version:number}[]
  row.aliases = [...new Set(aliases.map(a => a.name))]
  row.references.push(...aliases.map(a => 'alias:' + a.id + '@' + a.version))
  const knownNames = new Set([enterprise.name,...row.aliases].map(name => normalizeName(name)))
  const unverifiedName = row.publishedNames.some(name => !knownNames.has(normalizeName(name)) && !formal.some(e => e.nameRaw === name && !!enterprise.uscc_norm && normalizeUscc(e.usccRaw) === enterprise.uscc_norm))
  if (unverifiedName || !row.publishedNames.length && formal.length) {
    row.group='pending'; row.publication='尚未完成公布匹配核实'; row.notes.push('公布名称与当前身份尚未完成确认对应')
  } else {
    for (const name of row.publishedNames.filter(n => normalizeName(n) !== normalizeName(row.name))) row.notes.push('已公布，公布名称为' + name + '；现已更名为' + row.name)
  }
  if (formal.some(e => e.usccRaw && enterprise.uscc_norm && normalizeUscc(e.usccRaw) !== enterprise.uscc_norm)) { row.group='pending'; row.notes.push('公布统代与当前主体存在身份冲突') }
  // #102 owns replacement/withdrawal. #108 applicability is not in main:
  // historical imports cannot silently become current subject or title facts.
  const rdjb=({little_giant:'3',specialized_sme:'2',innovative_sme:'1'} as const)[title]
  const platformRefs=db.prepare('select r.id,r.query_id as queryId from platform_relation r join platform_query q on q.id=r.query_id where r.enterprise_id=? and (q.title_code=? or q.rdjb=?) order by r.id').all(enterpriseId,title,rdjb) as {id:number;queryId:number}[]
  row.references.push(...platformRefs.map(r => 'platform-relation:' + r.id + ' query:' + r.queryId))
  const reader=domainReader(db)
  const heads = CURRENT_TITLES.flatMap(titleCode => (['missing_in_miit','extra_in_miit'] as const).map(direction => latestDecision102(reader,{enterpriseId,titleCode,direction}))).filter((d): d is NonNullable<typeof d> => !!d).map(d => ({...d,queryId:d.evidenceQueryId,relationId:d.evidenceRelationId,movedTitle:d.movedInTitleCode,movedCity:d.movedInCity,movedYear:d.movedInYear,movedBatch:d.movedInBatch}))
  const correspondences=listRecordCorrespondenceRefs(reader,{enterpriseId,titleCode:title})
  row.references.push(...correspondences.map(c => 'correspondence:' + c.id + '@' + c.revision + ' ' + c.status + (c.requiresRevalidation ? ' 来源需重新核实' : '')))
  if (!formal.length && correspondences.length) row.notes.push('对应边不是已确认当前资格；需核实具体资格与公布匹配范围')
  const subjectFacts: any[] = []
  let subjectGap = false
  for (const d of heads) {
    const subjectFact = ['moved_out','deregistered','moved_in'].includes(d.reasonCode ?? '')
    // Qualification explanations remain title-scoped. Legal-entity facts do not.
    if (d.titleCode !== title && !subjectFact && d.lifecycleAction !== 'withdraw') continue
    row.references.push('decision:' + d.id)
    if (d.lifecycleAction === 'withdraw') { row.notes.push('旧决定已撤回，不作为当前排除依据'); continue }
    if (d.verificationStatus !== 'confirmed' || d.status !== 'confirmed_reason') {
      if (subjectFact) { subjectGap=true; row.notes.push('主体事实尚未确认（decision:' + d.id + '）') }
      continue
    }
    if (['pending_review','platform_stale','renamed'].includes(d.reasonCode ?? '')) continue
    let gap = !d.lifecycleAction || !d.basis || !d.effectiveAt || !Number.isFinite(Date.parse(d.effectiveAt)) || Date.parse(d.effectiveAt) > executionTime
    if (d.queryId) {
      const q = db.prepare('select query_key as key,rdjb,title_code as title from platform_query where id=?').get(d.queryId) as any
      if (!q || q.title && q.title !== d.titleCode || q.rdjb && !q.rdjb.split(',').includes(({little_giant:'3',specialized_sme:'2',innovative_sme:'1'} as Record<string,string>)[d.titleCode]) || q.key !== enterprise.uscc_norm && q.key !== 'name:' + enterprise.name_norm || q.key?.startsWith('name:') && enterprise.uscc_norm) gap=true
    }
    if (d.relationId) {
      const r = db.prepare('select enterprise_id as enterpriseId,uscc_raw as uscc,verification_status as status from platform_relation where id=?').get(d.relationId) as any
      if (!r || r.status !== 'confirmed' || r.enterpriseId !== enterpriseId || r.uscc && enterprise.uscc_norm && normalizeUscc(r.uscc) !== enterprise.uscc_norm) gap=true
    }
    const corrected = db.prepare('select id from enterprise_profile_audit where enterprise_id=? and created_at>? limit 1').get(enterpriseId,d.recordedAt)
    if (corrected) gap=true
    if (gap || d.reasonCode === 'other') { if (subjectFact) subjectGap=true; row.group='pending'; row.notes.push('旧决定适用前提需重新核实；#108适用性/终止资格能力未交付（decision:' + d.id + '）'); continue }
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
      if (d.titleCode === title && d.movedTitle && d.movedTitle !== title) { row.group='pending'; row.notes.push('迁入资格依据不属于本称号') }
      if (!formal.length) {
        row.group='pending'; row.publication='尚未完成公布匹配核实'
        row.notes.push('#108尚无已确认本称号当前资格及宁波公布核对范围；迁入事实不能代替资格依据')
      }
    }
  }
  if (terminations.length) { row.group='excluded'; row.notes.push('已确认注销/主体终止；独立迁入不构成主体状态更正') }
  if (subjectGap) { row.group='pending'; row.notes.push('相关主体事实适用性未确认，不能确认为当前有效主体') }
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
  return row
}
