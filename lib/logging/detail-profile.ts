import type { FieldCapturedLogEvent, LogOrigin } from './contract'

/**
 * Detail fields are selected from the event's source/operation/result, not from
 * severity. A field only exists when it is applicable; optional fields appear
 * only when present. `counts` and a real `errorCode` are never hidden by level.
 */
export interface DetailSection {
  title: string
  fields: string[]
  showTarget?: boolean
  note?: string
  /** Listed keys the writer recorded as disabled at capture time; never inferred from policy. */
  disabledFields?: string[]
}
/** Detail reads the writer's projection; legacy rows carry no capture at all. */
export type DetailEvent = FieldCapturedLogEvent
/**
 * Why an optional field is missing. `disabled` comes only from the writer's own
 * capture fact for that event, never from the current policy or from severity.
 */
export type FieldOmission = 'present' | 'disabled' | 'absent'

const field = (event: DetailEvent, key: string): unknown => {
  const source = event as Record<string, any>
  if (key.startsWith('origin.')) {
    const origin = source.origin
    return origin && typeof origin === 'object' ? origin[key.slice(7)] : undefined
  }
  if (!key.startsWith('mcp.')) {
    if (!key.startsWith('tus.')) return source[key]
    return source.tus?.[key.slice(4)]
  }
  const rest = key.slice(4)
  if (rest === 'clientName') return source.mcp?.client?.name
  if (rest === 'clientVersion') return source.mcp?.client?.version
  return source.mcp?.[rest]
}
export function detailFieldValue(event: DetailEvent, key: string): unknown {
  return field(event, key)
}
const present = (event: DetailEvent, key: string) => field(event, key) !== undefined
const DISABLED: ReadonlySet<string> = new Set()
/** Reads the bounded capture fact; a row without capture keeps its historical unknown wording. */
export function disabledFields(event: DetailEvent): ReadonlySet<string> {
  const disabled = event.fieldCapture?.disabled
  if (!Array.isArray(disabled) || !disabled.length) return DISABLED
  // Runtime responses can carry wider shapes than the frozen type; only strings count.
  return new Set<string>(
    (disabled as readonly unknown[]).filter((key): key is string => typeof key === 'string')
  )
}
export function fieldOmission(event: DetailEvent, key: string): FieldOmission {
  if (field(event, key) !== undefined) return 'present'
  return disabledFields(event).has(key) ? 'disabled' : 'absent'
}

/**
 * Only operations whose failure branches are known to emit a stable code get a
 * "missing" prompt. Partial/no_record/cancelled/unknown are legitimate without
 * one; HTTP/MCP transport completions have status/outcome instead of a code.
 */
const failureCodeContracts: RegExp[] = [
  /^mcp\.tool\.(?!batch$|unknown$)[a-z0-9_]+$/,
  /^task\.finished$/,
  /^file\.(upload|register|register\.refresh|render|render\.page|parse\.(revise|replay)|maintenance\.[a-z_]+|maintenance\.update|maintenance\.remove|disk\.remove)$/,
  /^ocr\.(page|page\.delete|page\.revise|file)$/,
  /^import\./,
  /^export\./,
  /^worker\.enterprise_read\./,
]
export function errorCodeMissingIsInformative(event: DetailEvent): boolean {
  if (!['failure', 'denied', 'timeout'].includes(event.outcome)) return false
  return failureCodeContracts.some(pattern => pattern.test(event.operation))
}
/** A disabled value still gets its row so the reason is "当时未启用采集", not a bare "未记录". */
const listed = (event: DetailEvent, key: string) =>
  present(event, key) || fieldOmission(event, key) === 'disabled'
