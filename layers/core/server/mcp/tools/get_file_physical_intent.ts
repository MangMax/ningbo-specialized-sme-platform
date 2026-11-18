import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { z } from 'zod'
import { physicalFileForAgent } from '../../utils/file-physical-agent'
import { fileRefShape } from '../../../../../server/utils/mcp-files'
export default defineMcpTool({
  name: 'get_file_physical_intent', title: 'get_file_physical_intent', description: '读取文件最新物理删除意图及完成回执；可指定 intentId。pending/recovering 不表示磁盘原路径可用。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...fileRefShape, intentId: z.string().min(1).max(100).optional(), }, handler: input => physicalFileForAgent('read', input),
})
