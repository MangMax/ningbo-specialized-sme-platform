import ExcelJS from 'exceljs'
import { useDb } from '@db'
import { REVIEW_PENDING_REASONS, SOURCES, TITLES } from '~~/lib/labels'
import { allRosterReviews, type ReviewPendingRow, type ReviewRow } from '~~/lib/roster/review-list'
import {
  parseRosterReviewQuery,
  strParam,
} from '../../../utils/roster-read-query'

/**
 * **复核清单导出**(RL-09)。与 `GET /api/roster/reviews` **同一套参数解析、
 * 同一段读模型**(`allRosterReviews`)——「导出与页面筛选结果一致」是结构上成立的,
 * 不是靠两处对齐。
 *
 * 两个工作表,**与页面上的两个清单一一对应**:
 *  - `到期清单`   —— 证据齐全、可以直接当工作单的行;
 *  - `待确认清单` —— 有资格声称但到期年不可信或算不出的行(**带可判别的原因**与暂定年份)。
 *
 * 两张表都**不受分页截断**:导出的是当前筛选下的全部。
 *
 * 读接口不鉴权。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '导出复核清单(Excel)',
    description:
      '与 `GET /api/roster/reviews` 同参数、同口径:两个工作表分别对应到期清单与待确认清单,**不受分页截断**。',
    parameters: [
      { name: 'year', in: 'query', required: true, schema: { type: 'integer' }, description: '目标到期年份。' },
      { name: 'title', in: 'query', schema: { type: 'string' }, description: '称号代号,多值。' },
      {
        name: 'status',
        in: 'query',
        schema: { type: 'string', enum: ['due', 'pending'] },
        description: '只导该分层;不给则两个工作表都写。',
      },
    ],
    responses: {
      200: {
        description: 'xlsx 文件字节(不是 JSON)。',
        content: {
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
            schema: { type: 'string', format: 'binary' },
          },
        },
      },
      400: { description: '`year` 缺失或不是四位公历年;`title` / `status` 取值非法。' },
    },
  },
})

/** 锚点事件的出处汇总为一行文本(文件 / 附件 / 序号 / 页,逐条用分号隔开)。 */
function evidenceText(row: ReviewRow | ReviewPendingRow): string {
  return row.evidence
    .map((v) => {
      const parts = [v.sourceFile]
      if (v.attachment) parts.push(v.attachment)
      if (v.listNo != null) parts.push(`序号${v.listNo}`)
      if (v.page != null) parts.push(`第${v.page}页`)
      return parts.join(' / ')
    })
    .join('; ')
}

const TITLE_TEXT = (code: string) => TITLES[code] ?? code
const SOURCE_TEXT = (code: string | null) => (code ? (SOURCES[code] ?? code) : '')
const EVENT_TEXT: Record<string, string> = { award: '认定', review: '复核' }

