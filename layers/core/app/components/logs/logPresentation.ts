import { UNLABELED_LOG_MODULE, type LogEvent, type LogSummary } from '#core/lib/logging/contract'
import { getAppModules } from '~~/lib/app-modules'
import { errorCodeMissingIsInformative, fieldOmission } from '#core/lib/logging/detail-profile'
import { isDrizzleQueryAttempt } from '#core/lib/logging/drizzle-query'
import type { BadgeVariants } from '#core/app/components/ui/badge'

const moduleLabels = new Map(getAppModules().map(({ id, name }) => [id, id === 'core' ? '平台' : name]))
export const logModuleOptions = [...moduleLabels.keys(), UNLABELED_LOG_MODULE]
export const logModuleLabel = (module?: string | null) =>
  (module ? moduleLabels.get(module) : undefined) ?? '未标注'

export type LogBadgeVariant = NonNullable<BadgeVariants['variant']>

/** 来源原码 → 中文 label。原码仍单独展示，便于按原码筛选。 */
export const SOURCE_LABELS: Record<string, string> = {
  http: 'HTTP 接口',
  mcp: 'MCP 调用',
  task: '后台任务',
  worker: '后台工作进程',
  platform: '平台对接',
  file: '文件',
  ocr: 'OCR 识别',
  import: '数据导入',
  export: '数据导出',
  client: '客户端上报',
  system: '系统'
}
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

/**
 * 字段被当时策略关闭造成省略时的固定说明。只描述**配置事实**：不声称值从未进入
 * 进程（原生钩子可能已经在内存里看到过），也不声称框架没匹配或源头没提供。
 */
export const FIELD_DISABLED_LABEL = '当时未启用采集'
/** 关闭只影响之后写入或输出的记录，不追溯改写历史。 */
export const FIELD_DISABLED_NOTE =
  '该字段在当时写入这条记录时未启用采集，因此没有保存；关闭只影响之后的批次，不追溯历史，也不代表业务失败。'

/**
 * 来源契约本身没有 runtime 元数据；配置页只把已知的浏览器自报来源单列，
 * 其余来源归服务端。这里只影响展示分组，不改变任何来源策略。
 */
export const CLIENT_LOG_SOURCES: ReadonlySet<string> = new Set(['client'])
export function isClientLogSource(source: string): boolean {
  return CLIENT_LOG_SOURCES.has(source)
}

/**
 * 结果原码 → 中文。unknown/no_record/denied/partial 各自成词，不并入成功或失败；
 * 未知原码原样显示，不编造含义。
 */
export const OUTCOME_LABELS: Record<string, string> = {
  started: '已开始',
  success: '成功',
  failure: '失败',
  denied: '已拒绝',
  timeout: '超时',
  cancelled: '已取消',
  unknown: '结果未知',
  no_record: '无记录',
  partial: '部分完成',
  skipped: '已跳过'
}
export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome
}

const OUTCOME_VARIANTS: Record<string, LogBadgeVariant> = {
  started: 'secondary',
  success: 'secondary',
  failure: 'destructive',
  denied: 'outline',
  timeout: 'outline',
  cancelled: 'quiet',
  skipped: 'quiet',
  unknown: 'quiet',
  no_record: 'quiet',
  partial: 'secondary'
}
export function outcomeVariant(outcome: string): LogBadgeVariant {
  return OUTCOME_VARIANTS[outcome] ?? 'quiet'
}
/** denied/timeout 保留独立措辞，warning 描边；不据此推断请求是否已执行。 */
export function outcomeClass(outcome: string): string {
  return outcome === 'denied' || outcome === 'timeout' ? 'border-warning/50 text-warning' : ''
}

export function levelVariant(level: string): LogBadgeVariant {
  return level === 'error' ? 'destructive' : level === 'warn' ? 'outline' : 'secondary'
}
export function levelClass(level: string): string {
  return level === 'warn' ? 'border-warning/50 text-warning' : ''
}

