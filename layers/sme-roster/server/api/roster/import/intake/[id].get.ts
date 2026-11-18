import { useDb } from '@db'
import { readAnnouncementIntake } from '../../../../utils/announcement-intake'
import { intakeRoute } from '../../../../utils/announcement-intake-route'

defineRouteMeta({ openAPI: {
  tags: ['名录'], summary: '读取独立留存的公布行及补充回执', security: [{ bearerAuth: [] }],
  responses: { 200: { description: '原始公布行和不可变版本摘要' }, 404: { description: '未找到公布名单' } },
} })
export default intakeRoute(id => readAnnouncementIntake(useDb(), id))
