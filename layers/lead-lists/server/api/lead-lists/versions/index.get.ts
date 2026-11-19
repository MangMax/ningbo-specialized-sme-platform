import { useDb } from '@db'
import { listLeadVersions } from '../../../utils/versions'

defineRouteMeta({ openAPI: { tags: ['线索名单'], summary: '读取线索系列、名单版本和来源字典', responses: { 200: { description: '版本目录' } } } })

export default defineEventHandler(() => listLeadVersions(useDb()))
