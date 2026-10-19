import { sendStream } from 'h3'
import { useDb } from '@db'
import { isJobId } from '../../../lib/job'
import { requireApiToken } from '../../utils/api-guard'
import { getJob } from '../../utils/job-store'
import { artifactStream, currentArtifact, EXPORT_MIME } from '../../utils/current-export-artifact'
defineRouteMeta({openAPI:{tags:['当前名录导出'],summary:'下载后台导出产物',security:[{bearerAuth:[]}],description:'与提交同一API token边界。只接受受控产物ULID；不接受文件路径。保留7天，过期410，缺失404，任务历史保留。',parameters:[{in:'path',name:'id',required:true,schema:{type:'string'}}],responses:{200:{description:'Excel字节',content:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':{schema:{type:'string',format:'binary'}}}},401:{description:'需要token'},404:{description:'无可用产物'},410:{description:'已过期，请重新导出'}}}})
export default defineEventHandler(async event => {
  requireApiToken(event)
  const id = getRouterParam(event,'id')
  if (!isJobId(id)) throw createError({statusCode:400,message:'产物ID非法'})
  const db = useDb(), job = getJob(db,id)
  const artifact = job ? await currentArtifact(job,db.$client.name) : null
  if (artifact?.availability === 'expired') throw createError({statusCode:410,message:'产物已过期，请重新导出'})
  if (!artifact || artifact.availability !== 'available') throw createError({statusCode:404,message:'产物不存在或尚未发布'})
  setHeader(event,'content-type',EXPORT_MIME)
  setHeader(event,'content-disposition',`attachment; filename="${artifact.filename}"`)
  setHeader(event,'content-length',artifact.size)
  setHeader(event,'etag',`"${artifact.sha256}"`)
  setHeader(event,'cache-control','private, no-store')
  return sendStream(event,artifactStream(db.$client.name,id))
})
