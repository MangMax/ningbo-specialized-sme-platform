import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { commitEnterpriseFact, enterpriseFactCommitSchema } from '../../utils/enterprise-facts'
export default defineMcpTool({
 name: 'commit_enterprise_fact', title: 'commit enterprise assertions',
 description: 'Equivalent to POST facts/commit. Independent sourced assertions, immutable lifecycle audit; no legacy promotion. Assert/replace starts pending; confirm is explicit; terminal facts cannot revive. Read version, preflight full command, commit {request,planHash}.',
 annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
 enabled: writeGuard,
 inputSchema: { enterpriseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), request: enterpriseFactCommitSchema },
 handler: async ({ enterpriseId, request }) => commitEnterpriseFact(useDb(), enterpriseId, request),
})
