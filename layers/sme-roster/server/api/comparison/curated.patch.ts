import { parseCurationPatch } from '#sme-roster/lib/curation-model'
import { DecisionError102 } from '../../utils/decision-lifecycle-102/contract'
import { patchPostgresLegacyCuration102 } from '../../utils/legacy-curation-102'
import { usePostgresRosterDb } from '../../utils/postgres-roster-db'

/** Legacy annotations remain separate from formal difference decisions. */
defineRouteMeta({
  openAPI: {
    tags: ['比对'],
    summary: '人工标注一条比对结果（兼容入口）',
    description: '保留原载荷及 {curated:boolean} 返回值、备注省略与取消语义。只写旧 JSON，不生成 confirmed_no_diff。按精确统代/name_norm 有界查询；歧义返回409 ambiguous_enterprise。显式生命周期接管后返回409 decision_lifecycle_required，含 replacement。',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object', description: '原 CurationPatch：uscc 或 nameNorm、titleCode、direction、curated:boolean，以及可选 note:string；note省略保留旧值、空串清空。' } } },
    },
    responses: {
      200: { description: '原返回值 {curated:boolean}；仅更新未接管坐标的旧标注。' },
      400: { description: '请求体不合法。' },
      409: { description: 'decision_lifecycle_required 或 ambiguous_enterprise；JSON文件和正式决定均不变，提供 replacement。' },
    },
  },
})
export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  let patch
  try {
    patch = parseCurationPatch(await readBody(event))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: (error as Error).message })
  }
  try {
    const { curatedPath } = useRuntimeConfig(event)
    const postgres = usePostgresRosterDb(true)
    return await patchPostgresLegacyCuration102(postgres, curatedPath, patch)
  } catch (error) {
    if (!(error instanceof DecisionError102)) throw error
    setResponseStatus(event, error.statusCode)
    return { error: { code: error.code, message: error.message }, replacement: '/api/roster/decision-lifecycle/commands' }
  }
})
