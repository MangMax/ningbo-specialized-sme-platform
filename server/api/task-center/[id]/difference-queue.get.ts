import { getQuery } from 'h3'
import { useDb } from '@db'
import { requireTaskCenterAccess } from '../../../utils/task-center-access'
import { readSnapshotQueue } from '../../../utils/difference-queue'
defineRouteMeta({openAPI:{tags:['任务'],summary:'浏览器读取任务快照待核队列'}})
export default defineEventHandler(event=>{
  requireTaskCenterAccess(event)
  setHeader(event,'cache-control','no-store')
  return readSnapshotQueue(useDb(),{...(getQuery(event) as Record<string,unknown>),jobId:getRouterParam(event,'id')})
})
