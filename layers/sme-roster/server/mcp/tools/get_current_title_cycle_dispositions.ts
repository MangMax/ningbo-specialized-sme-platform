import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { dispositionSchemas, runtimeDispositionOperation, dispositionFailure } from '../../utils/title-cycle-disposition-protocol'
export default defineMcpTool({
 name: 'get_current_title_cycle_dispositions', description: 'current Little Giant disposition revisions. Assert/replace pending; confirm explicit; immutable history. No current qualification list effect in this protocol slice.',

 annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
 inputSchema: dispositionSchemas.current.shape,
 handler: async input => { try { return await runtimeDispositionOperation('current',input) } catch(error) { return {isError:true,content:[{type:'text' as const,text:JSON.stringify(dispositionFailure(error).body)}]} } },
})
