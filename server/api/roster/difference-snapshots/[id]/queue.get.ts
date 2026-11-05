import { getQuery } from 'h3'
import { useDb } from '@db'
import { readSnapshotQueue } from '../../../../utils/difference-queue'
import { requireApiToken } from '../../../../utils/api-guard'
defineRouteMeta({ openAPI: { tags:['任务'],summary:'读取指定任务快照的非终结差异队列',security:[{bearerAuth:[]}],parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}},{name:'page',in:'query',schema:{type:'integer',minimum:1}},{name:'pageSize',in:'query',schema:{type:'integer',minimum:1,maximum:200}}] } })
export default defineEventHandler(event=>{
  requireApiToken(event)
  setHeader(event,'cache-control','no-store')
  return readSnapshotQueue(useDb(),{...(getQuery(event) as Record<string,unknown>),jobId:getRouterParam(event,'id')})
})
