import { useDb } from '@db'
import { requireApiToken } from '../../../../utils/api-guard'
import { ensureJobRunnerReady, getJobSpec, submitJob } from '../../../../utils/job-runner'
import { registerJobSpecs } from '../../../../utils/job-specs'
defineRouteMeta({ openAPI: {
  tags:['当前名录导出'], summary:'提交专精特新中小企业当前有效名录后台导出', security:[{bearerAuth:[]}],
  description:'返回202及Location，使用GET /api/jobs/{id}查询。完成后凭token下载 /api/job-artifacts/{id}；保留7天。按clientRequestId去重，重新生成需新标识并给regenerateOf。不接收历史日期。',
  requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required:['clientRequestId'],properties:{clientRequestId:{type:'string',description:'1–128字符，稳定请求标识'},regenerateOf:{type:'string'}}}}}},
  responses:{202:{description:'已受理或重复请求的既有任务；jobId、state、Location。'},400:{description:'参数非法'},401:{description:'需要API token'},409:{description:'请求标识冲突'},429:{description:'导出容量已满，稍后重试'}}
} })
export default defineEventHandler(async event => {
  requireApiToken(event)
  registerJobSpecs()
  const db = useDb(); ensureJobRunnerReady(db)
  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body) || 'titleCode' in body || Object.keys(getQuery(event)).length) throw createError({statusCode:400,message:'需要JSON对象；不接收称号覆盖或日期参数'})
  const parsed = getJobSpec('current-roster-export')!.parse({...body,titleCode:'specialized_sme'})
  if (!parsed.ok) throw createError({statusCode:400,message:parsed.message})
  const job = submitJob(db,{kind:'current-roster-export',params:parsed.params,filesDir:useRuntimeConfig(event).filesDir})
  setResponseStatus(event,202); setHeader(event,'location',`/api/jobs/${job.id}`)
  return {jobId:job.id,kind:job.kind,state:job.state}
})
