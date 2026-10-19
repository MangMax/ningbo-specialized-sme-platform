import { currentExportRoute } from '../../../../utils/current-export-route'
defineRouteMeta({ openAPI: {
  tags:['当前名录导出'], summary:'提交专精特新中小企业当前有效名录后台导出', security:[{bearerAuth:[]}],
  description:'返回202及Location，使用GET /api/jobs/{id}查询。完成后凭token下载 /api/job-artifacts/{id}；保留7天。按clientRequestId去重，重新生成需新标识并给regenerateOf。不接收历史日期。',
  requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required:['clientRequestId'],properties:{clientRequestId:{type:'string',description:'1–128字符，稳定请求标识'},regenerateOf:{type:'string'}}}}}},
  responses:{202:{description:'已受理或重复请求的既有任务；jobId、state、Location。'},400:{description:'参数非法'},401:{description:'需要API token'},409:{description:'请求标识冲突'},429:{description:'导出容量已满，稍后重试'}}
} })
export default currentExportRoute('specialized_sme')