/** 只收录已核对的确切原码；未知操作返回 null，只显示原码。 */
export const OPERATION_LABELS: Record<string, string> = {
  'http.request': 'HTTP 请求',
  'mcp.request': 'MCP 请求',
  'task.started': '任务开始',
  'task.progress': '任务进度',
  'task.finished': '任务结束',
  'task.queued': '任务入队',
  'task.requeued': '任务重新入队',
  'task.recovered': '任务恢复',
  'task.cancel_requested': '请求取消任务',
  'logging.drain': '日志落盘',
  'logging.clear': '日志清理',
  'logging.policy': '修改日志策略',
  'file.upload': '文件上传',
  'file.register': '文件登记',
  'file.parse.revise': '修正文件解析',
  'file.maintenance.update': '更新文件维护',
  'file.render': '文件渲染',
  'file.render.batch': '批量文件渲染',
  'file.render.page': '文件页渲染',
  'file.render.cleanup': '清理文件渲染',
  'ocr.recognize': 'OCR 识别',
  'ocr.file': 'OCR 整文件',
  'ocr.page': 'OCR 单页',
  'ocr.page.cache': 'OCR 页缓存',
  'ocr.page.delete': '删除 OCR 页',
  'ocr.page.revise': '修正 OCR 页',
  'import.admission': '导入准入',
  'import.execution': '导入执行',
  'export.current.process': '处理当前导出',
  'export.current.publish': '发布当前导出',
  'export.current.workbook': '生成导出工作簿',
  'export.current.summary': '导出汇总',
  'export.current.cleanup': '清理当前导出',
  'export.artifact.download': '下载导出产物',
  'export.artifact.expire': '导出产物过期',
  'export.artifact.cleanup': '清理导出产物',
  'export.legacy.enterprises.summary': '导出企业汇总',
  'platform.batch.collect': '平台批量采集',
  'platform.batch.retry': '平台批量重试',
  // Drizzle 钩子在执行前只记录查询尝试；标签保持中性，不写成查询成功或已完成。
  'db.query.select': '数据库查询 · SELECT',
  'db.query.insert': '数据库查询 · INSERT',
  'db.query.update': '数据库查询 · UPDATE',
  'db.query.delete': '数据库查询 · DELETE',
  'db.query.other': '数据库查询 · 其他',
  // 客户端库的 21 个固定 operation；结果仍由服务端映射的 outcome 表达。
  'client.tus.upload_started': 'tus 上传开始',
  'client.tus.upload_ready': 'tus 上传地址可用',
  'client.tus.upload_success': 'tus 上传完成',
  'client.tus.upload_failure': 'tus 上传失败',
  'client.embedpdf.log_debug': 'EmbedPDF 调试日志',
  'client.embedpdf.log_info': 'EmbedPDF 信息日志',
  'client.embedpdf.log_warn': 'EmbedPDF 警告日志',
  'client.embedpdf.log_error': 'EmbedPDF 错误日志',
  'client.embedpdf.startup_failure': 'EmbedPDF 启动失败',
  'client.embedpdf.document_ready': 'EmbedPDF 文档就绪',
  'client.embedpdf.document_failure': 'EmbedPDF 文档加载失败',
  'client.colada.query_success': 'Colada 查询成功',
  'client.colada.query_failure': 'Colada 查询失败',
  'client.colada.mutation_success': 'Colada 变更成功',
  'client.colada.mutation_failure': 'Colada 变更失败',
  'client.router.navigation_success': '路由跳转成功',
  'client.router.navigation_aborted': '路由跳转被中止',
  'client.router.navigation_cancelled': '路由跳转被取消',
  'client.router.navigation_duplicated': '路由跳转重复',
  'client.router.navigation_failure': '路由跳转失败',
  'client.router.navigation_error': '路由跳转错误'
}
export function operationLabel(operation: string): string | null {
  return OPERATION_LABELS[operation] ?? null
}

export type LogTargetKind =
  | 'http'
  | 'file'
  | 'ocr'
  | 'import'
  | 'export'
  | 'task'
  | 'worker'
  | 'platform'
  | 'client'
  | 'system'
  | 'none'

export interface LogTarget {
  kind: LogTargetKind
  /** 人类可读的目标文本；`missing` 为真时是「未记录」类占位。 */
  text: string
  /** 没有可靠记录到对象。 */
  missing: boolean
  /** 值来自客户端声称，不可信。 */
  untrusted: boolean
  /** 已被目标消费的标识，用于关联列去重。 */
  usedIds: string[]
}

export interface LogReference {
  kind: string
  value: string
}

