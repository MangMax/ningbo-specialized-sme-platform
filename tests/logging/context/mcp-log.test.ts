import { describe, expect, it } from 'vitest'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { MCP_PROTOCOL_VERSIONS } from '../../../layers/core/lib/logging/contract'
import { mcpLogMetadata } from '../../../layers/core/server/utils/mcp-log-context'

const known = new Set(['get_platform_capabilities', 'list_files'])

describe("MCP module-entry metadata", () => {
  it('tracks the installed SDK protocol-version set instead of a drifting regex', () => {
    expect(MCP_PROTOCOL_VERSIONS).toEqual(SUPPORTED_PROTOCOL_VERSIONS)
  })

  it('maps only exact client aliases and keeps bounded self-reported facts', () => {
    const press = mcpLogMetadata({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'cursor-vscode', version: '0.49.1' },
        capabilities: {},
      },
    }, known)
    expect(press.mcp).toMatchObject({
      transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'initialize',
      client: { name: 'cursor', version: '0.49.1', trust: 'self-reported', capturedAt: 'initialize' },
      protocolVersionRequested: '2025-06-18',
    })

    const unknown = mcpLogMetadata({
      jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { clientInfo: { name: 'my-codex-wrapper', version: 'not-semver' }, protocolVersion: 'PRIVATE_PROTOCOL' },
    }, known)
    expect(unknown.mcp?.client).toMatchObject({ name: 'other', trust: 'self-reported', capturedAt: 'initialize' })
    expect(unknown.mcp?.client?.version).toBeUndefined()
    expect(unknown.mcp?.protocolVersionRequested).toBeUndefined()
    expect(JSON.stringify(unknown)).not.toContain('my-codex-wrapper')
    expect(JSON.stringify(unknown)).not.toContain('PRIVATE_PROTOCOL')
  })

  it('keeps protocol declaration even when the client name is absent', () => {
    const result = mcpLogMetadata({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
    }, known)
    expect(result.mcp?.protocolVersionRequested).toBe('2024-11-05')
    expect(result.mcp?.client).toBeUndefined()
  })

  it('attributes only statically registered tools and keeps unknown/multi facts unattributed', () => {
    expect(mcpLogMetadata({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_files', arguments: {} } }, known).mcp)
      .toMatchObject({ rpcMethod: 'tools/call', tool: 'list_files' })
    expect(mcpLogMetadata({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'PRIVATE_TOOL', arguments: {} } }, known).mcp)
      .toMatchObject({ rpcMethod: 'tools/call' })
    expect(mcpLogMetadata({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'PRIVATE_TOOL' } }, known).mcp?.tool)
      .toBeUndefined()
    const batch = mcpLogMetadata([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_files' } },
    ], known)
    expect(batch.mcp).toMatchObject({ rpcMethod: 'batch' })
    expect(batch.mcp?.tool).toBeUndefined()
    expect(mcpLogMetadata({ jsonrpc: '2.0', id: 1, method: 'PRIVATE_METHOD' }, known).mcp)
      .toMatchObject({ rpcMethod: 'unknown' })
    expect(JSON.stringify(batch)).not.toContain('PRIVATE')
  })
})
