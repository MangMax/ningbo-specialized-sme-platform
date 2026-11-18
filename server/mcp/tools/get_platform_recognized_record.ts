import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { getTargetRecognizedRecord } from '../../../layers/sme-roster/server/utils/platform-recognized-target'

export default defineMcpTool({
  name: 'get_platform_recognized_record',
  title: '读取单条平台认定目录记录的实际观察与历史版本',
  description:
    '等价 GET /api/platform/recognized-directory/{recordId}。只读本地 recognized_list 目录记录；返回全部内容版本（含未建立 typed 投影的历史版本）与实际观察元数据，包括有效期原值、维护年/批次、属地、认定说明、行称号原值与查询称号范围，以及行称号是否与查询范围冲突；不返回 raw JSON、不复制对应决定。版本最多100、观察最多200，超出时 counts.*Truncated=true。这是目录镜像，不作为当前有效资格判定。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { recordId: z.number().int().positive() },
  handler: async input => {
    const result = getTargetRecognizedRecord(useDb(), input.recordId)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
