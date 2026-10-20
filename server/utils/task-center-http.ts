import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { schema, type useDb } from '../../db/client'
import { isJobId, JOB_STATES, type JobState } from '../../lib/job'
import { TASK_EXPORTS, TASK_GROUPS, TASK_LABELS, TASK_TABS, type TaskList, type TaskSummary, type TaskTab } from '../../lib/task-center'
import { readApiToken, resolveApiAuth } from './api-auth'
import { currentArtifact, currentExportDbPath } from './current-export-artifact'
import { requestJobCancel, jobSpecs } from './job-runner'
import { retryPlatformBatch } from './platform-batch-query'
import { MAX_BATCH_ATTEMPTS } from '../../lib/platform/batch-query'

type Db = ReturnType<typeof useDb>
type Request = { method: string; path: string; query?: Record<string, unknown>; headers?: Record<string, string | undefined>; body?: unknown }
const error = (status: number, message: string) => ({ status, headers: { 'cache-control': 'no-store' }, body: { message } })
const positive = (raw: unknown, fallback: number, max: number) => typeof raw !== 'object' && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Math.min(Number(raw), max) : fallback
const j = schema.job
// SQLite projects only scalar fields and bounded ID/status arrays. Raw params,
// OCR markdown and platform segment/page/row payloads never enter JS list memory.
const projection = {
  id: j.id, kind: j.kind, state: j.state, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  done: sql<number>`json_extract(${j.progress}, '$.done')`, total: sql<number>`json_extract(${j.progress}, '$.total')`,
  hasError: sql<number>`(${j.error} is not null)`, restarted: sql<number>`coalesce(instr(${j.error}, '服务重启'),0) > 0`,
  itemCount: sql<number>`json_array_length(${j.params}, '$.items')`,
  attempt: sql<number>`json_extract(${j.result}, '$.attempt')`,
  items: sql<string>`case when ${j.kind} = 'platform-query-batch' then (select json_group_array(json_object('id',json_extract(item.value,'$.itemId'),'status',json_extract(item.value,'$.status'),'completeness',json_extract(item.value,'$.completeness'),'unfinished',coalesce(json_array_length(json_extract(item.value,'$.unfinished')),0),'positions',json((select json_group_array(json_object('source',json_extract(pos.value,'$.source'),'rdjb',json_extract(pos.value,'$.rdjb'),'page',json_extract(pos.value,'$.page'))) from (select value from json_each(item.value,'$.unfinished') limit 50) pos)))) from (select value from json_each(${j.result}, '$.items') limit 50) item) else '[]' end`,
  exportTitle: sql<string>`substr(json_extract(${j.params}, '$.titleCode'),1,40)`,
  exportMeta: sql<string>`case when ${j.kind} = 'current-roster-export' then json_object('regenerateOf',substr(json_extract(${j.params},'$.regenerateOf'),1,26),'phase',substr(json_extract(${j.result},'$.phase'),1,20),'generatedAt',substr(json_extract(${j.result},'$.generatedAt'),1,30),'snapshotStartedAt',substr(json_extract(${j.result},'$.snapshotStartedAt'),1,30),'ruleVersion',substr(json_extract(${j.result},'$.ruleVersion'),1,60),'dataVersion',substr(json_extract(${j.result},'$.dataVersion'),1,72),'counts',json_object('eligible',json_extract(${j.result},'$.counts.eligible'),'pending',json_extract(${j.result},'$.counts.pending'),'excluded',json_extract(${j.result},'$.counts.excluded')),'artifact',json_object('id',substr(json_extract(${j.result},'$.artifact.id'),1,26),'size',json_extract(${j.result},'$.artifact.size'),'sha256',substr(json_extract(${j.result},'$.artifact.sha256'),1,64),'generatedAt',substr(json_extract(${j.result},'$.artifact.generatedAt'),1,30),'expiresAt',substr(json_extract(${j.result},'$.artifact.expiresAt'),1,30))) else '{}' end`,
  files: sql<string>`case when ${j.kind} = 'ocr' then (select json_group_array(json_object('id',json_extract(value,'$.fileId'),'path',(select rel_path from stored_file where id = json_extract(value,'$.fileId')))) from (select value from json_each(${j.result}, '$.files') where json_extract(value,'$.ok') = 1 limit 50)) else '[]' end`,
  counts: sql<string>`case when ${j.kind} = 'reconcile' then json_object('failed',json_extract(${j.result},'$.counts.queryFailed'),'notQueried',json_extract(${j.result},'$.counts.notQueried'),'complete',json_extract(${j.result},'$.counts.total'),'partial',json_extract(${j.result},'$.counts.needsReview')) else '{}' end`,
}
function readTasks(db: Db, where: SQL | undefined, limit: number, offset = 0) {
  return db.select(projection).from(j).where(where).orderBy(desc(j.createdAt), desc(j.id)).limit(limit).offset(offset).all()
}
type ProjectedTask = ReturnType<typeof readTasks>[number]
async function summarize(row: ProjectedTask, authorized: boolean, db: Db, detail = false): Promise<TaskSummary> {
  const group = (Object.entries(TASK_GROUPS).find(([, kinds]) => kinds.includes(row.kind))?.[0] ?? 'all') as TaskTab
  const active = row.state === 'queued' || row.state === 'running'
  const items = JSON.parse(row.items || '[]') as { id: unknown; status: string; completeness: string; unfinished: number; positions: { source: string; rdjb: string | null; page: number }[] }[]
  const retryItemIds = items.filter(i => i.completeness !== 'complete' && isJobId(i.id)).map(i => i.id as string)
  const retry = row.kind === 'platform-query-batch' && !active && row.attempt < MAX_BATCH_ATTEMPTS && retryItemIds.length > 0
  const counts = JSON.parse(row.counts || '{}')
  const outcome = row.kind === 'platform-query-batch' ? {
    complete: items.filter(i => i.completeness === 'complete').length,
    partial: items.filter(i => i.completeness === 'partial').length,
    failed: items.filter(i => ['failed', 'auth_failed'].includes(i.status)).length,
    notQueried: items.length ? items.filter(i => i.status === 'not_queried').length : row.itemCount ?? 0,
    unfinished: items.reduce((n, i) => n + i.unfinished, 0), attempt: row.attempt || 0,
  } : row.kind === 'reconcile' ? { complete: counts.complete ?? 0, partial: counts.partial ?? 0, failed: counts.failed ?? 0, notQueried: counts.notQueried ?? 0, unfinished: 0, attempt: 0 } : null
  const links: TaskSummary['links'] = []
  if (group === 'ocr') {
    for (const file of JSON.parse(row.files || '[]')) if (Number.isSafeInteger(file.id) && typeof file.path === 'string' && !file.path.startsWith('/') && !file.path.includes('..') && !file.path.includes('\\')) links.push({ label: `识别结果 #${file.id}`, to: `/ocr?file=${encodeURIComponent(file.path)}` })
    links.push({ label: '识别校对入口', to: '/ocr' }, { label: '文件管理 / 转图', to: '/files' })
  }
  if (group === 'platform') links.push({ label: '平台查询证据', to: '/platform-queries' }, { label: '比对与核查入口', to: '/comparison' })
  let exported: TaskSummary['export']
  if (group === 'export') {
    const meta = JSON.parse(row.exportMeta || '{}')
    const title = TASK_EXPORTS.find(t => t.titleCode === row.exportTitle)
    const date = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null
    const raw = meta.artifact
    let artifact: NonNullable<TaskSummary['export']>['artifact'] = null
    if (title && row.state === 'done' && raw?.id === row.id && Number.isSafeInteger(raw.size) && raw.size > 0 && /^[a-f0-9]{64}$/.test(raw.sha256) && date(raw.generatedAt) && date(raw.expiresAt)) {
      // Reuse the artifact authority on a bounded, whitelisted projection. Never
      // load the full job result or forward its path/URL/filename fields.
      artifact = await currentArtifact({ id: row.id, kind: row.kind, state: row.state, params: {}, progress: { done: 0, total: 0 }, error: null, createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
        result: { artifact: { ...raw, filename: `current-${title.titleCode}.xlsx`, downloadUrl: `/api/job-artifacts/${row.id}` } } }, currentExportDbPath(db))
    }
    exported = {
      titleCode: title?.titleCode ?? null, regenerateOf: isJobId(meta.regenerateOf) ? meta.regenerateOf : null,
      phase: ['starting','workbook','complete'].includes(meta.phase) ? meta.phase : 'unknown',
      generatedAt: date(meta.generatedAt), snapshotStartedAt: date(meta.snapshotStartedAt),
      ruleVersion: ['current-roster-116-v1', 'current-roster-116-v2', 'current-roster-116-v3', 'current-roster-116-v4', 'current-roster-116-v5', 'current-roster-116-v6'].includes(meta.ruleVersion) ? meta.ruleVersion : null,
      dataVersion: /^sha256:[a-f0-9]{64}$/.test(meta.dataVersion) ? meta.dataVersion : null,
      counts: meta.counts && Object.values(meta.counts).every(n => Number.isSafeInteger(n) && Number(n) >= 0) ? meta.counts : null,
      artifact, canDownload: authorized && artifact?.availability === 'available', canRegenerate: authorized && !active && !!title,
    }
  }
  return {
    ...(exported ? { export: exported } : {}),
    id: row.id, kind: String(row.kind).slice(0, 100), label: exported?.titleCode ? `${TASK_EXPORTS.find(t => t.titleCode === exported.titleCode)!.label}导出` : TASK_LABELS[row.kind] ?? String(row.kind).slice(0, 100), group, state: row.state,
    createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
    progress: { done: Number.isFinite(row.done) ? row.done : 0, total: row.total > 0 && group !== 'all' && (group !== 'export' || exported?.phase === 'workbook' || row.state === 'done') ? row.total : null,
      unit: group === 'ocr' ? '份文件' : group === 'export' ? '家企业' : '项', stage: group === 'export' ? row.state === 'queued' ? '等待执行' : row.state === 'running' ? exported?.phase === 'workbook' ? '生成工作簿' : '固定数据快照' : '执行结束' : active ? row.state === 'queued' ? '等待执行' : TASK_LABELS[row.kind] ?? '执行中（阶段未知）' : '执行结束' },
    error: row.hasError && row.state === 'failed' ? row.restarted ? '服务重启，任务中断；请从业务入口重新提交。' : group === 'export' ? '导出失败；请检查数据与产物存储后显式重新生成。原始错误不展示。' : row.kind === 'platform-query-batch' ? '批次有失败或未完成范围；请查看摘要并显式重试。' : '任务失败；原始错误可能含敏感信息，摘要不展示。请核对业务入口与配置。' : null,
    ...(detail ? { items: items.map(i => ({ id: isJobId(i.id) ? i.id : '', status: ['success', 'no_record', 'auth_failed', 'failed', 'partial', 'not_queried'].includes(i.status) ? i.status : 'unknown', completeness: ['complete', 'partial', 'not_queried'].includes(i.completeness) ? i.completeness : 'unknown', positions: (i.positions ?? []).filter(p => ['queryList','businessList','queryBusList'].includes(p.source) && (p.rdjb === null || ['1','2','3'].includes(p.rdjb)) && Number.isSafeInteger(p.page) && p.page > 0) })) } : {}),
    outcome, capabilities: { cancel: authorized && active, retry: authorized && retry, retryItemIds: retry ? retryItemIds : [],
      reason: !authorized ? '当前请求仅可查看任务。' : active ? '可请求取消；实际状态以服务端终态为准。' : retry ? '仅补查本批次未完成项，保留已完成结果。' : group === 'export' ? '导出不重放任务；请显式重新生成，新任务保留原任务关联。' : '此任务不支持安全重试，请从原业务入口核对后重新提交。' }, links,
  }
}

