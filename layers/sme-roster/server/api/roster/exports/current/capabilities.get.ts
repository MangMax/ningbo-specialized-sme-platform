import routes from '#current-export-routes'
import { postgresJobsEnabled } from '../../../../../../core/server/utils/postgres-jobs'
import { getJobSpec } from '../../../../../../core/server/utils/job-runner'
import { registerJobSpecs } from '../../../../../../../server/utils/job-specs'
defineRouteMeta({ openAPI: {
  tags: ['当前名录导出'], summary: '发现已部署当前名录导出入口',
  description: '公开只读的轻量路由能力；不含任务、凭据或业务数据。与生产OpenAPI开关无关。',
  responses: { 200: { description: '本构建实际已注册专用POST入口及任务kind就绪状态。' } },
} })
export default defineEventHandler(event => {
  setHeader(event, 'cache-control', 'no-store')
  registerJobSpecs()
  const spec = getJobSpec('current-roster-export')
  const ready = spec?.status === 'ready' && (process.env.NUXT_POSTGRES_ROSTER_READ !== '1' ||
    postgresJobsEnabled() && Boolean(spec.postgres))
  return { exports: routes.map(route => ({ ...route, ready })) }
})
