import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { queueInput, readSnapshotQueue } from '../../utils/difference-queue'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({
  name:'list_snapshot_difference_queue',title:'读取任务快照待核队列',
  description:'仅使用所选任务冻结的公布坐标和自身三接口采集段；不读导出成员或全局旧归档。默认 pending 仅未终结；view=judged 查看终结结果，可用 status/reasonCode 筛选，先筛选再计数分页；未完成范围单独返回。等价 GET /api/roster/difference-snapshots/{jobId}/queue。',
  enabled:writeGuard,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema:queueInput.shape,
  handler:async input=>({content:[{type:'text' as const,text:JSON.stringify(readSnapshotQueue(useDb(),input))}]}),
})
