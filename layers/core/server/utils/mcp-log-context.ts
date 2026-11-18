import { setRequestLogMetadata, type McpLogContext } from '../../lib/logging'
import { safeMcpContext } from '../../lib/logging/privacy'

/**
 * The MCP toolkit already writes `mcp` into evlog's request logger. This helper
 * only supplies what the toolkit does not: the initialize self-report and a
 * statically registered tool name. It never copies the toolkit object or a raw
 * client-supplied name/tool/session id into the application projection.
 */
export function mcpLogMetadata(body: unknown, knownTools: ReadonlySet<string>): { mcp?: McpLogContext } {
  const messages = Array.isArray(body) ? body : [body]
  const request = messages.length === 1 && messages[0] !== null && typeof messages[0] === 'object'
    ? messages[0] as Record<string, any> : undefined
  const batch = Array.isArray(body) && body.length > 1
  const rpcMethod = batch ? 'batch' : request?.method
  const tool = request?.method === 'tools/call' && typeof request.params?.name === 'string' && knownTools.has(request.params.name)
    ? request.params.name : undefined
  const client = request?.method === 'initialize' ? request.params?.clientInfo : undefined
  const protocolVersionRequested = request?.method === 'initialize' ? request.params?.protocolVersion : undefined
  const mcp = safeMcpContext({ rpcMethod, tool, client, protocolVersionRequested }, undefined, true)
  return mcp ? { mcp } : {}
}

/** One request-local write; later semantic tool events reuse it via requestLogContext. */
export function applyMcpLogMetadata(
  event: { context: Record<string, any>; log?: { set?: (context: Record<string, unknown>) => void } | null },
  body: unknown,
  knownTools: ReadonlySet<string>,
): void {
  const { mcp } = mcpLogMetadata(body, knownTools)
  if (mcp) setRequestLogMetadata(event, { mcp })
}
