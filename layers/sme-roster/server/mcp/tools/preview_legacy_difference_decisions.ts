import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { legacyPreviewInput102, previewPostgresLegacyDecision102 } from '../../utils/decision-legacy-preview-102'
import { decisionReadMcp102 } from '../../utils/decision-lifecycle-102-output'
export default defineMcpTool({ name: 'preview_legacy_difference_decisions', title: '只读预览旧差异标注', description: '旧标注不等同 confirmed_no_diff；分页显示精确映射、歧义和当前正式决定冲突。最多2MiB/10000键，不迁移，生产迁移须另授权。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: legacyPreviewInput102.shape, handler: async input =>
  decisionReadMcp102(tx=>previewPostgresLegacyDecision102(tx,useRuntimeConfig().curatedPath,legacyPreviewInput102.parse(input))) })
