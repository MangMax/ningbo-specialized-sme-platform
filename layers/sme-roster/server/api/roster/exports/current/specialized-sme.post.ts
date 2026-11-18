import { currentExportRoute } from '../../../../utils/current-export-route'
defineRouteMeta({ openAPI: {
  tags:['当前名录导出'], summary:'提交专精特新中小企业当前有效名录后台导出', security:[{bearerAuth:[]}],
  description:'返回202及Location，使用GET /api/jobs/{id}查询。完成后按同一请求校验边界下载 /api/job-artifacts/{id}；保留7天。按clientRequestId去重，重新生成需新标识并给regenerateOf。不接收历史日期。同源页面请求通过浏览器标记、Fetch Metadata 及 Origin/Referer 校验后可直接操作，POST 还需 JSON；其他请求仍需 API token。此检查不识别用户。',
  requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required:['clientRequestId'],properties:{clientRequestId:{type:'string',description:'1–128字符，稳定请求标识'},regenerateOf:{type:'string'}}}}}},
  responses:{202:{description:'已受理或重复请求的既有任务；jobId、state、Location。'},400:{description:'参数非法'},401:{description:'需要API token'},409:{description:'请求标识冲突'},429:{description:'导出容量已满，稍后重试'}}
} })
export default currentExportRoute('specialized_sme')
