import { supplementSchema } from '../../../../../utils/announcement-intake-model'
import { intakeRoute } from '../../../../../utils/announcement-intake-route'
import { supplementPostgresAnnouncement } from '../../../../../utils/announcement-supplement-postgres'
import { usePostgresRosterDb } from '../../../../../utils/postgres-roster-db'

defineRouteMeta({ openAPI: {
  tags: ['名录'], summary: '从同源页面预检或提交公布名单', security: [],
  description: '只在可写模式接受同源 JSON 请求。按原行序提交核对决定；先用 preflight: true 预检，提交时带回预检返回的 officialEvidencePlanHash（如有）。',
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['sourceDigest', 'basis', 'rows'],
    properties: {
      sourceDigest: { type: 'string' }, basis: { type: 'string' },
      preflight: { type: 'boolean', enum: [true] }, officialEvidencePlanHash: { type: 'string' },
      rows: { type: 'array', items: { type: 'object' } },
    },
  } } } },
  responses: {
    200: { description: '预检结果或提交回执' }, 403: { description: '同源检查失败' },
    415: { description: '不是 JSON 请求' }, 503: { description: '当前应用为只读模式' },
  },
} })

export default intakeRoute(
  (id, input, filesDir) => supplementPostgresAnnouncement(usePostgresRosterDb(true), id, input, filesDir),
  supplementSchema, 'browser-write',
)
