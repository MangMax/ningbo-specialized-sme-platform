import { describe, expect, it } from 'vitest'
import type { LogEvent } from '../lib/logging/contract'
import { errorCodeMissingIsInformative, detailProfile } from '../lib/logging/detail-profile'
import { formatCounts } from '../components/logs/logPresentation'
import { projectEvlog, safeLogEvent, safeMcpContext, safeTusContext } from '../lib/logging/privacy'

const event = (over: Partial<LogEvent>): LogEvent => ({
  id: '00000000-0000-4000-8000-000000000180',
  timestamp: '2026-10-22T00:00:00.000Z',
  level: 'info', source: 'http', operation: 'http.request', outcome: 'success', ...over,
} as LogEvent)
const fields = (row: LogEvent) => detailProfile(row).flatMap(section => section.fields)
const section = (row: LogEvent, title: string) => detailProfile(row).find(entry => entry.title === title)

describe('#180 source-aware detail profile', () => {
  it('selects only applicable targets for all eleven sources', () => {
    const samples = [
      event({ source: 'http', httpMethod: 'GET', httpRoute: '/api/health', statusCode: 200, durationMs: 3, requestId: 'req-http' }),
      event({ source: 'mcp', operation: 'mcp.tool.get_platform_capabilities', mcp: { transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'tools/call', tool: 'get_platform_capabilities' }, httpMethod: 'POST', httpRoute: '/mcp' }),
      event({ source: 'task', operation: 'task.finished', outcome: 'failure', taskId: 'task-1', counts: { done: 2, total: 3, failed: 1 }, errorCode: 'job_failed' }),
      event({ source: 'worker', operation: 'enterprise_read.finished', outcome: 'failure', taskId: 'task-1', resourceType: 'enterprise', resourceId: 42, errorCode: 'worker_failed' }),
      event({ source: 'platform', operation: 'platform.query_list.query.title_1', outcome: 'partial', batchId: 'batch-1', page: 2, counts: { done: 1, total: 2, failed: 1 } }),
      event({ source: 'file', operation: 'file.render', outcome: 'partial', fileId: 8, page: 3, counts: { done: 1, total: 2 } }),
      event({ source: 'ocr', operation: 'ocr.page', outcome: 'failure', fileId: 8, page: 3, errorCode: 'ocr_page_failed' }),
      event({ source: 'import', operation: 'import.commit', outcome: 'failure', batchId: 'batch-1', receiptId: 'receipt-1', counts: { done: 1, failed: 1 }, errorCode: 'import_conflict' }),
      event({ source: 'export', operation: 'export.current.publish', taskId: 'task-1', resourceType: 'export_artifact', resourceId: 'artifact-1', counts: { done: 1, total: 1 } }),
      event({ source: 'client', operation: 'client.logs.network', outcome: 'failure', untrustedRelatedRequestId: 'original-1' }),
      event({ source: 'system', operation: 'logging.clear', counts: { done: 0 } }),
    ]
    const all = samples.map(fields)
    // Each source sees its own target fields and does not inherit every other source's blanks.
    expect(all[0]).not.toEqual(expect.arrayContaining(['fileId', 'page', 'batchId', 'taskId', 'counts']))
    expect(all[1]).not.toEqual(expect.arrayContaining(['fileId', 'page', 'batchId', 'counts']))
    expect(all[2]).toEqual(expect.arrayContaining(['taskId', 'counts', 'errorCode']))
    expect(all[3]).toEqual(expect.arrayContaining(['taskId', 'resourceType', 'resourceId']))
    expect(all[4]).toEqual(expect.arrayContaining(['batchId', 'page', 'counts']))
    expect(all[5]).toEqual(expect.arrayContaining(['fileId', 'page', 'counts']))
    expect(all[6]).toEqual(expect.arrayContaining(['fileId', 'page', 'errorCode']))
    expect(all[7]).toEqual(expect.arrayContaining(['batchId', 'receiptId', 'counts']))
    expect(all[8]).toEqual(expect.arrayContaining(['taskId', 'resourceType', 'resourceId']))
    expect(all[9]).toEqual(expect.arrayContaining(['untrustedRelatedRequestId']))
    expect(all[10]).toEqual(expect.arrayContaining(['counts']))
    for (const [index, sourceFields] of all.entries()) if (index !== 1) expect(sourceFields).not.toContain('mcp.transport')
  })

  it('keeps zero counts and a real errorCode regardless of severity', () => {
    const zero = event({ source: 'system', operation: 'logging.clear', level: 'debug', counts: { done: 0, total: 0, failed: 0, dropped: 0 } })
    expect(fields(zero)).toContain('counts')
    expect(formatCounts(zero.counts)).toBe('已处理 0/0 · 失败 0 · 丢弃 0')
    const odd = event({ source: 'task', operation: 'task.finished', outcome: 'success', level: 'error', errorCode: 'job_failed' })
    expect(fields(odd)).toContain('errorCode')
    expect(section(odd, '结果与计数')!.fields).toContain('outcome')
  })

  it('only explains a missing errorCode for known failure-contract operations and failure/denied/timeout', () => {
    expect(errorCodeMissingIsInformative(event({ source: 'task', operation: 'task.finished', outcome: 'failure' }))).toBe(true)
    expect(errorCodeMissingIsInformative(event({ source: 'task', operation: 'task.finished', outcome: 'timeout' }))).toBe(true)
    expect(errorCodeMissingIsInformative(event({ source: 'task', operation: 'task.finished', outcome: 'partial' }))).toBe(false)
    expect(errorCodeMissingIsInformative(event({ source: 'task', operation: 'task.finished', outcome: 'cancelled' }))).toBe(false)
    expect(errorCodeMissingIsInformative(event({ source: 'http', operation: 'http.request', outcome: 'failure' }))).toBe(false)
    expect(errorCodeMissingIsInformative(event({ source: 'client', operation: 'client.logs.network', outcome: 'failure' }))).toBe(false)
    expect(errorCodeMissingIsInformative(event({ source: 'mcp', operation: 'mcp.tool.get_platform_capabilities', outcome: 'failure' }))).toBe(true)
    expect(fields(event({ source: 'http', operation: 'http.request', outcome: 'failure' }))).not.toContain('errorCode')
    expect(fields(event({ source: 'task', operation: 'task.finished', outcome: 'failure' }))).toContain('errorCode')
  })

  it('shows MCP client self-report only on initialize and keeps unknown/multi facts unattributed', () => {
    const initialized = event({
      source: 'mcp', operation: 'mcp.request', mcp: {
        transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'initialize',
        client: { name: 'cursor', version: '1.2.3', trust: 'self-reported', capturedAt: 'initialize' },
        protocolVersionRequested: '2025-06-18',
      },
    })
    expect(section(initialized, 'MCP 调用')!.fields).toEqual(expect.arrayContaining([
      'mcp.transport', 'mcp.sessionMode', 'mcp.rpcMethod', 'mcp.clientName', 'mcp.clientVersion', 'mcp.protocolVersionRequested',
    ]))
    expect(section(initialized, 'MCP 调用')!.note).toContain('不是鉴权身份')

    const toolCall = event({
      source: 'mcp', operation: 'mcp.tool.get_platform_capabilities', mcp: {
        transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'tools/call', tool: 'get_platform_capabilities',
      },
    })
    expect(section(toolCall, 'MCP 调用')!.fields).toEqual(expect.arrayContaining(['mcp.tool']))
    expect(section(toolCall, 'MCP 调用')!.fields).not.toContain('mcp.clientName')
    expect(section(toolCall, 'MCP 调用')!.note).toBeUndefined()

    const batch = event({ source: 'mcp', operation: 'mcp.request', mcp: { transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'batch' } })
    expect(section(batch, 'MCP 调用')!.fields).toContain('mcp.rpcMethod')
    expect(section(batch, 'MCP 调用')!.fields).not.toContain('mcp.tool')
  })

  it('uses a dedicated TUS section and never pretends an upload is a registered file', () => {
    const uploadId = '0123456789abcdef0123456789abcdef'
    const created = event({ source: 'file', operation: 'file.upload', outcome: 'started', httpMethod: undefined, httpRoute: undefined, tus: { uploadId, phase: 'created', method: 'POST', size: 300, offset: 0 } })
    const target = section(created, '目标与对象')!
    expect(target.fields).toEqual([])
    expect(target.showTarget).toBe(true)
    expect(target.note).toBeUndefined()
    expect(section(created, '上传（TUS）')!.fields).toEqual(expect.arrayContaining(['tus.uploadId', 'tus.phase', 'tus.method', 'tus.size', 'tus.offset']))
    expect(fields(created)).not.toContain('fileId')
    expect(fields(created)).not.toContain('page')
    const failed = event({ source: 'file', operation: 'file.upload', outcome: 'denied', tus: { uploadId, phase: 'request-failed', method: 'PATCH' } })
    expect(section(failed, '目标与对象')!.note).toBeUndefined()
    expect(section(failed, '上传（TUS）')!.fields).toContain('tus.phase')
  })

  it('keeps old rows readable without inventing MCP/TUS sections', () => {
    const old = event({ source: 'worker', operation: 'legacy.fixture', outcome: 'failure', taskId: 'task-old', errorCode: 'old_code' })
    const titles = detailProfile(old).map(entry => entry.title)
    expect(titles).not.toContain('MCP 调用')
    expect(titles).not.toContain('上传（TUS）')
    expect(fields(old)).toEqual(expect.arrayContaining(['taskId', 'errorCode']))
  })
})

