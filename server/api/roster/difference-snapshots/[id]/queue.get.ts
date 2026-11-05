import { getQuery } from 'h3'
import { useDb } from '@db'
import { readSnapshotQueue } from '../../../../utils/difference-queue'
import { requireApiToken } from '../../../../utils/api-guard'
defineRouteMeta({ openAPI: { tags:['任务'],description:'#484：解释有效性、复核回执、查询覆盖及旧决定生命周期退出本任务新流程，不作为状态或队列门；改判覆盖并留操作日志，不产生 previous_id/lifecycle_action/replace/withdraw。旧端点、ID及审计仅兼容可读。view=pending（默认）或 judged；status/reasonCode 沿用六状态七原因。覆盖当前判断并筛选后计算 total 和分页，unfinished 独立返回。',summary:'读取指定任务快照的非终结差异队列',security:[{bearerAuth:[]}],parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}},{name:'page',in:'query',schema:{type:'integer',minimum:1}},{name:'pageSize',in:'query',schema:{type:'integer',minimum:1,maximum:200}}] } })
export default defineEventHandler(event=>{
  requireApiToken(event)
  setHeader(event,'cache-control','no-store')
  return readSnapshotQueue(useDb(),{...(getQuery(event) as Record<string,unknown>),jobId:getRouterParam(event,'id')})
})
