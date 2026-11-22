import { dispatchPostgresOfficialEvidenceMcp } from '../../utils/official-evidence-read-postgres'
import { eventReadShape } from '../../utils/official-evidence-read'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
export default defineMcpTool({ name: 'get_official_event', title: '读取正式事件与版本出处', description: '等价 GET /api/roster/events/:id。精确读取 event、record、原 evidence、文件哈希与现有生命周期；旧读法公开。可选official=latest需MCP token；逐出处latest按afterEvidenceId分页20/50，maxBytes16384/65536；旧无sidecar明确unknown，不嵌套修订。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: eventReadShape, handler: async args => ({ content: [{type:'text' as const,text:JSON.stringify(await dispatchPostgresOfficialEvidenceMcp('event', 'get', args, true))}] }) })
