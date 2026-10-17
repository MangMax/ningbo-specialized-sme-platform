import { useDb } from '@db'
import { collectUsccTargets, pageUsccChecklist, planUsccResearch } from '~~/server/utils/uscc-research'
import { parseUsccChecklistQuery } from '~~/server/utils/uscc-research-query'

/**
 * **缺统一社会信用代码企业的待查清单 + 库内补录计划**（RL-06）。
 *
 * 读接口**不鉴权**（与既有分法一致：读不鉴权，写/任务鉴权）。返回两样东西：
 *
 *  1. `checklist` —— 仍缺统代的企业的**待查清单**：企业名 / 地区 / 称号 /
 *     **来源文件与可用页码** / 该企业的**接口匹配追溯**（为什么它还没解决）。
 *     筛选参数与总表同口径（`q` / `title` / `district` / 分页）。
 *  2. `plan` —— **只读**的补录计划：跑一遍「库内核心词 → 候选 → 平台原始关系逐字验证」，
 *     输出「补齐 / 冲突 / 未找到 / 待人工」四项计数与逐条理由，并给出一份可直接
 *     `POST /api/roster/import/commit` 的请求体（`request`，无可执行项时为 `null`）。
 *
 * ⚠️ **本端点一行都不写**。真正的落库只有 `POST /api/roster/import/commit` 一条路
 * （契约 §8.2/§8.4/§8.10）—— 与 RL-14 的重名候选报告同一个做法：读侧判证据、写侧只有入口。
 *
 * 带公开来源查证结果（`claims`）的那一轮走 `POST` 本路径（GET 只跑**库内**路径）。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '缺统一社会信用代码企业：待查清单 + 库内补录计划',
    description:
      '列出仍缺统一社会信用代码的企业（含地区、称号、来源文件与页码、接口匹配追溯），' +
      '并跑一遍「库内核心词候选 → 平台原始关系逐字验证」，输出补齐/冲突/未找到/待人工四项计数' +
      '与可直接提交的 `POST /api/roster/import/commit` 请求体。**只读，不写库。**',
    parameters: [
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '名称 / 已确认曾用名关键词。' },
      { name: 'title', in: 'query', schema: { type: 'string' }, description: '称号（逗号分隔）。' },
      { name: 'district', in: 'query', schema: { type: 'string' }, description: '属地。' },
      { name: 'page', in: 'query', schema: { type: 'integer' }, description: '清单页码，默认 1。' },
      { name: 'pageSize', in: 'query', schema: { type: 'integer' }, description: '清单每页，默认 50。' },
    ],
    responses: {
      200: { description: '`{ checklist, plan }`；`plan.request` 可直接 POST 给提交接口（无项时为 `null`）。' },
      400: { description: '`title` / 分页参数不合法。' },
    },
  },
})

export default defineEventHandler((event) => {
  const parsed = parseUsccChecklistQuery(getQuery(event))
  if (!parsed.ok) throw createError({ statusCode: 400, statusMessage: parsed.message })
  const db = useDb()
  // **一次全表扫描**：清单与计划共用同一份目标行（见 `collectUsccTargets` 的注释）。
  const targets = collectUsccTargets(db, parsed.planFilter)
  return {
    checklist: pageUsccChecklist(targets, parsed.filter),
    plan: planUsccResearch(db, { filter: parsed.planFilter, targets }),
  }
})
