import { requestLogContext } from '../../../../core/lib/logging'
import { admitEnterpriseResponse } from '../../utils/enterprise-read-response'
import { useDb } from '@db'
import {
  DIFF_STATUS_NONE,
  ROSTER_ENTERPRISE_SORTS,
  ROSTER_STATES,
} from '#sme-roster/lib/roster/enterprise-roster'
import { parseRosterEnterpriseQuery } from '../../utils/roster-read-query'
import { enterpriseReads } from '../../utils/enterprise-read'
import { withEnterpriseReadSignal } from '../../../../core/server/utils/enterprise-read-signal'
import { listPostgresRosterEnterprises } from '../../../lib/roster/enterprise-list-postgres'
import { usePostgresRosterDb } from '../../utils/postgres-roster-db'

/**
 * **跨称号去重的企业总表**(契约 §7.1,RL-04)。
 *
 * 一行 = **一家企业**(不是企业 × 称号):称号、批次、认定/复核事件与正式来源都在
 * 展开后的详情(`GET /api/roster/enterprises/:id`)里,一条不折叠。
 *
 * ── 计数口径(页面必须说清这一条)────────────────────────────────────────
 * `counts.total` 是**企业数**;`counts.titles[称号]` 是各称号下的**企业数**;
 * `counts.titlePairs` 是**企业 × 称号**数(`titles` 各桶之和)。多称号企业在
 * `total` 里只算一家,但在每个称号桶里各计一次。三者与**筛选同口径、先于分页**。
 *
 * ── `q` 的搜索口径(契约 §1.2/§5)────────────────────────────────────────
 * 命中**现名或任一已确认曾用名**即返回同一企业;`pending` 别名**不参与搜索**
 * (证据不足的别名不该把人引到一家还不确定的企业上)。
 *
 * 读接口不鉴权(与既有分法一致:读不鉴权,写/任务鉴权)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '跨称号去重企业总表',
    description:
      '`counts.total` 是符合筛选的企业数；`counts.titles[称号]` 是各称号下的企业数；`counts.titlePairs` 是这些企业的全部企业 × 称号数；`counts.recognitionPairs` 是命中首次认定筛选的企业 × 称号数；`counts.differences` 是这些企业合计的差异记录数。计数均先于分页。',
    parameters: [
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '名称 / **已确认**曾用名关键词。' },
      {
        name: 'title',
        in: 'query',
        schema: { type: 'string' },
        description: '称号代号,多值(逗号分隔或重复传):`little_giant` / `specialized_sme` / `innovative_sme`。',
      },
      { name: 'district', in: 'query', schema: { type: 'string' }, description: '属地(企业属地,为空时用记录属地)。' },
      {
        name: 'rosterState',
        in: 'query',
        schema: { type: 'string', enum: [...ROSTER_STATES] },
        description: '当前总表成员状态:派生、不落列(契约 §5)。',
      },
      {
        name: 'source',
        in: 'query',
        schema: { type: 'string' },
        description:
          '来源,多值:`jxj` / `miit`。命中「该企业存在一条该来源的记录」(RL-17)。',
      },
      {
        name: 'eventType',
        in: 'query',
        schema: { type: 'string' },
        description:
          '事件类型,多值:`award` / `review` / `maintain` / `nurture`。与 `year` 一起给时,必须落在**同一条事件**上(与 `/api/records` 同口径)。',
      },
      {
        name: 'year',
        in: 'query',
        schema: { type: 'string' },
        description: '事件年份,多值。非数字项剔除。',
      },
      {
        name: 'diffStatus',
        in: 'query',
        schema: { type: 'string' },
        description: `差异状态,多值(RL-20):六个差异状态、伪状态 \`${DIFF_STATUS_NONE}\`(**一条差异记录都没有**)及已展示原因代码。状态匹配企业任一差异记录,原因匹配企业当前摘要原因；同参数多值取或。`,
      },
      {
        name: 'sort',
        in: 'query',
        schema: { type: 'string', enum: [...ROSTER_ENTERPRISE_SORTS], default: 'recognition' },
        description: '排序(RL-20):按最早首次认定年新到旧(默认)、企业名称或称号等级；名称和 id 保证稳定顺序。',
      },
      {
        name: 'firstYear',
        in: 'query',
        style: 'form',
        explode: false,
        schema: { type: 'array', items: { type: 'integer' } },
        description:
          '首次正式认定年份,逗号分隔多值；也接受重复参数。按同一企业 × 称号的最早 `award`，年份使用 `decidedYear ?? year`。非数字项剔除。',
      },
      {
        name: 'firstStatus',
        in: 'query',
        style: 'form',
        explode: false,
        schema: { type: 'array', items: { type: 'string', enum: ['confirmed', 'pending'] } },
        description:
          '首次认定状态,逗号分隔多值：`confirmed`(已确立) / `pending`(现有 award 缺有效年份或首次出处待确认)；也接受重复参数。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
    ],
    responses: {
      200: { description: '企业总表(`rows` / `counts` / `page` / `pageSize`)。' },
      503: { description: '企业读取队列或响应并发已满，或执行器暂时不可用；可重试，不表示无记录。' },
      400: { description: '`title` / `rosterState` / `source` / `eventType` / `firstStatus` / `diffStatus` / `sort` 取值非法。' },
    },
  },
})

export default defineEventHandler((event) => {
  const filter = parseRosterEnterpriseQuery(getQuery(event))
  admitEnterpriseResponse(event)
  const pg = usePostgresRosterDb()
  if (pg) return listPostgresRosterEnterprises(pg, filter)
  return withEnterpriseReadSignal(event, async signal => {
    const result = await enterpriseReads.json(useDb().$client.name, { operation: 'list',filter }, signal, requestLogContext(event))
    setHeader(event, 'content-type', 'application/json; charset=utf-8')
    return result.body
  })
})