export async function handleTaskCenterRequest(action: 'list' | 'detail' | 'cancel' | 'retry', req: Request, ctx: { db: Db; browserAuthorized?: boolean; apiToken?: string; filesDir: string }) {
  const headers = { 'cache-control': 'no-store' }
  const authorized = ctx.browserAuthorized === true || resolveApiAuth({ given: readApiToken(req.headers), configured: ctx.apiToken }).writeAuthorized
  const method = action === 'list' || action === 'detail' ? 'GET' : 'POST'
  if (req.method !== method) return error(405, 'Method not allowed')
  const q = req.query ?? {}
  if (action === 'list') {
    const tab = TASK_TABS.includes(q.tab as TaskTab) ? q.tab as TaskTab : 'all'
    const state = JOB_STATES.includes(q.state as JobState) ? q.state as JobState : undefined
    const page = positive(q.page, 1, 1000000), pageSize = positive(q.pageSize, 25, 200)
    const title = TASK_EXPORTS.find(t => t.titleCode === q.titleCode)
    const stateWhere = and(state ? eq(j.state, state) : undefined, title ? and(eq(j.kind, 'current-roster-export'), sql`json_extract(${j.params}, '$.titleCode') = ${title.titleCode}`) : undefined)
    const where = and(stateWhere, tab === 'all' ? undefined : inArray(j.kind, TASK_GROUPS[tab]))
    const total = ctx.db.select({ n: sql<number>`count(*)` }).from(j).where(where).get()!.n
    const rows = await Promise.all(readTasks(ctx.db, where, pageSize, (page - 1) * pageSize).map(row => summarize(row, authorized, ctx.db)))
    const counts: TaskList['counts'] = { all: 0, ocr: 0, platform: 0, export: 0 }
    for (const row of ctx.db.select({ kind: j.kind, n: sql<number>`count(*)` }).from(j).where(stateWhere).groupBy(j.kind).all()) {
      counts.all += row.n
      const group = Object.entries(TASK_GROUPS).find(([, kinds]) => kinds.includes(row.kind))?.[0] as keyof typeof TASK_GROUPS | undefined
      if (group) counts[group] += row.n
    }
    return { status: 200, headers, body: { rows, total, page, pageSize, counts, exportReady: jobSpecs().some(spec => spec.kind === 'current-roster-export' && spec.status === 'ready'), authorized } satisfies TaskList }
  }
  const id = req.path.split('/')[3]
  if (!isJobId(id)) return error(400, 'Invalid task ID')
  const row = readTasks(ctx.db, eq(j.id, id), 1)[0]
  if (!row) return error(404, '任务不存在')
  if (action === 'detail') return { status: 200, headers, body: await summarize(row, authorized, ctx.db, true) }
  if (!authorized) return error(401, '管理操作需要 API 授权')
  if (action === 'cancel') {
    const outcome = requestJobCancel(ctx.db, id)
    if (!outcome.ok) return error(404, '任务不存在')
    const cancelRequested = 'cancelRequested' in outcome && outcome.cancelRequested
    return { status: cancelRequested ? 202 : 200, headers, body: { task: await summarize(readTasks(ctx.db, eq(j.id, id), 1)[0]!, authorized, ctx.db), cancelRequested } }
  }
  const summary = await summarize(row, authorized, ctx.db)
  if (!summary.capabilities.retry) return error(409, '此任务当前不支持安全重试')
  try {
    const outcome = retryPlatformBatch(ctx.db, { batchId: id, itemIds: summary.capabilities.retryItemIds }, ctx.filesDir)
    return { status: 202, headers, body: outcome }
  } catch (cause) {
    // `retryPlatformBatch` 只在 `requeueFinishedJob` 之前就抛错时把异常漏出来 —— 也就是
    // 依赖捕获(`prepare`)失败的那一刻。此时任务**根本没被重开**(`reopenJob` 在 `prepare`
    // 之后),旧终态与旧 `result` 都还在,如实告诉操作者"这次没受理、可以再来"。
    // 注意:平台的 `prepare` 只把凭据快照的空值降级为 not_queried、把敏感条件判成 400,
    // 不会把凭据存储异常传到这里 —— 别把它写成"存储不可用必然 503"。
    const status = (cause as { statusCode?: number }).statusCode
    return status && status < 500 ? error(status, '重试未受理，原结果保留，请刷新任务状态后再试。') : error(503, '重试未受理，原结果保留，请稍后再试。')
  }
}
