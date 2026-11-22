import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { platformEvidenceInputSchema } from '../../../lib/platform/evidence-input'
import { readPostgresPlatformEvidence } from '../../../lib/platform/postgres-evidence-read'
import { usePostgresDirectoryDb } from '../../../../../db/postgresql/client'
export default defineMcpTool({
  name: 'get_platform_query_evidence', title: '按ID精确分段读取平台原档',
  description: '等价 GET /api/platform/queries/{queryId}/evidence。legacyProvenance读取独立legacy采集原档，typed仍未知；rawResponse/collectionEvidence/legacyProvenance/relation按UTF-8字节返回最多65536字节的base64块；拼接全部字节再解码，依据hasMore继续。relations按原序分页发现全部关系ID，再用relation+relationId读取所有持久化字段JSON（camelCase，含rawFields）。null和空值可区分；不截断原文、不查询外部平台。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: platformEvidenceInputSchema.shape,
  handler: async input => {
    const postgres = usePostgresDirectoryDb()
    return { ...await readPostgresPlatformEvidence(postgres, input) }
  },
})
