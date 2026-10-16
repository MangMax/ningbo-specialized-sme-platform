import { useDb } from '@db'
import { listRecords } from '~~/lib/query'
import { parseRecordQuery } from '../utils/roster-read-query'

/**
 * 通用台账查询(一行 = 企业 × 称号；行内保留全部来源、事件与出处)。
 *
 * query 参数**手写** —— Nitro 的 spec 生成只自动推断**路径参数**,query / header
 * 没有运行时 schema 可推(见票 19)。这里写的形状与下面 `listRecords` 的入参一一对应。
 */
defineRouteMeta({
  openAPI: {
    tags: ['台账'],
    summary: '查台账记录',
    description:
      '一行 = 企业 × 称号，包含该组合全部来源、历史事件、事件出处与生命周期。多值参数可用逗号或重复参数。`year` 过滤事件年份；`firstYear` 过滤最早正式认定年份；`firstStatus` 过滤首次认定状态；`dueYear` 过滤生命周期到期年份。',
    parameters: [
      {
        name: 'title',
        in: 'query',
        schema: { type: 'string' },
        description: '称号代号,多值:`little_giant` / `specialized_sme` / `innovative_sme`。',
      },
      { name: 'source', in: 'query', schema: { type: 'string' }, description: '来源:`jxj` / `miit`。' },
      { name: 'district', in: 'query', schema: { type: 'string' }, description: '区县(精确)。' },
      {
        name: 'eventType',
        in: 'query',
        schema: { type: 'string' },
        description: '事件类型:`award`(认定)/ `review`(复核)/ `maintain`(维护)/ `nurture`(入库培育)。',
      },
      { name: 'year', in: 'query', schema: { type: 'string' }, description: '事件所涉年份,多值；不是到期年份。' },
      {
        name: 'firstYear',
        in: 'query',
        schema: { type: 'string' },
        description: '该企业 × 称号的最早正式认定年份,多值；按 `decidedYear ?? year` 计算，与事件年份 `year` 不同。',
      },
      {
        name: 'firstStatus',
        in: 'query',
        style: 'form',
        explode: false,
        schema: { type: 'array', items: { type: 'string', enum: ['confirmed', 'pending'] } },
        description:
          '首次认定状态,逗号分隔多值：`confirmed` / `pending`；也接受重复参数。判据与首次认定读模型一致。',
      },
      {
        name: 'dueYear',
        in: 'query',
        schema: { type: 'integer', minimum: 1900, maximum: 2999 },
        description: '生命周期到期年份，单值精确匹配；使用共享称号生命周期规则计算。',
      },
      {
        name: 'q',
        in: 'query',
        schema: { type: 'string' },
        description: '企业现名、已确认曾用名或统一社会信用代码关键词。',
      },
      { name: 'flags', in: 'query', schema: { type: 'string' }, description: '质量标记(如 `uscc_missing`)。' },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 25 } },
    ],
    responses: {
      200: {
        description:
          '分页的企业×称号记录。每个事件含事件年份、结论年份、复核结论、来源、批次序号与来源文件/附件/名单序号/页码；lifecycle 含首次认定、锚点、到期年、状态与待核原因。派生筛选在分页前执行，返回行仍保留全部事件与出处。',
      },
      400: { description: '不支持的称号/来源/事件类型/首次认定状态，或 dueYear 不是单个四位年份。' },
    },
  },
})

export default defineEventHandler((event) => {
  return listRecords(useDb(), parseRecordQuery(getQuery(event)))
})