function resultFields(event: DetailEvent): string[] {
  const fields = ['outcome']
  if (event.errorCode !== undefined || errorCodeMissingIsInformative(event)) fields.push('errorCode')
  if (listed(event, 'durationMs')) fields.push('durationMs')
  if (listed(event, 'statusCode')) fields.push('statusCode')
  if (event.counts && Object.keys(event.counts).length) fields.push('counts')
  return fields
}
function targetFields(event: DetailEvent): string[] {
  switch (event.source) {
    case 'http':
    case 'mcp': return ['httpMethod', 'httpRoute'].filter(key => listed(event, key))
    case 'file': return event.tus ? [] : ['fileId', 'page'].filter(key => present(event, key))
    case 'ocr': return ['fileId', 'page'].filter(key => present(event, key))
    case 'task': return ['taskId'].filter(key => present(event, key))
    case 'worker': return ['taskId', 'resourceType', 'resourceId'].filter(key => present(event, key))
    case 'platform': return ['batchId', 'page', 'resourceType', 'resourceId'].filter(key => present(event, key))
    case 'import': return ['batchId', 'receiptId', 'resourceType', 'resourceId'].filter(key => present(event, key))
    case 'export': return ['taskId', 'resourceType', 'resourceId'].filter(key => present(event, key))
    case 'client': return ['untrustedRelatedRequestId'].filter(key => present(event, key))
    case 'system': return ['resourceType', 'resourceId'].filter(key => present(event, key))
    default: return []
  }
}
function correlationFields(event: DetailEvent, target: string[]): string[] {
  const keys = [
    'requestId', 'traceId', 'taskId', 'fileId', 'page', 'batchId', 'resourceType', 'resourceId',
    'auditId', 'receiptId', 'parentEventId', 'untrustedRelatedRequestId',
  ]
  return keys.filter(key => !target.includes(key) && present(event, key))
}
function targetNote(event: DetailEvent): string | undefined {
  if (event.origin?.integration === 'drizzle' && event.operation.startsWith('db.query.')) {
    return 'Drizzle 执行前查询钩子，仅表示查询尝试，不代表执行成功或失败；不保存 SQL 或绑定参数。准备或参数绑定失败可能不触发此钩子。'
  }
  if (event.origin?.integration === 'embedpdf' && event.operation.startsWith('client.embedpdf.log_')) {
    return '这里只记录 EmbedPDF 原生日志的级别，不据此判断文档是否加载或渲染成功；原始消息与参数不进入日志。'
  }
  if (event.source === 'file' && event.operation === 'file.upload' && !event.tus) {
    return '未获得可验证的服务端 tus uploadId；请求可能在创建上传前已被拒绝，尚不能关联分片。'
  }
  if (event.source === 'worker' && event.operation.startsWith('enterprise_read.process.')) {
    return '进程生命周期事件没有单个 taskId/resourceId；多个请求共享 worker 时只能按 requestId 关联。'
  }
  // A route the writer recorded as disabled was never captured, so it must not be
  // described as "framework found no match"; leave that wording to a real gap.
  if (
    (event.source === 'http' || event.source === 'mcp') &&
    fieldOmission(event, 'httpRoute') === 'absent'
  ) {
    return '框架未匹配到已知路由模板；不从具体 path 推断路由。'
  }
  return undefined
}
function mcpFields(event: DetailEvent): string[] {
  if (!event.mcp) return []
  return [
    'mcp.transport',
    'mcp.sessionMode',
    'mcp.rpcMethod',
    'mcp.tool',
    'mcp.clientName',
    'mcp.clientVersion',
    'mcp.protocolVersionRequested',
  ].filter(key => key === 'mcp.transport' || key === 'mcp.sessionMode' || present(event, key))
}
function tusFields(event: DetailEvent): string[] {
  if (!event.tus) return []
  return ['tus.uploadId', 'tus.phase', 'tus.method', 'tus.size', 'tus.offset'].filter(key => present(event, key))
}
/** 采集信息只在事件实际带 origin 时出现；旧记录不补造来源。 */
function originFields(event: DetailEvent): string[] {
  return ['origin.runtime', 'origin.integration', 'origin.capture', 'origin.execution'].filter(key =>
    present(event, key)
  )
}
function originNote(origin: LogOrigin): string {
  const base = '采集信息描述日志如何进入系统，不代表故障归因或鉴权身份'
  if (origin.execution === 'worker') return `${base}；工作进程是执行位置，可与 Node 运行时同时存在。`
  return `${base}。`
}

export function detailProfile(event: DetailEvent): DetailSection[] {
  const sections: DetailSection[] = [
    {
      title: '基本信息',
      fields: ['id', 'timestamp', 'source', 'level', 'operation'].filter(key => present(event, key)),
    },
    {
      title: '目标与对象',
      showTarget: true,
      fields: targetFields(event),
      ...(targetNote(event) ? { note: targetNote(event) } : {}),
    },
    { title: '结果与计数', fields: resultFields(event) },
  ]
  if (event.origin) {
    sections.splice(1, 0, {
      title: '采集信息',
      fields: originFields(event),
      note: originNote(event.origin),
    })
  }
  if (event.mcp) {
    sections.push({
      title: 'MCP 调用',
      fields: mcpFields(event),
      ...(event.mcp.rpcMethod === 'initialize' && event.mcp.client
        ? { note: '客户端信息来自初始化请求的自报，不是鉴权身份；当前 stateless 模式下后续调用不继承。' }
        : {}),
    })
  }
  if (event.tus) {
    sections.push({
      title: '上传（TUS）',
      fields: tusFields(event),
      note: 'uploadId 来自服务端 tus 回调；size 为声明总量，offset 为实际回调值；非终态分片成功不落事件。',
    })
  }
  const correlation = correlationFields(event, targetFields(event))
  if (correlation.length) sections.push({ title: '关联标识', fields: correlation })
  return sections
    .filter(section => section.showTarget || section.fields.length > 0)
    .map(section => {
      const disabled = section.fields.filter(key => fieldOmission(event, key) === 'disabled')
      return disabled.length ? { ...section, disabledFields: disabled } : section
    })
}
