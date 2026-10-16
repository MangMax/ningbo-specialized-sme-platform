import { useDb } from '@db'
import { collectUsccTargets, pageUsccChecklist, planUsccResearch } from '~~/server/utils/uscc-research'
import { parseUsccResearchBody } from '~~/server/utils/uscc-research-query'
import { normalizeUsccVerdicts, type UsccVerdictFile } from '~~/server/utils/uscc-verdicts'

/**
 * 与 `GET` 同一份清单与计划，但**多收一批公开来源查证结果**（票面路径二）。
 *
 * 为什么是 POST：`claims` 是结构化的、成百条级、每条都带 URL 与依据 —— 放进 query string
 * 既不合适也有长度风险。**但它与 GET 一样只读**：一行都不写，返回的仍是「计划 + 四项计数 +
 * 可直接提交的请求体」。真正的落库在 `POST /api/roster/import/commit`
 * （`payload.usccBackfills`，契约 §8.10），那条路要 token，这条不要。
 *
 * claim 的语义判定（代码格式/校验位、公众来源三要素、地区是否相符、统代是否已被占用）
 * 一律在 `planUsccResearch` 里做，**这一层只检查形状**（见 `uscc-research-query.ts`）。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '缺统一社会信用代码企业：带公开来源查证的补录计划（只读）',
    description:
      '与 GET 同一份待查清单与库内计划，额外接收 `claims`（公开主体来源查证结果：' +
      '统一社会信用代码 + 来源 URL + 查证日期 + 主体对应依据），逐条判定后并入计划。' +
      '代码格式/校验位不合法、来源证据不齐、地区不符、统代已被别家占用 ⇒ 分别落冲突/待人工，' +
      '**绝不填猜测值**。只读，不写库；写入仍走 `POST /api/roster/import/commit`。',
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              q: { type: 'string' },
              title: { type: 'string' },
              district: { type: 'string' },
              claims: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    enterpriseId: { type: 'integer' },
                    enterpriseName: { type: 'string' },
                    uscc: { type: 'string' },
                    source: {
                      type: 'object',
                      properties: {
                        url: { type: 'string' },
                        checkedOn: { type: 'string' },
                        basis: { type: 'string' },
                        name: { type: 'string' },
                        region: { type: 'string', nullable: true },
                      },
                    },
                    note: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: '`{ checklist, plan }`；`plan.request` 可直接 POST 给提交接口（无项时为 `null`）。' },
      400: { description: '`claims` 形状不合法或 `title` 不在字典内。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const parsed = parseUsccResearchBody(await readBody(event))
  if (!parsed.ok) throw createError({ statusCode: 400, statusMessage: parsed.message })
  const db = useDb()
  // **一次全表扫描**：清单与计划共用同一份目标行（见 `collectUsccTargets` 的注释）。
  const targets = collectUsccTargets(db, parsed.planFilter)
  // 判定文件**只做归一化**（哪些条目能被采纳是服务端判定）：采纳的进平台证据认领，
  // 未采纳的（冲突 / 未找到 / 待人工）如实回给调用方，一行都不写。
  const ingest = parsed.verdictFiles.length
    ? normalizeUsccVerdicts(
        parsed.verdictFiles.map(({ file, value }) => ({ file, value: value as UsccVerdictFile })),
      )
    : null
  return {
    checklist: pageUsccChecklist(targets, parsed.filter),
    plan: planUsccResearch(db, {
      filter: parsed.planFilter,
      targets,
      ...(parsed.enterpriseIds ? { enterpriseIds: parsed.enterpriseIds } : {}),
      // 公开来源认领 = 调用方直接给的 + 判定文件里 `verdict: 'found'` 归一化出来的。
      claims: [...parsed.claims, ...(ingest?.claims ?? [])],
      // 给了认领（含判定文件）⇒ 计划**只判这些目标**，不顺手跑全库库内计划（见 planUsccResearch）。
      platformClaims: [...parsed.platformClaims, ...(ingest?.platformClaims ?? [])],
    }),
    ...(ingest
      ? {
          verdicts: {
            batches: ingest.batches,
            accepted: ingest.platformClaims.length,
            foundClaims: ingest.claims.length,
            untouched: ingest.untouched,
            problems: ingest.problems,
          },
        }
      : {}),
  }
})
