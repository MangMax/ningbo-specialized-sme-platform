import { platformQueryCapabilities } from '../../../lib/platform/live-query'
defineRouteMeta({ openAPI: { tags: ['平台实时查询'], summary: '平台实时查询来源能力与安全上限', responses: { 200: { description: '逐来源支持条件、称号能力、缓存和全局并发预算。' } } } })
export default defineEventHandler(() => platformQueryCapabilities)
