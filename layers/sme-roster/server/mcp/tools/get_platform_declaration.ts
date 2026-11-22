import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { readPlatformArchiveDetail } from '../../utils/platform-archive-read'

export default defineMcpTool({
  name: 'get_platform_declaration',
  title: '读取单条申报记录的当前业务内容及采集证据',
  description:
    "等价 GET /api/platform/declarations/{recordId}。返回申报记录的当前业务内容和当次采集摘要。",

  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { recordId: z.number().int().positive() },
  handler: async input => {
    const result = await readPlatformArchiveDetail('declarations', input.recordId)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
