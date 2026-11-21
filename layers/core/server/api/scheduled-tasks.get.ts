import { readScheduledJobs } from '../../../../server/scheduling/scheduled-jobs'

defineRouteMeta({ openAPI: { tags: ['任务'], summary: '查看定时任务、下次运行时间和最近一次执行' } })

export default defineEventHandler(() => readScheduledJobs())
