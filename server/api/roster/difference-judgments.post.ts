import { useDb } from '@db'
import { snapshotJudgment } from '../../utils/snapshot-judgment'
import { requireApiToken } from '../../utils/api-guard'
defineRouteMeta({openAPI:{tags:['任务'],summary:'代理读取/覆盖任务差异判断与操作记录',description:'action=read|write，jobId/enterpriseId/titleCode/direction；write 必须提供 expected/current 全部当前值及 actor（已鉴权代理自报标签）。current 含 status/reasonCode/measureCode/notes/searchedScope/gaps/evidence。CAS 冲突 409；非终结须记录已查范围及缺口。无版本链。',security:[{bearerAuth:[]}]}})
export default defineEventHandler(async event=>{
 requireApiToken(event)
 return snapshotJudgment(useDb(),await readBody(event))
})
