import { setHeader } from 'h3'
import { listPostgresAnnouncementIntakes } from '../../../../utils/announcement-intake-postgres'
import { usePostgresRosterDb } from '../../../../utils/postgres-roster-db'

defineRouteMeta({ openAPI: {
  tags: ['名录'], summary: '列出公布名单入库批次', security: [],
  responses: { 200: { description: '公布名单批次摘要，按登记 ID 倒序' } },
} })

export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  return listPostgresAnnouncementIntakes(usePostgresRosterDb())
})
