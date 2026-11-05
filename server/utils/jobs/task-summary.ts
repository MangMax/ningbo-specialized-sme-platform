import { annualProjection, readAnnualSummary } from './annual-summary'
import { readCandidateSummary, candidateProjection } from './candidate-summary'
import { readExportSummary, exportProjection } from './export-summary'
import { readReconcileSummary, reconcileProjection } from './reconcile-summary'
import { readBatchSummary, batchProjection } from './batch-summary'
import { readOcrLinks, ocrProjection } from './ocr-summary'
import { CANDIDATE_JOB_KIND } from './candidate-discovery'
import { desc, sql, type SQL } from 'drizzle-orm'
import { schema, type useDb } from '../../../db/client'
import { isJobId } from '../../../lib/job'
import { TASK_EXPORTS, TASK_GROUPS, TASK_LABELS, type TaskSummary, type TaskTab } from '../../../lib/task-center'

type Db = ReturnType<typeof useDb>
const j = schema.job
// SQLite projects only scalar fields and bounded ID/status arrays. Raw params,
// OCR markdown and platform segment/page/row payloads never enter JS list memory.
const projection = {
  id: j.id, kind: j.kind, state: j.state, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  done: sql<number>`json_extract(${j.progress}, '$.done')`, total: sql<number>`json_extract(${j.progress}, '$.total')`,
  hasError: sql<number>`(${j.error} is not null)`, restarted: sql<number>`coalesce(instr(${j.error}, '服务重启'),0) > 0`,

  ...ocrProjection,
  ...batchProjection,
  ...reconcileProjection,
  ...exportProjection,
  ...candidateProjection,
  ...annualProjection,
}
export function readTasks(db: Db, where: SQL | undefined, limit: number, offset = 0) {
  return db.select(projection).from(j).where(where).orderBy(desc(j.createdAt), desc(j.id)).limit(limit).offset(offset).all()
}
export type ProjectedTask = ReturnType<typeof readTasks>[number]
export async function summarize(row: ProjectedTask, authorized: boolean, db: Db, detail = false): Promise<TaskSummary> {
  const group = (Object.entries(TASK_GROUPS).find(([, kinds]) => kinds.includes(row.kind))?.[0] ?? 'all') as TaskTab
  const active = row.state === 'queued' || row.state === 'running'
  const { items, retryItemIds, outcome, retry: batchRetry } = readBatchSummary(row, detail)
  const { discovery, discoveryRetry, discoveryItems, summary: discoverySummary } = readCandidateSummary(row, detail)
  const retry = discoveryRetry || batchRetry
  const { reconcile, reconcileCollection } = readReconcileSummary(row)
  const annual = readAnnualSummary(row)
  const links: TaskSummary['links'] = []
  if (annual) links.push({ label: '年度任务详情与重试资格', to: `/api/roster/annual-correspondence-tasks/${row.id}` })
  links.push(...readOcrLinks(row))
  if (group === 'platform') links.push({ label: '平台查询证据', to: '/platform-queries' }, { label: '比对与核查入口', to: '/comparison' })
  if(discovery && detail) for(const item of discoveryItems) if(item.enterpriseId) links.push({label:`核对公布事件 #${item.eventId}`,to:`/enterprises/${item.enterpriseId}?eventId=${item.eventId}`})
  if(isJobId(discovery?.continuationJobId))links.push({label:'后续受影响事件任务',to:`/tasks?tab=platform&job=${discovery.continuationJobId}`})
  const exported = await readExportSummary(row, authorized, db)

  return {
    ...(annual ? { annual } : {}),
    ...(exported ? { export: exported } : {}),
    ...(reconcile ? { reconcile, reconcileCollection } : {}),
    ...(discoverySummary ? { discovery: discoverySummary } : {}),
    id: row.id, kind: String(row.kind).slice(0, 100), label: exported?.titleCode ? `${TASK_EXPORTS.find(t => t.titleCode === exported.titleCode)!.label}导出` : TASK_LABELS[row.kind] ?? String(row.kind).slice(0, 100), group, state: row.state,
    createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
    progress: { done: Number.isFinite(row.done) ? row.done : 0, total: row.total > 0 && group !== 'all' && (group !== 'export' || exported?.phase === 'workbook' || row.state === 'done') ? row.total : null,
      unit: group === 'ocr' ? '份文件' : group === 'export' ? '家企业' : '项', stage: group === 'export' ? row.state === 'queued' ? '等待执行' : row.state === 'running' ? exported?.phase === 'workbook' ? '生成工作簿' : '固定数据快照' : '执行结束' : active ? row.state === 'queued' ? '等待执行' : TASK_LABELS[row.kind] ?? '执行中（阶段未知）' : '执行结束' },
    error: row.hasError && row.state === 'failed' ? row.restarted ? row.kind === CANDIDATE_JOB_KIND ? '服务重启，任务中断；可从检查点重试。' : '服务重启，任务中断；请从业务入口重新提交。' : row.kind === CANDIDATE_JOB_KIND ? '部分事件未完成；已完成候选保留，可显式重试未完成项。' : group === 'export' ? '导出失败；请检查数据与产物存储后显式重新生成。原始错误不展示。' : row.kind === 'platform-query-batch' ? '批次有失败或未完成范围；请查看摘要并显式重试。' : '任务失败；原始错误可能含敏感信息，摘要不展示。请核对业务入口与配置。' : null,
    ...(detail ? { items } : {}),
    outcome, capabilities: { cancel: authorized && active, retry: authorized && retry, retryItemIds: retry ? retryItemIds : [],
      reason: !authorized ? '当前请求仅可查看任务。' : active ? '可请求取消；实际状态以服务端终态为准。' : annual ? '请通过年度专属接口核对当前来源代次与重试资格；此处不重放年度任务。' : retry ? '仅补查本批次未完成项，保留已完成结果。' : group === 'export' ? '导出不重放任务；请显式重新生成，新任务保留原任务关联。' : '此任务不支持安全重试，请从原业务入口核对后重新提交。' }, links,
  }
}
