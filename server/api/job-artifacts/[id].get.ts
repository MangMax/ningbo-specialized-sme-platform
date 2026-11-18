import { sendStream } from 'h3'
import { useDb } from '@db'
import { isJobId } from '../../../layers/core/lib/job'
import { requireTaskCenterAccess } from '../../../layers/core/server/utils/task-center-access'
import { getJob } from '../../../layers/core/server/utils/job-store'
import { artifactStream, currentArtifact, EXPORT_MIME } from '../../../layers/sme-roster/server/utils/current-export-artifact'
import { appLog, requestLogContext } from '../../../layers/core/lib/logging'
defineRouteMeta({openAPI:{tags:['当前名录导出'],summary:'下载后台导出产物',security:[{bearerAuth:[]}],description:'与提交同一API token边界。只接受受控产物ULID；不接受文件路径。保留7天，过期410，缺失404，任务历史保留。同源页面请求通过浏览器标记、Fetch Metadata 及 Origin/Referer 校验后可直接操作，POST 还需 JSON；其他请求仍需 API token。此检查不识别用户。',parameters:[{in:'path',name:'id',required:true,schema:{type:'string'}}],responses:{200:{description:'Excel字节',content:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':{schema:{type:'string',format:'binary'}}}},401:{description:'需要token'},404:{description:'无可用产物'},410:{description:'已过期，请重新导出'}}}})
export default defineEventHandler(async event => {
  const logContext = requestLogContext(event)
  let taskId: string | undefined, completed = false
  const record = (outcome: 'success' | 'failure' | 'cancelled' | 'denied', statusCode: number, errorCode?: string) => {
    if (completed) return
    completed = true
    appLog({ module: 'sme-roster', source: 'export', operation: 'export.artifact.download', outcome, statusCode, level: outcome === 'failure' ? 'error' : outcome === 'success' ? 'info' : 'warn', errorCode, ...(taskId ? { taskId, resourceType: 'export_artifact', resourceId: taskId } : {}) }, logContext)
  }
  try {
  requireTaskCenterAccess(event)
  const id = getRouterParam(event,'id')
  if (!isJobId(id)) throw createError({statusCode:400,message:'产物ID非法'})
  const db = useDb(), job = getJob(db,id)
  // A syntactically valid URL parameter alone does not establish a known job.
  if (job?.kind === 'current-roster-export') taskId = job.id
  const artifact = job ? await currentArtifact(job,db.$client.name,logContext) : null
  if (artifact?.availability === 'expired') throw createError({statusCode:410,message:'产物已过期，请重新导出'})
  if (!artifact || artifact.availability !== 'available') throw createError({statusCode:404,message:'产物不存在或尚未发布'})
  setHeader(event,'content-type',EXPORT_MIME)
  setHeader(event,'content-disposition',`attachment; filename="${artifact.filename}"`)
  setHeader(event,'content-length',artifact.size)
  setHeader(event,'etag',`"${artifact.sha256}"`)
  setHeader(event,'cache-control','private, no-store')
  const stream = artifactStream(db.$client.name,id)
  event.node.res.once('finish', () => record('success', 200))
  event.node.res.once('close', () => {
    if (event.node.res.writableFinished) return
    record('cancelled', 200, 'download_disconnected')
    // h3 awaits end/error, while pipe() pauses on a closed response. Settle the
    // owned read stream and close its handle; the published artifact is retained.
    stream.destroy(new Error('Export artifact download disconnected'))
  })
  stream.once('error', () => record('failure', 500, 'artifact_read_failed'))
  return await sendStream(event,stream)
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode ?? 500
    record(status < 500 ? 'denied' : 'failure', status, status === 401 ? 'artifact_access_denied' : status === 410 ? 'artifact_expired' : status === 404 ? 'artifact_unavailable' : status === 400 ? 'invalid_artifact_id' : 'artifact_read_failed')
    throw error
  }
})
