import { useDb } from '@db'
import { requireTaskCenterAccess } from '../../../utils/task-center-access'
import { snapshotJudgment } from '../../../utils/snapshot-judgment'
defineRouteMeta({openAPI:{tags:['任务'],summary:'只读任务差异详情',description:'同代理 read 接缝；仅允许读取选定任务坐标，不接受写入。'}})
export default defineEventHandler(async event=>{
 requireTaskCenterAccess(event)
 setHeader(event,'cache-control','no-store')
 const query=getQuery(event)
 return snapshotJudgment(useDb(),{action:'read',jobId:getRouterParam(event,'id'),enterpriseId:Number(query.enterpriseId),titleCode:query.titleCode,direction:query.direction})
})
