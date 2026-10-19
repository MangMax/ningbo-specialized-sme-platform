/** Historical JSON annotations are frozen. They never become formal decisions implicitly. */
defineRouteMeta({ openAPI: { tags: ['比对'], summary: '旧人工标注写入口（已停用）', deprecated: true, description: '旧 JSON 保留只读；先 GET /api/roster/decision-lifecycle/legacy-preview 核对映射与冲突，再显式提交差异决定。生产迁移另授权。', responses: { 410: { description: 'legacy_write_retired，提供替代入口；不改旧 JSON 或正式决定' } } } })
export default defineEventHandler((event) => {
  setHeader(event, 'cache-control', 'no-store')
  setResponseStatus(event, 410)
  return { error: { code: 'legacy_write_retired', message: '旧标注写入口已停用；先预览映射/冲突，再显式提交决定。生产迁移须另授权。' }, replacement: '/api/roster/decision-lifecycle/commands', preview: '/api/roster/decision-lifecycle/legacy-preview' }
})
