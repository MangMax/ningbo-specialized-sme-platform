import { useDb } from '@db'
import { REVIEW_STATUS_ORDER } from '~~/lib/labels'
import { listRosterReviews } from '~~/lib/roster/review-list'
import { parseRosterReviewQuery } from '../../utils/roster-read-query'

/**
 * **下一年度复核清单**(契约 §7.4,RL-09)。只读、不鉴权(与既有分法一致)。
 *
 * 一行 = 一个 **企业 × 称号** 的目标年份复核事项。两种分层:
 *
 *  - `status=due`(默认,到期清单):锚点事件 / 批次 / 出处**证据齐全**,可以直接当工作单;
 *  - `status=pending`(待确认清单):有资格声称但**到期年不可信或算不出**,
 *    行上给出**可判别的原因**(`reasons`)与暂定年份(`tentativeDueYear`),交人补证据。
 *
 * ── 清单凭什么把这家列进来(行上的字段逐条对上)──────────────────────────
 * `anchorYear` 是锚点年份,`basisEventId` 指向**那条**锚点事件(认定,或复核通过),
 * 行上同时带出该事件的**批次**(`batchSeq`)、**来源**(`source`)与
 * **出处**(`evidence`:文件 / 附件 / 序号 / 页)⇒ 能回到出处,不是只给一个名单。
 * `firstYear` / `firstEventId` 是首次认定 —— 它**不因复核通过或再次获批而改变**(契约 §6)。
 *
 * ── 到期年怎么算(契约 §6.3–6.5)────────────────────────────────────────
 * 锚点 = 最近一次「授予或延续有效资格」的事件(`max(decided_year ?? year)`,对认定事件与
 * `reviewOutcome='passed'` 的复核取最大);**到期 = 锚点 + 3**。
 * 复核未通过的**终止**当前有效资格 ⇒ 两条清单都不进;复核通过**刷新锚点**;
 * 再次获批刷新锚点但**不重置**首次认定。
 *
 * ── `year` 是**到期年**,不是事件年 ─────────────────────────────────────
 * 2021 认定的那批只在 **2024**(= 2021 + 3)的清单里出现,2025 的清单里没有它。
 * `year` **必填**;缺或不是四位公历年给 400(不静默退回某一年)。
 *
 * ── 待确认清单**不带目标年份筛选**(RL-09 的取舍,已在 PR 里标为待裁决)────────
 * 「到期年算不出来」的行不属于任何一年,若按目标年份筛,它们在任何一年都不会出现
 * ⇒ 静默消失,而那正是本票要防的事。所以待确认清单是**该称号下的确认队列**,
 * 与目标年份无关;每行仍带 `tentativeDueYear` 供人判断它将来落到哪一年。
 * `counts.due` 与 `counts.pending` 都**先于分页**、与 `title` 筛选同口径,但**互斥而不穷尽** ——
 * 「证据齐全、到期年在别处」的那些对在这一年里两边都不出现(实测 2027:3087 + 3038 = 6125,
 * 而有资格声称的是 9961)。`counts` 不是全集,是**这一年这份清单**的口径。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '下一年度复核清单',
    description:
      '一行 = 一个企业 × 称号的到期复核事项;`anchorYear` 是锚点、`basisEventId` 是锚点事件,行上带批次 / 来源 / 出处。' +
      '`status=due` 为证据齐全的到期清单,`status=pending` 为待确认清单(带可判别原因与暂定年份,且不按目标年份筛)。',
    parameters: [
      {
        name: 'year',
        in: 'query',
        required: true,
        schema: { type: 'integer', minimum: 1900, maximum: 2999 },
        description: '**目标到期年份**(不是事件年份):列出锚点 + 3 等于该年的企业 × 称号。',
      },
      {
        name: 'title',
        in: 'query',
        schema: { type: 'string' },
        description: '称号代号,多值(逗号分隔或重复传):`little_giant` / `specialized_sme` / `innovative_sme`。',
      },
      {
        name: 'status',
        in: 'query',
        schema: { type: 'string', enum: [...REVIEW_STATUS_ORDER], default: 'due' },
        description: '分层:`due` 到期清单(默认)/ `pending` 待确认清单。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
    ],
    responses: {
      200: {
        description:
          '`rows`(status=due 时有内容)/ `pending`(status=pending 时有内容)/ `counts` / `page` / `pageSize`。',
      },
      400: { description: '`year` 缺失或不是四位公历年;`title` / `status` 取值非法。' },
    },
  },
})

export default defineEventHandler((event) => {
  return listRosterReviews(useDb(), parseRosterReviewQuery(getQuery(event)))
})
