import { isJobId } from '../../../lib/job'
import { TASK_EXPORTS, type TaskSummary } from '../../../lib/task-center'
import { CANDIDATE_JOB_KIND, type CandidateJobResult } from './candidate-discovery'
import { EVENT_ARCHIVE_RULE_VERSION } from '../event-archive-discovery'
import type { ProjectedTask } from './task-summary'
import { sql } from 'drizzle-orm'
import { schema } from '../../../db/client'
interface CandidateParamsRead { titleCode?: string; queryId?: number; eventCount?: number }
type CandidateRead = Partial<Omit<CandidateJobResult, 'items'>> & CandidateParamsRead & {
  items?: { eventId: number; enterpriseId: number | null; status: string; created: number; existing: number; errorCode?: string }[]
}
const j = schema.job
const candidateCounts = sql`case when json_type(${j.result}, '$.counts') = 'object' then json_object(
  ${sql.join(['succeeded', 'needsReview', 'failed', 'created', 'existing'].map(key => sql`${key}, case
    when json_type(${j.result}, ${'$.counts.' + key}) = 'integer'
    then json_extract(${j.result}, ${'$.counts.' + key}) end`), sql`, `)}
) end`
export const candidateProjection = {
  discoveryMeta: sql<string>`case when ${j.kind} = 'event-archive-candidates' then json_object('ruleVersion', substr(json_extract(${j.result},'$.ruleVersion'),1,80), 'attempt', json_extract(${j.result},'$.attempt'), 'titleCode',substr(json_extract(${j.params},'$.titleCode'),1,40),'queryId',json_extract(${j.params},'$.queryId'),'eventCount',json_array_length(${j.params},'$.eventIds'),'counts',json(${candidateCounts}),'throughEventId',json_extract(${j.result},'$.throughEventId'),'nextAfterEventId',json_extract(${j.result},'$.nextAfterEventId'),'continuationJobId',substr(json_extract(${j.result},'$.continuationJobId'),1,26),'items',json((select json_group_array(json_object('eventId',json_extract(value,'$.eventId'),'enterpriseId',json_extract(value,'$.enterpriseId'),'status',substr(json_extract(value,'$.status'),1,20),'created',json_extract(value,'$.created'),'existing',json_extract(value,'$.existing'),'errorCode',substr(json_extract(value,'$.errorCode'),1,50))) from (select value from json_each(${j.result},'$.items') limit 200)))) else '{}' end`,
}

export function readCandidateSummary(row: ProjectedTask, detail: boolean) {
  const discovery = row.kind === CANDIDATE_JOB_KIND ? JSON.parse(row.discoveryMeta || '{}') as CandidateRead : null
  const discoveryRetry = !!discovery && ['failed','cancelled'].includes(row.state) && (discovery.attempt ?? 0) < 10 && (!discovery.ruleVersion || discovery.ruleVersion === EVENT_ARCHIVE_RULE_VERSION)
  const discoveryItems = (discovery?.items ?? []).filter(i => Number.isSafeInteger(i.eventId) && i.eventId > 0).map(i => ({eventId:i.eventId,enterpriseId:typeof i.enterpriseId === "number"&&Number.isSafeInteger(i.enterpriseId)&&i.enterpriseId>0?i.enterpriseId:null,status:['pending','running','done','failed'].includes(i.status)?i.status:'unknown',created:Number.isSafeInteger(i.created)?i.created:0,existing:Number.isSafeInteger(i.existing)?i.existing:0,errorCode:i.errorCode !== undefined && ['source_materialization_limit','event_unavailable','candidate_persistence_failed'].includes(i.errorCode)?i.errorCode:null}))
  const summary: TaskSummary['discovery'] = discovery ? {ruleVersion:discovery.ruleVersion === EVENT_ARCHIVE_RULE_VERSION ? discovery.ruleVersion : null,titleCode:TASK_EXPORTS.some(t=>t.titleCode===discovery.titleCode)?discovery.titleCode??null:null,throughEventId:discovery.throughEventId??null,scope:discovery.queryId?`归档查询 #${discovery.queryId} 受影响事件`:discovery.titleCode?`称号 ${TASK_EXPORTS.find(t=>t.titleCode===discovery.titleCode)?.label ?? discovery.titleCode}（每片最多200条）`:`指定 ${discovery.eventCount ?? 0} 条事件`,attempt:discovery.attempt??0,counts:discovery.counts??{succeeded:0,needsReview:0,failed:0,created:0,existing:0},nextAfterEventId:discovery.nextAfterEventId??null,continuationJobId:isJobId(discovery.continuationJobId)?discovery.continuationJobId:null,items:detail?discoveryItems:[]} : undefined
  return { discovery, discoveryRetry, discoveryItems, summary }
}
