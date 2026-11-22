import { platformTaskLinks, rosterTaskError, taskRetryReason } from './task-presentation'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { isJobId, type JobState } from '../../../../core/lib/job'
import { TASK_EXPORTS } from '../../../lib/sme-roster/task-exports'
import type { TaskSummary } from '../../../lib/sme-roster/task-summary'
import { CANDIDATE_JOB_KIND, type CandidateJobResult } from './candidate-discovery-contract'
import { EVENT_ARCHIVE_RULE_VERSION } from '../event-archive-discovery-model'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { job as pgJob } from '../../../../../db/postgresql/job-tables'

interface CandidateParamsRead { titleCode?: string; queryId?: number; eventCount?: number }

export type CandidateRead = Partial<Omit<CandidateJobResult, 'items'>> & CandidateParamsRead & {
  items?: { eventId: number; enterpriseId: number | null; status: string; created: number; existing: number; errorCode?: string }[]
}

export function projectCandidateSummary(state: JobState, discovery: CandidateRead | null, detail: boolean) {
  const discoveryRetry = !!discovery && ['failed','cancelled'].includes(state) && (discovery.attempt ?? 0) < 10 && (!discovery.ruleVersion || discovery.ruleVersion === EVENT_ARCHIVE_RULE_VERSION)
  const discoveryItems = (discovery?.items ?? []).filter(i => Number.isSafeInteger(i.eventId) && i.eventId > 0).map(i => ({eventId:i.eventId,enterpriseId:typeof i.enterpriseId === "number"&&Number.isSafeInteger(i.enterpriseId)&&i.enterpriseId>0?i.enterpriseId:null,status:['pending','running','done','failed'].includes(i.status)?i.status:'unknown',created:Number.isSafeInteger(i.created)?i.created:0,existing:Number.isSafeInteger(i.existing)?i.existing:0,errorCode:i.errorCode !== undefined && ['source_materialization_limit','event_unavailable','candidate_persistence_failed'].includes(i.errorCode)?i.errorCode:null}))
  const summary: TaskSummary['discovery'] = discovery ? {ruleVersion:discovery.ruleVersion === EVENT_ARCHIVE_RULE_VERSION ? discovery.ruleVersion : null,titleCode:TASK_EXPORTS.some(t=>t.titleCode===discovery.titleCode)?discovery.titleCode??null:null,throughEventId:discovery.throughEventId??null,scope:discovery.queryId?`归档查询 #${discovery.queryId} 受影响事件`:discovery.titleCode?`称号 ${TASK_EXPORTS.find(t=>t.titleCode===discovery.titleCode)?.label ?? discovery.titleCode}（每片最多200条）`:`指定 ${discovery.eventCount ?? 0} 条事件`,attempt:discovery.attempt??0,counts:discovery.counts??{succeeded:0,needsReview:0,failed:0,created:0,existing:0},nextAfterEventId:discovery.nextAfterEventId??null,continuationJobId:isJobId(discovery.continuationJobId)?discovery.continuationJobId:null,items:detail?discoveryItems:[]} : undefined
  return { discovery, discoveryRetry, discoveryItems, summary }
}

export function candidateTaskLinks(projected: ReturnType<typeof projectCandidateSummary>, detail: boolean) {
  const links = platformTaskLinks()
  if (detail) for (const item of projected.discoveryItems) if (item.enterpriseId) links.push({
    label: `核对公布事件 #${item.eventId}`, to: `/enterprises/${item.enterpriseId}?eventId=${item.eventId}`,
  })
  if (isJobId(projected.discovery?.continuationJobId)) links.push({
    label: '后续受影响事件任务', to: `/tasks?tab=sme-roster&group=platform&job=${projected.discovery.continuationJobId}`,
  })
  return links
}

export async function summarizePostgresCandidateJobs(db: NodePgDatabase, ids: string[], detail: boolean) {
  const params = sql`business.job_params_for_query(${pgJob.params})`
  const result = sql`business.job_params_for_query(${pgJob.result})`
  const counts = db.select({ value: sql`json_object_agg(key,case when (${result}->'counts'->key)::text ~ '^-?[0-9]+$'
    then ${result}->'counts'->key end)` }).from(sql`unnest(array['succeeded','needsReview','failed','created','existing']) keys(key)`)
  const items = db.select({ value: sql`value`.as('value') })
    .from(sql`json_array_elements(${result}->'items')`).limit(200).as('items')
  const itemSummary = db.select({ rows: sql`json_agg(json_build_object('eventId',${items.value}->'eventId',
    'enterpriseId',${items.value}->'enterpriseId','status',left(${items.value}->>'status',20),
    'created',${items.value}->'created','existing',${items.value}->'existing','errorCode',left(${items.value}->>'errorCode',50)))` }).from(items)
  const rows = await db.select({ id: pgJob.id, kind: pgJob.kind, state: pgJob.state,
    meta: sql<CandidateRead>`json_build_object('titleCode',left(${params}->>'titleCode',40),'queryId',${params}->'queryId',
      'eventCount',json_array_length(${params}->'eventIds'),'ruleVersion',left(${result}->>'ruleVersion',80),'attempt',${result}->'attempt',
      'throughEventId',${result}->'throughEventId','nextAfterEventId',${result}->'nextAfterEventId',
      'continuationJobId',left(${result}->>'continuationJobId',26),
      'counts',case when json_typeof(${result}->'counts')='object' then (${counts}) end,
      'items',case when ${detail} then (${itemSummary}) end)`,
    hasError: isNotNull(pgJob.error).mapWith(Boolean), restarted: sql<boolean>`coalesce(position('服务重启' in ${pgJob.error}),0)>0`,
  }).from(pgJob).where(and(inArray(pgJob.id, ids), eq(pgJob.kind, CANDIDATE_JOB_KIND)))
  return new Map(rows.map(row => {
    const projected = projectCandidateSummary(row.state, row.meta, detail)
    const retry = projected.discoveryRetry
    return [row.id, {
      discovery: projected.summary,
      links: candidateTaskLinks(projected, detail),
      ...(retry ? { capabilities: { cancel: false, retry, retryItemIds: [], reason: taskRetryReason } } : {}),
      error: rosterTaskError(row),
    }]
  }))
}
