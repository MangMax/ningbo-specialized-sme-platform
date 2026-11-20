import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { dispositionSchemas, runtimeDispositionOperation, dispositionFailure } from '../../utils/title-cycle-disposition-protocol'
export default defineMcpTool({
 name: 'preflight_title_cycle_disposition', description: 'preflight Little Giant disposition revisions. Assert/replace pending; confirm explicit; immutable history. No current qualification list effect in this protocol slice.',
 enabled: writeGuard,
 annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
 inputSchema: dispositionSchemas.preflight.shape,
 handler: async input => { try { return await runtimeDispositionOperation('preflight',input) } catch(error) { return {isError:true,content:[{type:'text' as const,text:JSON.stringify(dispositionFailure(error).body)}]} } },
})
