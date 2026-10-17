import { useDb } from '@db'
import { DIFF_STATUS_NONE, ROSTER_ENTERPRISE_SORTS, ROSTER_STATES, listRosterEnterprises } from '~~/lib/roster/enterprise-roster'
import { parseRosterEnterpriseQuery } from '../../utils/roster-read-query'

/**
 * **跨称号去重的企业总表**(契约 §7.1,RL-04)。
 *
 * 一行 = **一家企业**(不是企业 × 称号):称号、批次、认定/复核事件与正式来源都在
 * 展开后的详情(`GET /api/roster/enterprises/:id`)里,一条不折叠。
 *
 * ── 计数口径(页面必须说清这一条)────────────────────────────────────────
 * `counts.total` 是**企业数**;`counts.titles[称号]` 是各称号下的**企业数**;
 * `counts.titlePairs` 是**企业 × 称号**数(`titles` 各桶之和);`counts.differences`
 * 是本筛选下这些企业合计的**差异记录条数**(RL-20,与 `/api/roster/differences` 同一处口径)。
 * 多称号企业在 `total` 里只算一家,但在每个称号桶里各计一次。四者与**筛选同口径、先于分页**。
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
      '一行 = 一家企业(跨称号去重);`counts.total` 是企业数,`counts.titles` 是各称号的企业数,`counts.titlePairs` 是企业 × 称号数,`counts.differences` 是差异记录条数。',
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
        description: `差异状态,多值(RL-20):\`not_queried\` / \`query_failed\` / \`no_record\` / \`needs_review\` / \`confirmed_no_diff\` / \`confirmed_reason\`,或伪状态 \`${DIFF_STATUS_NONE}\`(**一条差异记录都没有**)。也可选择原因代码 moved_out / deregistered / renamed / platform_stale / moved_in / other，按表格当前可见摘要原因匹配。状态仍命中企业任一差异记录；同参数多值取或。`,
      },
      {
        name: 'sort',
        in: 'query',
        schema: { type: 'string', enum: [...ROSTER_ENTERPRISE_SORTS], default: 'recognition' },
        description:
          '排序(RL-20):`recognition`(该企业最早的首次认定年,新→旧,默认)/ `name` / `title`(称号等级)。三者都以名称与 id 收尾定序。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
    ],
    responses: {
      200: { description: '企业总表(`rows` / `counts` / `page` / `pageSize`)。' },
      400: { description: '`title` / `rosterState` / `source` / `eventType` / `diffStatus` / `sort` 取值非法。' },
    },
  },
})

export default defineEventHandler((event) => {
  return listRosterEnterprises(useDb(), parseRosterEnterpriseQuery(getQuery(event)))
})
