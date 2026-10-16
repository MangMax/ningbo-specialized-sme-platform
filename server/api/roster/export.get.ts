import ExcelJS from 'exceljs'
import { useDb } from '@db'
import { TITLES } from '~~/lib/labels'
import { allRosterEnterprises, type RosterEnterpriseRow } from '~~/lib/roster/enterprise-roster'
import { parseRosterEnterpriseQuery } from '../../utils/roster-read-query'

/**
 * **企业总表导出**(RL-04)。与 `GET /api/roster/enterprises` **同一套筛选解析、
 * 同一段读模型**(`allRosterEnterprises`)—— 「筛选和导出同一口径」是结构上成立的,
 * 不是靠两处对齐。
 *
 * ── 单位(第一行就写清)──────────────────────────────────────────────────
 * **一行 = 一家企业**(跨称号去重),不是企业 × 称号。所以导出**不被分页截断**
 * (页面只显示一页,导出的是当前筛选下的全部企业)。多称号企业在「称号」列里用
 * 「、」列出全部称号,不会拆成多行;`首行` 同时给出企业数与「企业 × 称号」数,
 * 免得把前者误读成后者。
 *
 * 读接口不鉴权。
 */
defineRouteMeta({
  openAPI: {
    tags: ['名录'],
    summary: '导出企业总表(Excel)',
    description:
      '与 `GET /api/roster/enterprises` 同筛选、同口径:一行 = 一家企业,**不受分页截断**;首行写明企业数与「企业 × 称号」数。',
    parameters: [
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '名称 / **已确认**曾用名关键词。' },
      { name: 'title', in: 'query', schema: { type: 'string' }, description: '称号代号,多值。' },
      { name: 'district', in: 'query', schema: { type: 'string' } },
      { name: 'rosterState', in: 'query', schema: { type: 'string', enum: ['current', 'removed_platform_only'] } },
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
      400: { description: '`title` / `rosterState` 取值非法。' },
    },
  },
})

const ROSTER_STATE_LABELS: Record<string, string> = {
  current: '当前总表',
  removed_platform_only: '仅平台引入(已从当前总表移除)',
}

/** 首次认定 / 下次复核这种派生量,**缺结论年份时把「待核」写在值旁边** —— 不猜。 */
function firstRecognitionText(row: RosterEnterpriseRow): string {
  return row.firstRecognition
    .map((f) => `${TITLES[f.titleCode] ?? f.titleCode} ${f.year}${f.needsReview ? '(待核)' : ''}`)
    .join('; ')
}

export default defineEventHandler(async (event) => {
  const { rows, counts } = allRosterEnterprises(useDb(), parseRosterEnterpriseQuery(getQuery(event)))

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('企业总表')
  ws.columns = [
    { header: '企业名称', key: 'name', width: 34 },
    { header: '统一社会信用代码', key: 'uscc', width: 20 },
    { header: '区县', key: 'district', width: 12 },
    { header: '城市', key: 'city', width: 10 },
    { header: '登记状态', key: 'regStatus', width: 14 },
    { header: '当前总表状态', key: 'rosterState', width: 26 },
    { header: '称号(一行一家企业,多称号用、分隔)', key: 'titles', width: 40 },
    { header: '曾用名(已确认)', key: 'aliases', width: 30 },
    { header: '首次认定', key: 'firstRecognition', width: 32 },
    { header: '下次复核', key: 'nextReview', width: 12 },
  ]

  for (const row of rows) {
    ws.addRow({
      name: row.name,
      uscc: row.uscc ?? '',
      district: row.district ?? '',
      city: row.city ?? '',
      regStatus: row.regStatus ?? '',
      rosterState: ROSTER_STATE_LABELS[row.rosterState] ?? row.rosterState,
      titles: row.titles.map((code) => TITLES[code] ?? code).join('、'),
      aliases: row.aliasNames.join('、'),
      firstRecognition: firstRecognitionText(row),
      nextReview:
        row.nextReviewYear == null ? '' : `${row.nextReviewYear}${row.anchorNeedsReview ? '(待核)' : ''}`,
    })
  }

  // 口径写在**数据上面**,离开页面也还看得见(导出的文件常被单独转发)。
  ws.spliceRows(1, 0, [
    `口径:一行 = 一家企业(跨称号去重)。本次筛选共 ${counts.total} 家企业,` +
      `合计 ${counts.titlePairs} 个「企业 × 称号」(多称号企业在「称号」列内以、分隔,不重复成多行)。` +
      `导出为当前筛选下的全部企业,不受页面分页限制。`,
  ])

  const buffer = await wb.xlsx.writeBuffer()
  setHeader(
    event,
    'content-type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  setHeader(
    event,
    'content-disposition',
    `attachment; filename="roster-enterprises.xlsx"; filename*=UTF-8''${encodeURIComponent(
      `企业总表-${counts.total}家.xlsx`,
    )}`,
  )
  return new Uint8Array(buffer as ArrayBuffer)
})
