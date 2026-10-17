import { useDb } from '@db'
import { listRosterRecognitions } from '~~/lib/roster/recognitions'
import { parseRosterRecognitionQuery } from '../../utils/roster-read-query'

/**
 * **首次认定清单**(契约 §7.5,RL-08)。
 *
 * ── 一行 = 一个「企业 × 称号」上的一次首次认定 ────────────────────────────
 * **不是**一行一家企业:一家企业在专精特新、创新型上各首次认定一次,就是两行。
 * 所以 `counts` 两个单位都给:`titlePairs`(企业 × 称号)与 `enterprises`(企业数)。
 * issue #8 的验收明确要求「统计清楚标示企业数或企业×称号数」——只报一个必然被误读。
 *
 * ── 口径(与 §7.1 的 `firstRecognition` **同一处计算**)─────────────────────
 * 首次认定 = 数据库中该(企业 × 称号)全部事件里的**最早正式 `award`**;年份按 `decidedYear ?? year`,
 * `review` / `maintain` / `nurture` 不计入;复核通过不是新的首次认定,
 * **复核失败后再次获批也不重置**(契约 §6.1–§6.3)。
 *
 * ── 依据必须能回到出处 ───────────────────────────────────────────────────
 * 每行带 `firstEventId` 与 `evidence`(文件 / 附件 / 序号 / 页,一条不折叠),
 * 以及 `status` / `pendingReason`:仅当数据库里现存 award 缺有效年份或首次出处时标待确认。
 * 正式历史名单完整入库由独立清理验收负责,本接口不推断未入库事件。
 *
 * 读接口不鉴权(与既有分法一致:读不鉴权,写/任务鉴权)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '首次认定清单',
    description:
      '一行 = 一个**企业 × 称号**的首次认定(数据库全部事件中最早正式 `award`,年份为 `decidedYear ?? year`; `review` / `maintain` / `nurture` 不计入,复核通过或失败后再获批都不重置)。`counts.titlePairs` 是企业×称号数,`counts.enterprises` 是企业数。仅现存 award 缺有效年份或首次出处时标 `pending`。',
    parameters: [
      {
        name: 'title',
        in: 'query',
        schema: { type: 'string' },
        description: '称号代号,多值(逗号分隔或重复传):`little_giant` / `specialized_sme` / `innovative_sme`。',
      },
      {
        name: 'year',
        in: 'query',
        schema: { type: 'string' },
        description: '**首次认定年份**,多值。非数字项剔除(与总表的 `year` 不是同一个判据:这里筛的是首次认定年份)。',
      },
      {
        name: 'status',
        in: 'query',
        style: 'form',
        explode: false,
        schema: { type: 'array', items: { type: 'string', enum: ['confirmed', 'pending'] } },
        description: '首次认定状态,逗号分隔多值:`confirmed`(已确立) / `pending`(待确认);也接受重复参数。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
    ],
    responses: {
      200: { description: '首次认定清单(`rows` / `counts` / `page` / `pageSize`)。' },
      400: { description: '`title` / `status` 取值非法。' },
    },
  },
})

export default defineEventHandler((event) => {
  return listRosterRecognitions(useDb(), parseRosterRecognitionQuery(getQuery(event)))
})
