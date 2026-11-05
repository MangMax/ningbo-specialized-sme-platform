import { useDb } from '@db'
import { snapshotJudgment } from '../../utils/snapshot-judgment'
import { requireApiToken } from '../../utils/api-guard'
defineRouteMeta({openAPI:{tags:['任务'],summary:'代理读取/覆盖任务差异判断与操作记录',description:'#484：解释有效性、复核回执、查询覆盖及旧决定生命周期退出本任务新流程，不作为状态或队列门；改判覆盖并留操作日志，不产生 previous_id/lifecycle_action/replace/withdraw。旧端点、ID及审计仅兼容可读。action=read|write，jobId/enterpriseId/titleCode/direction；write 必须提供 expectedToken（read 返回 token，初始 0）及 expected/current 全部当前值及 actor（已鉴权代理自报标签）。current 含 status/reasonCode/measureCode/notes/searchedScope/gaps/evidence。CAS 冲突 409；非终结须记录已查范围及缺口。无版本链。',security:[{bearerAuth:[]}]}})
export default defineEventHandler(async event=>{
 requireApiToken(event)
 return snapshotJudgment(useDb(),await readBody(event))
})
