import { useDb } from '@db'
import { getRosterEnterpriseDetail } from '~~/lib/roster/enterprise-roster'

/**
 * **企业详情**(契约 §7.2,RL-04):一家企业的全部称号历史与证据。
 *
 * 六段:
 *  - `enterprise` —— §7.1 的那一行(现名/统代/属地/`rosterState`/称号/曾用名/首次认定/下次复核);
 *  - `aliases` —— 曾用名逐条(`pending` 也在,只是不参与搜索);
 *  - `records` —— 企业 × 称号 × 来源,每条带该称号的生命周期(契约 §6 的算法);
 *  - `events` —— 认定/复核/维护/培育,含**复核结论**与**结论年份**;
 *  - `evidence` —— 出处(文件/附件/序号/**页码**,RL-10 的跳转依据);
 *  - `differences` —— 每项的**当前**解释(旧解释不丢,只是不在这里);
 *  - `platform` —— 平台查询与**全部**关系(一个统代的多条关联一条不折叠)。
 *
 * 读接口不鉴权。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '企业详情(跨称号)',
    description:
      '含 aliases / records / events / evidence / differences / platform。`platform.relations` 保留该企业的**全部**平台关联(不按统代折叠)。',
    responses: {
      200: { description: '企业详情。' },
      400: { description: 'id 不是数字。' },
      404: { description: '没有这个企业。' },
    },
  },
})

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  const detail = getRosterEnterpriseDetail(useDb(), id)
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'not found' })
  return detail
})
