import type { LogEvent, LogSummary } from '~~/lib/logging/contract'
import type { BadgeVariants } from '@/components/ui/badge'

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
  'platform.batch.retry': '平台批量重试'
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

/**
 * 计数只显示实际存在的键，不把缺失当 0，也不从计数推断 outcome。
 * `done` 在不同来源是“已处理/已写入/重试尝试”等，不能写成“已完成”。
 */
export function formatCounts(counts?: LogEvent['counts'], operation?: string): string {
  if (!counts) return ''
  const parts: string[] = []
  const retry = operation !== undefined && (operation.endsWith('.retry') || operation === 'platform.batch.retry')
  if (retry && counts.done !== undefined) parts.push(`第 ${counts.done} 次重试`)
  else if (counts.done !== undefined && counts.total !== undefined) parts.push(`已处理 ${counts.done}/${counts.total}`)
  else if (counts.total !== undefined) parts.push(`共 ${counts.total}`)
  else if (counts.done !== undefined) parts.push(`已处理 ${counts.done}`)
  if (counts.failed !== undefined) parts.push(`失败 ${counts.failed}`)
  if (counts.dropped !== undefined) parts.push(`丢弃 ${counts.dropped}`)
  return parts.join(' · ')
}

export function resourceTypeLabel(resourceType?: string): string {
  if (resourceType === 'export_artifact') return '导出产物'
  if (resourceType === 'export_job') return '导出任务'
  if (resourceType === 'enterprise') return '企业'
  return resourceType || '资源'
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const hasText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
/** batchId/resourceId 在契约里是 string | number，两种都要按事实显示。 */
const idText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
const hasId = (value: unknown): value is string | number => idText(value).length > 0

/**
 * 失败码只展示安全原码；不翻译成失败原因，也不从 outcome 反推具体码。
 * 成功/已开始/已跳过没有失败码属于预期，其余结果缺失时明确说“未记录”。
 */
export function errorCodeView(row: LogSummary): { text: string; present: boolean; applicable: boolean } {
  if (hasText(row.errorCode)) return { text: row.errorCode, present: true, applicable: true }
  const applicable = !['success', 'started', 'skipped'].includes(row.outcome)
  return { text: applicable ? '未记录' : '不适用', present: false, applicable }
}

function httpTarget(row: LogSummary): LogTarget {
  const method = text(row.httpMethod)
  const route = text(row.httpRoute)
  if (method && route) return { kind: 'http', text: `${method} ${route}`, missing: false, untrusted: false, usedIds: [] }
  if (method) return { kind: 'http', text: `${method} · 路由未记录`, missing: true, untrusted: false, usedIds: [] }
  if (route) return { kind: 'http', text: route, missing: true, untrusted: false, usedIds: [] }
  return { kind: 'http', text: '接口未记录', missing: true, untrusted: false, usedIds: [] }
}

function businessTarget(row: LogSummary, kind: LogTargetKind): LogTarget {
  const parts: string[] = []
  const usedIds: string[] = []
  if (kind === 'ocr' || kind === 'file') {
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
      parts.push(`${resourceTypeLabel(row.resourceType)} ${idText(row.resourceId)}`)
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
      parts.push(`${resourceTypeLabel(row.resourceType)} ${idText(row.resourceId)}`)
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
      parts.push(`${resourceTypeLabel(row.resourceType)} ${idText(row.resourceId)}`)
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
      const counts = formatCounts(row.counts, row.operation)
      if (counts) return { kind: 'system', text: counts, missing: false, untrusted: false, usedIds: [] }
      if (hasId(row.resourceId))
        return {
          kind: 'system',
          text: `${resourceTypeLabel(row.resourceType)} ${idText(row.resourceId)}`,
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
    durationText: durationMissing ? '未记录' : `${row.durationMs} ms`,
    durationMissing,
    statusText: row.statusCode !== undefined ? String(row.statusCode) : statusApplicable ? '未记录' : '—',
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
