import { z } from 'zod'
import { intakeRoute } from '../../../../../utils/announcement-intake-route'
import { removePostgresAnnouncementIntake } from '../../../../../utils/announcement-intake-postgres'
import { usePostgresRosterDb } from '../../../../../utils/postgres-roster-db'

defineRouteMeta({ openAPI: {
  tags: ['名录'], summary: '从名录录入移出名单版本', security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['sourceDigest', 'reason'],
    properties: { sourceDigest: { type: 'string' }, reason: { type: 'string' } },
  } } } },
  responses: { 200: { description: '保留原行、基础库及历史来源' }, 409: { description: '名单版本冲突' } },
} })
const input = z.strictObject({ sourceDigest: z.string().regex(/^[0-9a-f]{64}$/), reason: z.string().trim().min(1).max(4000) })
export default intakeRoute((id, body) => {
  const pg = usePostgresRosterDb(true)
  return removePostgresAnnouncementIntake(pg, id, body.sourceDigest, body.reason)
}, input)
