import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
import { dispositionSchemas, dispositionOperation, dispositionFailure } from '../../../layers/sme-roster/server/utils/title-cycle-disposition-protocol'
export default defineMcpTool({
 name: 'commit_title_cycle_disposition', description: 'commit Little Giant disposition revisions. Assert/replace pending; confirm explicit; immutable history. No current qualification list effect in this protocol slice.',
 enabled: writeGuard,
 annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
 inputSchema: dispositionSchemas.commit.shape,
 handler: async input => { try { return dispositionOperation(useDb(),'commit',input) } catch(error) { return {isError:true,content:[{type:'text' as const,text:JSON.stringify(dispositionFailure(error).body)}]} } },
})
