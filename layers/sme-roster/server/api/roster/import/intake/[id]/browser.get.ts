import { readPostgresAnnouncementIntake } from '../../../../../utils/announcement-intake-postgres'
import { intakeRoute } from '../../../../../utils/announcement-intake-route'
import { usePostgresRosterDb } from '../../../../../utils/postgres-roster-db'

defineRouteMeta({ openAPI: {
  tags: ['名录'], summary: '读取公布名单原行供页面核对', security: [],
  responses: { 200: { description: '原始名单行、来源摘要和入库状态' }, 404: { description: '未找到公布名单' } },
} })

export default intakeRoute(async id => {
  const { intakeId, sourceDigest, status, announcement, officialEvidencePreflightRequired } =
    await readPostgresAnnouncementIntake(usePostgresRosterDb(), id)
  return { intakeId, sourceDigest, status, announcement, officialEvidencePreflightRequired }
}, undefined, 'browser-read')
