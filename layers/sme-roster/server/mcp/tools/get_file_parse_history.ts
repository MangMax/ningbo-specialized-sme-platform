import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { usePostgresFileDb } from '../../../../core/server/utils/file-store-postgres'
import { historyPostgresParse } from '../../utils/parse-maintenance-postgres'
import { parseHistory105 } from '../../utils/parse-maintenance-contract'
export default defineMcpTool({
  name: 'get_file_parse_history', title: '读取有界解析维护审计/原始回执',
  description: 'fileId必填。afterId游标、limit默认20最多50;升序摘要不含前后快照。receiptId显式点读原始完整回执,不得混分页。与REST parse-result/history相同。',
  annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: parseHistory105.shape,
  handler: input => {
    const pg = usePostgresFileDb()
    return historyPostgresParse(pg, input)
  },
})