/** 详情页与列表都只读这些冻结事实；tus 输出形状不影响判断，故不要求完整事件。 */
type QueryAttemptShape = Pick<
  LogEvent,
  | 'source'
  | 'level'
  | 'outcome'
  | 'origin'
  | 'operation'
  | 'resourceType'
  | 'resourceId'
  | 'errorCode'
  | 'durationMs'
  | 'statusCode'
  | 'counts'
>
/**
 * 只有确认是 Drizzle 执行前钩子、且 counts.total 为正安全整数的记录才是查询汇总。
 * 没有 counts 的历史查询、被扩宽的同名字段都不冒充汇总。
 */
export function queryAttemptTotal(event: QueryAttemptShape): number | undefined {
  if (!event.counts || Object.keys(event.counts).some(key => key !== 'total') || !isDrizzleQueryAttempt(event)) return undefined
  const total = event.counts.total
  return Number.isSafeInteger(total) && (total ?? 0) > 0 ? total : undefined
}

/**
 * 计数只显示实际存在的键，不把缺失当 0，也不从计数推断 outcome。
 * `done` 在不同来源是“已处理/已写入/重试尝试”等，不能写成“已完成”。
 * 查询汇总的 total 严格表示排队期间的尝试次数，不写成成功、影响行数或同一语句次数。
 */
export function formatCounts(counts?: LogEvent['counts'], operation?: string, queryAttempt = false): string {
  if (!counts) return ''
  const parts: string[] = []
  const attempts =
    queryAttempt && Number.isSafeInteger(counts.total) && (counts.total ?? 0) > 0 ? counts.total : undefined
  const retry = operation !== undefined && (operation.endsWith('.retry') || operation === 'platform.batch.retry')
  if (attempts !== undefined) parts.push(`查询尝试 × ${attempts}`)
  else if (retry && counts.done !== undefined) parts.push(`第 ${counts.done} 次重试`)
  else if (counts.done !== undefined && counts.total !== undefined) parts.push(`已处理 ${counts.done}/${counts.total}`)
  else if (counts.total !== undefined) parts.push(`共 ${counts.total}`)
  else if (counts.done !== undefined) parts.push(`已处理 ${counts.done}`)
  if (counts.failed !== undefined) parts.push(`失败 ${counts.failed}`)
  if (counts.dropped !== undefined) parts.push(`丢弃 ${counts.dropped}`)
  return parts.join(' · ')
}

export function resourceTypeLabel(resourceType?: string): string {
  if (resourceType === 'database_connection') return '数据库连接'
  if (resourceType === 'export_artifact') return '导出产物'
  if (resourceType === 'export_job') return '导出任务'
  if (resourceType === 'enterprise') return '企业'
  return resourceType || '资源'
}