export default defineEventHandler(async (event) => {
  const query = parseRosterReviewQuery(getQuery(event))
  const { due, pending, counts } = allRosterReviews(useDb(), query)
  // `status` 只用来「只导这一个分层」,不改变口径:两张表的内容与页面上两个清单逐行相同。
  const only = strParam(getQuery(event).status)

  const wb = new ExcelJS.Workbook()

  if (only !== 'pending') {
    const ws = wb.addWorksheet('到期清单')
    ws.columns = [
      { header: '企业名称', key: 'name', width: 34 },
      { header: '统一社会信用代码', key: 'uscc', width: 20 },
      { header: '区县', key: 'district', width: 12 },
      { header: '称号', key: 'title', width: 22 },
      { header: '到期年份', key: 'dueYear', width: 10 },
      { header: '锚点年份', key: 'anchorYear', width: 10 },
      { header: '锚点事件', key: 'basis', width: 26 },
      { header: '首次认定', key: 'first', width: 14 },
      { header: '批次', key: 'batch', width: 10 },
      { header: '来源', key: 'source', width: 10 },
      { header: '出处', key: 'evidence', width: 60 },
    ]
    for (const row of due) {
      ws.addRow({
        name: row.name,
        uscc: row.uscc ?? '',
        district: row.district ?? '',
        title: TITLE_TEXT(row.titleCode),
        dueYear: row.dueYear,
        anchorYear: row.anchorYear,
        // 锚点事件写清「哪一次、哪一年」:复核通过刷新锚点,所以事件类型必须带上。
        basis: `${EVENT_TEXT[row.basisEventType ?? ''] ?? row.basisEventType ?? ''} 事件 #${row.basisEventId ?? ''}`,
        first: row.firstYear ?? '',
        batch: row.batchSeq ?? '—',
        source: SOURCE_TEXT(row.source),
        evidence: evidenceText(row),
      })
    }
    ws.spliceRows(1, 0, [
      `口径:一行 = 一个 企业 × 称号,列出 ${query.year} 年到期的复核事项(到期 = 锚点 + 3)。` +
        `共 ${counts.due} 项,另有待确认 ${counts.pending} 项见另一工作表。` +
        `锚点 = 最近一次授予或延续有效资格的事件(认定,或复核通过);复核未通过的资格已终止,不列入。` +
        `首次认定为最早一次认定,复核通过或再次获批都不重置它。导出为当前筛选下的全部,不受分页限制。`,
    ])
  }

  if (only !== 'due') {
    const ws = wb.addWorksheet('待确认清单')
    ws.columns = [
      { header: '企业名称', key: 'name', width: 34 },
      { header: '统一社会信用代码', key: 'uscc', width: 20 },
      { header: '区县', key: 'district', width: 12 },
      { header: '称号', key: 'title', width: 22 },
      { header: '待确认原因', key: 'reasons', width: 46 },
      { header: '锚点年份', key: 'anchorYear', width: 10 },
      { header: '暂定到期年份(未经确认)', key: 'tentative', width: 22 },
      { header: '锚点事件', key: 'basis', width: 26 },
      { header: '首次认定', key: 'first', width: 14 },
      { header: '批次', key: 'batch', width: 10 },
      { header: '来源', key: 'source', width: 10 },
      { header: '出处', key: 'evidence', width: 60 },
    ]
    for (const row of pending) {
      ws.addRow({
        name: row.name,
        uscc: row.uscc ?? '',
        district: row.district ?? '',
        title: TITLE_TEXT(row.titleCode),
        reasons: row.reasons.map((r) => REVIEW_PENDING_REASONS[r] ?? r).join('; '),
        anchorYear: row.anchorYear ?? '',
        tentative: row.tentativeDueYear ?? '',
        basis: `${EVENT_TEXT[row.basisEventType ?? ''] ?? row.basisEventType ?? ''} 事件 #${row.basisEventId ?? ''}`,
        first: row.firstYear ?? '',
        batch: row.batchSeq ?? '—',
        source: SOURCE_TEXT(row.source),
        evidence: evidenceText(row),
      })
    }
    ws.spliceRows(1, 0, [
      `口径:一行 = 一个 企业 × 称号,**有资格声称**(该称号下至少有一条认定或复核事件)` +
        `但**到期年不足以采信**的事项,共 ${counts.pending} 项。` +
        `这些行**不按目标年份筛** —— 「到期年算不出来」的行不属于任何一年,按年筛会让它们在任何一年都看不见。` +
        `「暂定到期年份」只是锚点 + 3 的推算值,**未经确认**,不得直接当工作单用。` +
        `补齐证据(公布文件的批次与出处、或平台申报记录的复核结论)后,该行才会进入到期清单。`,
    ])
  }

  const buffer = await wb.xlsx.writeBuffer()
  setHeader(
    event,
    'content-type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  setHeader(
    event,
    'content-disposition',
    `attachment; filename="roster-reviews.xlsx"; filename*=UTF-8''${encodeURIComponent(
      `复核清单-${query.year}年.xlsx`,
    )}`,
  )
  return new Uint8Array(buffer as ArrayBuffer)
})
