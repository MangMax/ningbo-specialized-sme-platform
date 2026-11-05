import { getQuery } from 'h3'
import { useDb } from '@db'
import { requireTaskCenterAccess } from '../../../utils/task-center-access'
import { readSnapshotQueue } from '../../../utils/difference-queue'
defineRouteMeta({openAPI:{tags:['任务'],description:'view=pending（默认）或 judged；status/reasonCode 沿用六状态七原因。覆盖当前判断并筛选后计算 total 和分页，unfinished 独立返回。',summary:'浏览器读取任务快照待核队列'}})
export default defineEventHandler(event=>{
  requireTaskCenterAccess(event)
  setHeader(event,'cache-control','no-store')
  return readSnapshotQueue(useDb(),{...(getQuery(event) as Record<string,unknown>),jobId:getRouterParam(event,'id')})
})
