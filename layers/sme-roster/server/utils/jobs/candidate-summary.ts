import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { isJobId, type JobState } from '../../../../core/lib/job'
import { TASK_EXPORTS } from '../../../lib/sme-roster/task-exports'
import { type TaskSummary } from '../../../../core/lib/task-center'
import { CANDIDATE_JOB_KIND, type CandidateJobResult } from './candidate-discovery'
import { EVENT_ARCHIVE_RULE_VERSION } from '../event-archive-discovery'
import type { ProjectedTask } from './task-summary'
import { sql } from 'drizzle-orm'
import { schema } from '../../../../../db/client'
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
  return projectCandidateSummary(row.state, discovery, detail)
}

function projectCandidateSummary(state: JobState, discovery: CandidateRead | null, detail: boolean) {
  const discoveryRetry = !!discovery && ['failed','cancelled'].includes(state) && (discovery.attempt ?? 0) < 10 && (!discovery.ruleVersion || discovery.ruleVersion === EVENT_ARCHIVE_RULE_VERSION)
  const discoveryItems = (discovery?.items ?? []).filter(i => Number.isSafeInteger(i.eventId) && i.eventId > 0).map(i => ({eventId:i.eventId,enterpriseId:typeof i.enterpriseId === "number"&&Number.isSafeInteger(i.enterpriseId)&&i.enterpriseId>0?i.enterpriseId:null,status:['pending','running','done','failed'].includes(i.status)?i.status:'unknown',created:Number.isSafeInteger(i.created)?i.created:0,existing:Number.isSafeInteger(i.existing)?i.existing:0,errorCode:i.errorCode !== undefined && ['source_materialization_limit','event_unavailable','candidate_persistence_failed'].includes(i.errorCode)?i.errorCode:null}))
  const summary: TaskSummary['discovery'] = discovery ? {ruleVersion:discovery.ruleVersion === EVENT_ARCHIVE_RULE_VERSION ? discovery.ruleVersion : null,titleCode:TASK_EXPORTS.some(t=>t.titleCode===discovery.titleCode)?discovery.titleCode??null:null,throughEventId:discovery.throughEventId??null,scope:discovery.queryId?`归档查询 #${discovery.queryId} 受影响事件`:discovery.titleCode?`称号 ${TASK_EXPORTS.find(t=>t.titleCode===discovery.titleCode)?.label ?? discovery.titleCode}（每片最多200条）`:`指定 ${discovery.eventCount ?? 0} 条事件`,attempt:discovery.attempt??0,counts:discovery.counts??{succeeded:0,needsReview:0,failed:0,created:0,existing:0},nextAfterEventId:discovery.nextAfterEventId??null,continuationJobId:isJobId(discovery.continuationJobId)?discovery.continuationJobId:null,items:detail?discoveryItems:[]} : undefined
  return { discovery, discoveryRetry, discoveryItems, summary }
}

export async function summarizePostgresCandidateJobs(db: NodePgDatabase, ids: string[], detail: boolean, authorized: boolean) {
  const { rows } = await db.execute<{ id: string; state: JobState; meta: CandidateRead; hasError: boolean; restarted: boolean }>(sql`
    SELECT id,state,coalesce(result::jsonb,'{}'::jsonb) || jsonb_build_object('titleCode',params::json->>'titleCode',
      'queryId',params::json->'queryId','eventCount',json_array_length(params::json->'eventIds')) AS meta,
      error IS NOT NULL AS "hasError",coalesce(position('服务重启' in error),0)>0 AS restarted
    FROM business.job WHERE id=ANY(${sql.param(ids)}::text[]) AND kind=${CANDIDATE_JOB_KIND}`)
  const out = new Map<string, Partial<Pick<TaskSummary, 'discovery' | 'links' | 'capabilities' | 'error'>>>()
  for (const row of rows) {
    const projected = projectCandidateSummary(row.state, row.meta, detail)
    const links: TaskSummary['links'] = [{ label: '平台查询证据', to: '/platform-queries' }, { label: '比对与核查入口', to: '/comparison' }]
    if (detail) for (const item of projected.discoveryItems) if (item.enterpriseId) links.push({
      label: `核对公布事件 #${item.eventId}`, to: `/enterprises/${item.enterpriseId}?eventId=${item.eventId}`,
    })
    if (isJobId(projected.discovery?.continuationJobId)) links.push({
      label: '后续受影响事件任务', to: `/tasks?tab=sme-roster&group=platform&job=${projected.discovery.continuationJobId}`,
    })
    const retry = projected.discoveryRetry
    out.set(row.id, { discovery: projected.summary, links,
      capabilities: { cancel: false, retry: authorized && retry, retryItemIds: [],
        reason: retry ? '仅处理未完成事件，保留已完成结果。' : '请通过业务入口核对任务。' },
      error: row.hasError && row.state === 'failed' ? row.restarted
        ? '服务重启，任务中断；可从检查点重试。' : '部分事件未完成；已完成候选保留，可显式重试未完成项。' : null })
  }
  return out
}
