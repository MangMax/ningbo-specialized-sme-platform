import { annualTaskRoute } from '../../../../layers/sme-roster/server/utils/annual-correspondence-route'
import { annualTaskContext } from '../../../../layers/sme-roster/server/utils/annual-correspondence-read'
defineRouteMeta({ openAPI: { tags: ['年度对应'], summary: '读取年度对应任务与当前最终资格', description: '来源代次由服务端冻结；GET零写。页面写命令使用browserReview部署闸门，REST使用API token。',

  responses: { 200: { description: '当前状态或取消回执' }, 202: { description: '任务已受理' }, 400: { description: '无效输入' }, 401: { description: '需要API凭据' }, 403: { description: '页面写能力或同源闸门拒绝' }, 409: { description: '幂等、来源代次或任务状态冲突' } }
} })
export default annualTaskRoute('detail', annualTaskContext)
