import { eq } from 'drizzle-orm'
import { postgresLeadListExport } from '../../../../../../../db/postgresql/lead-tables'
import { leadListExport } from '../../../../../schema'
import { usePostgresLeadDb } from '../../../../utils/postgres-versions'
import { useDb } from '@db'
import { isJobId } from '#core/lib/job'
import { requireTaskCenterAccess } from '#core/server/utils/task-center-access'
import { getJob } from '#core/server/utils/job-store'
import { getPostgresJob } from '#core/server/utils/job-store-postgres'
import { LEAD_LIST_EXPORT } from '../../../../../lib/export-contract'

defineRouteMeta({ openAPI: {
  tags: ['线索名单'], summary: '下载已完成的名单版本 CSV', security: [{ bearerAuth: [] }],
  responses: { 200: { description: 'CSV 文件' }, 409: { description: '任务尚未完成' } },
} })

export default defineEventHandler(async event => {
  requireTaskCenterAccess(event)
  const id = getRouterParam(event, 'jobId')
  if (!isJobId(id)) throw createError({ statusCode: 400, message: '任务编号有误' })
  const pg = usePostgresLeadDb()
  const sqlite = pg ? undefined : useDb()
  const task = pg ? (await getPostgresJob(pg, id))?.row : getJob(sqlite!, id)
  if (task?.kind !== LEAD_LIST_EXPORT) throw createError({ statusCode: 404, message: '名单导出任务不存在' })
  if (task.state !== 'done') throw createError({ statusCode: 409, message: '名单导出尚未完成' })
  const artifact = pg
    ? (await pg.select({ versionId: postgresLeadListExport.versionId, content: postgresLeadListExport.content })
        .from(postgresLeadListExport).where(eq(postgresLeadListExport.jobId, id)))[0]
    : sqlite!.select({ versionId: leadListExport.versionId, content: leadListExport.content })
        .from(leadListExport).where(eq(leadListExport.jobId, id)).get()
  if (!artifact || artifact.versionId !== task.params.versionId) throw createError({ statusCode: 404, message: '名单导出文件不存在' })
  setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="lead-list-${artifact.versionId}.csv"`)
  setHeader(event, 'Cache-Control', 'no-store')
  return artifact.content
})
