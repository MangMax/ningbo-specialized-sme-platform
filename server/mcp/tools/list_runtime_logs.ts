import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../utils/mcp-guard'
import { logFilterSchema, loggingMcpResult } from '../../utils/logging-mcp'
export default defineMcpTool({ name: 'list_runtime_logs', description: '受保护运行日志摘要；需MCP token。与GET /api/logs共用模块。精确索引筛选，limit≤100，稳定nextCursor，无原始错误正文。', enabled: writeGuard, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { ...logFilterSchema, limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(16).optional() }, handler: input => loggingMcpResult('list', input) })
