import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { getPlatformDeclaration } from '../../utils/platform-declarations'

export default defineMcpTool({
  name: 'get_platform_declaration',
  title: '读取单条申报记录的实际观察与历史版本',
  description:
    '等价 GET /api/platform/declarations/{recordId}。只读本地 apply_list 申报记录；返回全部内容版本（含未建立 typed 投影的历史版本）与实际观察元数据，不返回 raw JSON、不复制对应决定。版本最多100、观察最多200，超出时 counts.*Truncated=true。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { recordId: z.number().int().positive() },
  handler: async input => {
    const result = getPlatformDeclaration(useDb(), input.recordId)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
