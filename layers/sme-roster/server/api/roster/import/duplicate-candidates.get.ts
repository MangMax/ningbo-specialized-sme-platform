import { useDb } from '@db'
import { planDuplicateMerge } from '#sme-roster/server/utils/roster-duplicate-merge'

/**
 * **重名候选报告**（RL-14）：某批导入报出的重名候选，以及「哪些有证据可并、哪些待核」。
 *
 * ── 为什么是读接口 ──────────────────────────────────────────────────────
 * 导入侧只负责把候选**显式报出来**（`import_batch.item_results` 里 `kind='duplicate_candidate'`）；
 * 「这条候选能不能并」需要另一份证据 —— **已落库的平台关系**（同一统代下 `qymc` 逐字等于
 * 被并方名称）。把这件事做成**只读**报告，是为了让判定过程可复核、可重放，并且**不产生第二种
 * 写入口**：真正落库仍然只有 `POST /api/roster/import/commit` 一条路。
 *
 * 读接口**不鉴权**（与既有分法一致：读不鉴权，写/任务鉴权）。报告里的 `request` 就是可以
 * 提交请求体（含幂等键），按当前契约预检后提交。
 *
 * ── 证据不足一律不并 ────────────────────────────────────────────────────
 * 拿不到平台关系证据的候选**不进** `ready`，留在 `pending` 里带一句可读的理由
 * （`no_platform_query` / `name_not_evidenced` / `source_gone` / `source_claimed` …）。
 * 没有任何相似度匹配、没有任何按名推断。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '重名候选报告（可并 / 待核）',
    description:
      '按导入批次幂等键读回该批报出的**重名候选**（新建企业时库里已有同名行），并逐条判定：' +
      '平台关系证据成立（`qymc` 逐字等于被并方名称）⇒ 可并；否则列待核。只读，不写库。',
    parameters: [
      {
        name: 'batchKey',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: '产出候选的导入批次幂等键（`import_batch.idempotency_key`）。',
      },
    ],
    responses: {
      200: {
        description:
          '`{ batchKey, batchId, counts, candidates, ready, pending, request }`；' +
          '`request` 可直接 POST 给 `/api/roster/import/commit`（无可并项时为 `null`）。',
      },
      400: { description: '缺少 `batchKey`。' },
      404: { description: '该幂等键没有批次。' },
    },
  },
})

export default defineEventHandler((event) => {
  const raw = getQuery(event).batchKey
  const batchKey = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  if (!batchKey) {
    throw createError({ statusCode: 400, statusMessage: '缺少 batchKey（导入批次幂等键）' })
  }
  const report = planDuplicateMerge(useDb(), batchKey)
  if (report.batchId == null) {
    throw createError({ statusCode: 404, statusMessage: `没有这个导入批次：${batchKey}` })
  }
  return report
})
