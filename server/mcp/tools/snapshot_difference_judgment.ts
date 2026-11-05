import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { z } from 'zod'
import { judgmentInput, snapshotJudgment } from '../../utils/snapshot-judgment'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({name:'snapshot_difference_judgment',title:'读取或覆盖任务差异判断',description:'#484：解释有效性、复核回执、查询覆盖及旧决定生命周期退出本任务新流程，不作为状态或队列门；改判覆盖并留操作日志，不产生 previous_id/lifecycle_action/replace/withdraw。旧端点、ID及审计仅兼容可读。与 POST /api/roster/difference-judgments 同一接缝。read 返回完整平台历史、冻结公布出处、当前值及操作日志；write 原样提交 read 返回的 token 为 expectedToken（初始 0），同时比较 expected 再覆盖 current。actor 是鉴权代理自报标签，不授予权限。无自动分类、版本链或资格门。',enabled:writeGuard,inputSchema:{input:z.unknown().meta(z.toJSONSchema(judgmentInput,{io:'input'}))},handler:async ({input})=>({content:[{type:'text' as const,text:JSON.stringify(await snapshotJudgment(useDb(),input))}]})})
