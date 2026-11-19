import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { dispositionSchemas, dispositionOperation, dispositionFailure } from '../../utils/title-cycle-disposition-protocol'
export default defineMcpTool({
 name: 'list_title_cycle_disposition_history', description: 'history Little Giant disposition revisions. Assert/replace pending; confirm explicit; immutable history. No current qualification list effect in this protocol slice.',

 annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
 inputSchema: dispositionSchemas.history.shape,
 handler: async input => { try { return dispositionOperation(useDb(),'history',input) } catch(error) { return {isError:true,content:[{type:'text' as const,text:JSON.stringify(dispositionFailure(error).body)}]} } },
})
