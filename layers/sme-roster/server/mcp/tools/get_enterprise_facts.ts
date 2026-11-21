import { readRuntimeEnterpriseFacts } from '../../utils/enterprise-facts-runtime'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'

export default defineMcpTool({
 name: 'get_enterprise_facts', title: 'get enterprise assertions',
 description: 'Equivalent to GET facts. Independent sourced assertions, immutable lifecycle audit; no legacy promotion. Assert/replace starts pending; confirm is explicit; terminal facts cannot revive. Read version, preflight full command, commit {request,planHash}.',
 annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

 inputSchema: { enterpriseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) },
 handler: async ({ enterpriseId }) => await readRuntimeEnterpriseFacts(enterpriseId),
})
