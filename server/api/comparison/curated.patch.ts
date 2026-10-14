import { parseCurationPatch, patchCuration } from '~~/lib/curation'

/**
 * 人工标注:把一条比对结果标为「已看过 / 不算差异」,或者取消标注。
 * `PATCH /api/comparison/curated`
 *
 * 写的是 `data/reconciliation-curated.json`(本地人工标注文件),**不碰台账**
 * (记录与身份归并只能由 pipeline 写,见 data-integrity 的安全阀)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['比对'],
    summary: '人工标注一条比对结果',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            description: '标注内容(键的形状见 `lib/curation.ts` 的 `parseCurationPatch`)。',
          },
        },
      },
    },
    responses: {
      200: { description: '标注后的状态。' },
      400: { description: '请求体不合法。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  let patch
  try {
    patch = parseCurationPatch(await readBody(event))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: (error as Error).message })
  }
  patchCuration(useRuntimeConfig(event).curatedPath, patch)
  return { curated: patch.curated }
})
