import type { LogEvent, LogSummary } from './contract'

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
}
export type DetailEvent = LogSummary | LogEvent

const field = (event: DetailEvent, key: string): unknown => {
  const source = event as Record<string, any>
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
function resultFields(event: DetailEvent): string[] {
  const fields = ['outcome']
  if (event.errorCode !== undefined || errorCodeMissingIsInformative(event)) fields.push('errorCode')
  if (event.durationMs !== undefined) fields.push('durationMs')
  if (event.statusCode !== undefined) fields.push('statusCode')
  if (event.counts && Object.keys(event.counts).length) fields.push('counts')
  return fields
}
function targetFields(event: DetailEvent): string[] {
  switch (event.source) {
    case 'http':
    case 'mcp': return ['httpMethod', 'httpRoute'].filter(key => present(event, key))
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
  if (event.source === 'file' && event.operation === 'file.upload' && !event.tus) {
    return '未获得可验证的服务端 tus uploadId；请求可能在创建上传前已被拒绝，尚不能关联分片。'
  }
  if (event.source === 'worker' && event.operation.startsWith('enterprise_read.process.')) {
    return '进程生命周期事件没有单个 taskId/resourceId；多个请求共享 worker 时只能按 requestId 关联。'
  }
  if ((event.source === 'http' || event.source === 'mcp') && !event.httpRoute) {
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
  return sections.filter(section => section.showTarget || section.fields.length > 0)
}
