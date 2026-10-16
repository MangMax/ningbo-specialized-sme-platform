import ExcelJS from 'exceljs'
import { useDb } from '@db'
import { FIRST_RECOGNITION_REASONS, TITLES } from '~~/lib/labels'
import { allRosterEnterprises, type RosterEnterpriseRow } from '~~/lib/roster/enterprise-roster'
import type { FirstRecognitionEvidence } from '~~/lib/roster/first-recognition'
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
      { name: 'source', in: 'query', schema: { type: 'string' }, description: '来源,多值(与列表同口径)。' },
      {
        name: 'eventType',
        in: 'query',
        schema: { type: 'string' },
        description: '事件类型,多值;与 `year` 一起给时须落在同一条事件上。',
      },
      { name: 'year', in: 'query', schema: { type: 'string' }, description: '事件年份,多值。' },
      {
        name: 'firstYear',
        in: 'query',
        schema: { type: 'string' },
        description: '**首次认定年份**,多值(与 `year` 不是同一个判据)。',
      },
      {
        name: 'firstStatus',
        in: 'query',
        schema: { type: 'string' },
        description: '首次认定状态,多值:`confirmed` / `pending`。',
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
      400: { description: '`title` / `rosterState` / `source` / `eventType` 取值非法。' },
    },
  },
})

const ROSTER_STATE_LABELS: Record<string, string> = {
  current: '当前总表',
  removed_platform_only: '仅平台引入(已从当前总表移除)',
}

/**
 * 首次认定 / 下次复核这种派生量,**值旁边写清它到底是什么** —— 不猜、不含糊。
 *
 * `(待核)` 是**锚点**口径(缺 `decided_year`),`(待确认)` 是**首次认定本身**的口径
 * (年份给不出 / 有更早的认定定不了年 / 没有出处)。两个标记各自跟着自己的值走,
 * 不合成一个 —— 导出件常被单独转发,读的人得能分清是哪件事待办。
 */
function firstRecognitionText(row: RosterEnterpriseRow): string {
  return row.firstRecognition
    .map((f) => {
      const year = f.year == null ? '年份未知' : String(f.year)
      const pending = f.status === 'pending' ? `(待确认:${FIRST_RECOGNITION_REASONS[f.pendingReason ?? ''] ?? f.pendingReason})` : ''
      return `${TITLES[f.titleCode] ?? f.titleCode} ${year}${f.needsReview ? '(待核)' : ''}${pending}`
    })
    .join('; ')
}

/** 一处出处的写法:文件 → 附件 → 序号 → 页(缺哪样就不写哪样,不填占位符)。 */
function evidenceText(v: FirstRecognitionEvidence): string {
  const parts = [v.sourceFile]
  if (v.attachment) parts.push(v.attachment)
  if (v.listNo != null) parts.push(`序号 ${v.listNo}`)
  if (v.page != null) parts.push(`第 ${v.page} 页`)
  return parts.join(' · ')
}

/**
 * **首次认定出处** —— 每个首次认定指回它自己那条认定事件的原始出处(RL-08)。
 *
 * 票面要求「显示称号、年份和来源证据」,而证据指的就是这里:哪个文件、哪个附件、哪个序号。
 * 指不回去的**不编** —— 写「待确认:原因」,让人知道要补什么。
 */
function firstRecognitionEvidenceText(row: RosterEnterpriseRow): string {
  return row.firstRecognition
    .map((f) => {
      const title = TITLES[f.titleCode] ?? f.titleCode
      if (!f.evidence.length) {
        const why = FIRST_RECOGNITION_REASONS[f.pendingReason ?? ''] ?? f.pendingReason
        return `${title} —（待确认:${why ?? '没有存下来的出处'}）`
      }
      return `${title} — ${f.evidence.map(evidenceText).join(' ; ')}`
    })
    .join('\n')
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
    { header: '首次认定', key: 'firstRecognition', width: 42 },
    { header: '首次认定出处', key: 'firstRecognitionEvidence', width: 60 },
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
      firstRecognitionEvidence: firstRecognitionEvidenceText(row),
      nextReview:
        row.nextReviewYear == null ? '' : `${row.nextReviewYear}${row.anchorNeedsReview ? '(待核)' : ''}`,
    })
  }

  // 长文本(出处是「文件 · 附件 · 序号 · 页」串起来的)换行显示,不撑成一整行看不见头。
  for (const key of ['firstRecognition', 'firstRecognitionEvidence']) {
    ws.getColumn(key).alignment = { wrapText: true, vertical: 'top' }
  }

  // 口径写在**数据上面**,离开页面也还看得见(导出的文件常被单独转发)。
  ws.spliceRows(1, 0, [
    `口径:一行 = 一家企业(跨称号去重)。本次筛选共 ${counts.total} 家企业,` +
      `合计 ${counts.titlePairs} 个「企业 × 称号」(多称号企业在「称号」列内以、分隔,不重复成多行);` +
      `其中 ${counts.recognitionPairs} 个「企业 × 称号」有首次认定。` +
      `首次认定按**企业 × 称号**算最早那次认定:复核通过不是新的首次认定,复核失败后再次获批也不重置。` +
      `标「待确认」的以「首次认定出处」列为准(认定事件定不了年 / 存在更早但定不了年的认定 / 没有存下来的出处)。` +
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