/** Drizzle 只上报七种固定连接用途；括号内保留原码，未知码原样显示。 */
export const CONNECTION_PURPOSE_LABELS: Record<string, string> = {
  primary: '主业务库',
  enterprise_read: '企业读取',
  import_execution: '导入执行',
  current_qualification: '当前称号',
  record_comparison: '记录比对',
  evidence_review: '依据复核',
  platform_summary: '平台汇总缓存'
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const hasText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
/** batchId/resourceId 在契约里是 string | number，两种都要按事实显示。 */
const idText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
const hasId = (value: unknown): value is string | number => idText(value).length > 0
/** 只给固定码加中文用途；其他资源标识保持原值，不猜含义。 */
export function resourceIdLabel(
  resourceType: string | undefined,
  resourceId: string | number | undefined
): string {
  const id = idText(resourceId)
  if (resourceType === 'database_connection') {
    const purpose = CONNECTION_PURPOSE_LABELS[id]
    if (purpose) return `${purpose}（${id}）`
  }
  return id
}

/**
 * 失败码只展示安全原码；不翻译成失败原因，也不从 outcome 反推具体码。
 * 只有已知该 operation 的失败分支应带码，且结果为 failure/denied/timeout
 * 时才提示“未记录”；partial/no_record/cancelled/unknown 可以合法地没有码。
 */
export function errorCodeView(row: LogSummary): { text: string; present: boolean; applicable: boolean } {
  if (hasText(row.errorCode)) return { text: row.errorCode, present: true, applicable: true }
  const applicable = errorCodeMissingIsInformative(row)
  return { text: applicable ? '未记录' : '不适用', present: false, applicable }
}

/**
 * 目标列也读每条事件自己的 capture 事实：被当时策略关闭的字段写成“当时未启用采集”，
 * 不能读成“框架没匹配/源头没提供”，也不拿当前策略倒推历史。
 */
function httpTarget(row: LogSummary): LogTarget {
  const method = text(row.httpMethod)
  const route = text(row.httpRoute)
  const methodOff = !method && fieldOmission(row, 'httpMethod') === 'disabled'
  const routeOff = !route && fieldOmission(row, 'httpRoute') === 'disabled'
  if (method && route) return { kind: 'http', text: `${method} ${route}`, missing: false, untrusted: false, usedIds: [] }
  if (method) return { kind: 'http', text: `${method} · ${routeOff ? '路由当时未启用采集' : '路由未记录'}`, missing: true, untrusted: false, usedIds: [] }
  if (route) return { kind: 'http', text: `${route} · ${methodOff ? '请求方法当时未启用采集' : '方法未记录'}`, missing: true, untrusted: false, usedIds: [] }
  if (methodOff && routeOff) return { kind: 'http', text: '当时未启用采集', missing: true, untrusted: false, usedIds: [] }
  return { kind: 'http', text: '接口未记录', missing: true, untrusted: false, usedIds: [] }
}

function businessTarget(row: LogSummary, kind: LogTargetKind): LogTarget {
  const parts: string[] = []
  const usedIds: string[] = []
  if (kind === 'file' && row.tus?.uploadId) {
    parts.push(`上传 ${row.tus.uploadId}`)
    usedIds.push(row.tus.uploadId)
  } else if (kind === 'ocr' || kind === 'file') {
    if (row.fileId !== undefined) {
      parts.push(`文件 ${row.fileId}`)
      usedIds.push(String(row.fileId))
    }
    if (row.page !== undefined) parts.push(`第 ${row.page} 页`)
  }
  if (kind === 'import' && hasId(row.batchId)) {
    parts.push(`批次 ${idText(row.batchId)}`)
    usedIds.push(idText(row.batchId))
  }
  if (kind === 'export') {
    if (hasId(row.resourceId) && hasText(row.resourceType)) {
      parts.push(`${resourceTypeLabel(row.resourceType)} ${resourceIdLabel(row.resourceType, row.resourceId)}`)
      usedIds.push(idText(row.resourceId))
    }
    if (hasText(row.taskId)) {
      parts.push(`任务 ${row.taskId}`)
      usedIds.push(row.taskId)
    }
  }
  if (kind === 'task' || kind === 'worker') {
    if (hasText(row.taskId)) {
      parts.push(`任务 ${row.taskId}`)
      usedIds.push(row.taskId)
    }
    // worker 的进程生命周期事件没有 taskId；若事件本身记录了资源，只显示该事实，不推断。
    if (kind === 'worker' && hasId(row.resourceId)) {
      parts.push(`${resourceTypeLabel(row.resourceType)} ${resourceIdLabel(row.resourceType, row.resourceId)}`)
      usedIds.push(idText(row.resourceId))
    }
  }
  if (kind === 'platform') {
    if (hasId(row.batchId)) {
      parts.push(`批次 ${idText(row.batchId)}`)
      usedIds.push(idText(row.batchId))
    }
    if (row.page !== undefined) parts.push(`第 ${row.page} 页`)
    if (hasId(row.resourceId) && !usedIds.includes(idText(row.resourceId))) {
      parts.push(`${resourceTypeLabel(row.resourceType)} ${resourceIdLabel(row.resourceType, row.resourceId)}`)
      usedIds.push(idText(row.resourceId))
    }
  }
  const counts = formatCounts(row.counts, row.operation)
  if (counts) parts.push(counts)
  if (!parts.length) return { kind, text: '未记录', missing: true, untrusted: false, usedIds }
  return { kind, text: parts.join(' · '), missing: false, untrusted: false, usedIds }
}

/** 按来源把真实业务对象（fileId/page/batchId/resourceId/taskId/计数）派生成目标列。 */
export function rowTarget(row: LogSummary): LogTarget {
  switch (row.source) {
    case 'http':
    case 'mcp':
      return httpTarget(row)
    case 'file':
      return businessTarget(row, 'file')
    case 'ocr':
      return businessTarget(row, 'ocr')
    case 'import':
      return businessTarget(row, 'import')
    case 'export':
      return businessTarget(row, 'export')
    case 'task':
      return businessTarget(row, 'task')
    case 'worker':
      return businessTarget(row, 'worker')
    case 'platform':
      return businessTarget(row, 'platform')
    case 'client': {
      const value = text(row.untrustedRelatedRequestId)
      return value
        ? { kind: 'client', text: `客户端声称 ${value}`, missing: false, untrusted: true, usedIds: [] }
        : { kind: 'client', text: '未记录', missing: true, untrusted: true, usedIds: [] }
    }
    case 'system': {
      const queryAttempt = queryAttemptTotal(row) !== undefined
      const counts = formatCounts(row.counts, row.operation, queryAttempt)
      // A count must not replace the connection purpose that was visible on
      // pre-summary records. Keep both in the target and its full title.
      if (queryAttempt && hasId(row.resourceId)) return {
        kind: 'system', text: `${resourceIdLabel(row.resourceType, row.resourceId)} · ${counts}`,
        missing: false, untrusted: false, usedIds: [idText(row.resourceId)]
      }
      if (counts) return { kind: 'system', text: counts, missing: false, untrusted: false, usedIds: [] }
      if (hasId(row.resourceId))
        return {
          kind: 'system',
          text: `${resourceTypeLabel(row.resourceType)} ${resourceIdLabel(row.resourceType, row.resourceId)}`,
          missing: false,
          untrusted: false,
          usedIds: [idText(row.resourceId)]
        }
      return { kind: 'system', text: '未记录', missing: true, untrusted: false, usedIds: [] }
    }
    default:
      return businessTarget(row, 'none')
  }
}

export function logReferences(row: LogSummary): LogReference[] {
  const out: LogReference[] = []
  if (hasText(row.requestId)) out.push({ kind: '请求', value: row.requestId })
  if (hasText(row.traceId)) out.push({ kind: '链路', value: row.traceId })
  if (hasText(row.taskId)) out.push({ kind: '任务', value: row.taskId })
  return out
}

export interface LogRowView {
  sourceLabel: string
  sourceCode: string
  operationLabel: string | null
  operationCode: string
  target: LogTarget
  outcomeLabel: string
  outcomeCode: string
  outcomeVariant: LogBadgeVariant
  outcomeClass: string
  levelVariant: LogBadgeVariant
  levelClass: string
  durationText: string
  durationMissing: boolean
  statusText: string
  statusMissing: boolean
  statusApplicable: boolean
  references: LogReference[]
  primaryReference: LogReference | null
  extraReferenceCount: number
  errorCodeText: string
  errorCodePresent: boolean
  errorCodeApplicable: boolean
}

/** 列表/详情共用的一处派生：来源、操作、目标、结果、失败码、耗时、状态、关联。 */
export function describeLogRow(row: LogSummary): LogRowView {
  const target = rowTarget(row)
  const errorCode = errorCodeView(row)
  const durationMissing = row.durationMs === undefined
  const statusApplicable = row.statusCode !== undefined || row.source === 'http' || row.source === 'mcp'
  const durationDisabled = durationMissing && fieldOmission(row, 'durationMs') === 'disabled'
  const statusDisabled = row.statusCode === undefined && fieldOmission(row, 'statusCode') === 'disabled'
  const references = logReferences(row).filter((entry) => !target.usedIds.includes(entry.value))
  return {
    sourceLabel: sourceLabel(row.source),
    sourceCode: row.source,
    operationLabel: operationLabel(row.operation),
    operationCode: row.operation,
    target,
    outcomeLabel: outcomeLabel(row.outcome),
    outcomeCode: row.outcome,
    outcomeVariant: outcomeVariant(row.outcome),
    outcomeClass: outcomeClass(row.outcome),
    levelVariant: levelVariant(row.level),
    levelClass: levelClass(row.level),
    durationText: durationMissing ? (durationDisabled ? '当时未启用采集' : '未记录') : `${row.durationMs} ms`,
    durationMissing,
    statusText:
      row.statusCode !== undefined
        ? String(row.statusCode)
        : statusDisabled
          ? '当时未启用采集'
          : statusApplicable
            ? '未记录'
            : '—',
    statusMissing: row.statusCode === undefined && statusApplicable,
    statusApplicable,
    references,
    primaryReference: references[0] ?? null,
    extraReferenceCount: Math.max(0, references.length - 1),
    errorCodeText: errorCode.text,
    errorCodePresent: errorCode.present,
    errorCodeApplicable: errorCode.applicable
  }
}