describe('#180 safe source-specific projection', () => {
  it('classifies a client without persisting raw name/version/session/tool text', () => {
    const safe = safeLogEvent({
      source: 'mcp', operation: 'mcp.request', outcome: 'success',
      mcp: {
        transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'initialize',
        client: { name: 'PRIVATE_TOKEN_180', version: 'PRIVATE_VERSION_180', trust: 'self-reported', capturedAt: 'initialize' } as any,
        protocolVersionRequested: 'PRIVATE_PROTOCOL_180' as any,
      },
    })
    expect(safe.mcp?.client).toMatchObject({ name: 'other', trust: 'self-reported', capturedAt: 'initialize' })
    expect(safe.mcp?.client?.version).toBeUndefined()
    expect(safe.mcp?.protocolVersionRequested).toBeUndefined()
    expect(JSON.stringify(safe)).not.toContain('PRIVATE')
  })

  it('accepts trusted init metadata but ignores toolkit session/request/tool objects', () => {
    const projected = projectEvlog({
      path: '/mcp', method: 'POST', status: 200, requestId: 'req-mcp-180',
      mcp: { transport: 'streamable-http', method: 'tools/call', tool: 'PRIVATE_RAW_TOOL', session_id: 'PRIVATE_SESSION', request_id: 'PRIVATE_RPC_ID' },
      applicationLogMcp: {
        transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'tools/call', tool: 'get_platform_capabilities',
      },
    })
    expect(projected.mcp).toMatchObject({ rpcMethod: 'tools/call', tool: 'get_platform_capabilities', sessionMode: 'stateless' })
    expect(JSON.stringify(projected)).not.toContain('PRIVATE')
    const rawOnly = projectEvlog({
      path: '/mcp', method: 'POST', status: 200,
      mcp: { transport: 'streamable-http', method: 'tools/call', tool: 'PRIVATE_RAW_TOOL', session_id: 'PRIVATE_SESSION' },
    })
    expect(rawOnly.mcp).toMatchObject({ rpcMethod: 'tools/call' })
    expect(rawOnly.mcp?.tool).toBeUndefined()
    expect(JSON.stringify(rawOnly)).not.toContain('PRIVATE')
  })

  it('rejects malformed TUS ids and unsafe numeric values, but keeps real bounded facts', () => {
    expect(safeTusContext({ uploadId: 'PRIVATE/path', phase: 'completed' })).toBeUndefined()
    expect(safeTusContext({ uploadId: '0123456789abcdef0123456789abcdef', phase: 'completed', method: 'PATCH', size: 300, offset: 100 })).toEqual({
      uploadId: '0123456789abcdef0123456789abcdef', phase: 'completed', method: 'PATCH', size: 300, offset: 100,
    })
    expect(safeTusContext({ uploadId: '0123456789abcdef0123456789abcdef', phase: 'completed', size: -1, offset: 1.5 })).toEqual({
      uploadId: '0123456789abcdef0123456789abcdef', phase: 'completed',
    })
    expect(safeMcpContext({ rpcMethod: 'initialize', client: { name: 'cursor-vscode', version: '1.2.3' }, protocolVersionRequested: '2025-06-18' }, undefined, true)).toMatchObject({
      rpcMethod: 'initialize', client: { name: 'cursor', version: '1.2.3', trust: 'self-reported', capturedAt: 'initialize' }, protocolVersionRequested: '2025-06-18',
    })
  })
})
