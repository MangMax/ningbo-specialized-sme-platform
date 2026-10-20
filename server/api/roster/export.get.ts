import { useDb } from '@db'
import { streamXlsx } from '../../utils/stream-xlsx'
import { FIRST_RECOGNITION_REASONS, TITLES } from '~~/lib/labels'
import { allRosterEnterprises, type RosterEnterpriseRow } from '~~/lib/roster/enterprise-roster'
import { evidencePointerText, firstRecognitionYearText } from '~~/lib/roster/first-recognition'
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
        style: 'form',
        explode: false,
        schema: { type: 'array', items: { type: 'integer' } },
        description: '**首次认定年份**,逗号分隔多值；也接受重复参数(与 `year` 不是同一个判据)。',
      },
      {
        name: 'firstStatus',
        in: 'query',
        style: 'form',
        explode: false,
        schema: { type: 'array', items: { type: 'string', enum: ['confirmed', 'pending'] } },
        description: '首次认定状态,逗号分隔多值:`confirmed` / `pending`;也接受重复参数。',
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
      400: { description: '`title` / `rosterState` / `source` / `eventType` / `firstStatus` 取值非法。' },
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
 * (年份给不出 / 现存 award 缺有效年份 / 没有出处)。两个标记各自跟着自己的值走,
 * 不合成一个 —— 导出件常被单独转发,读的人得能分清是哪件事待办。
 */
function firstRecognitionText(row: RosterEnterpriseRow): string {
  return row.firstRecognition
    .map((f) => {
      const year = firstRecognitionYearText({ firstYear: f.year })
      const pending = f.status === 'pending' ? `(待确认:${FIRST_RECOGNITION_REASONS[f.pendingReason ?? ''] ?? f.pendingReason})` : ''
      return `${TITLES[f.titleCode] ?? f.titleCode} ${year}${f.needsReview ? '(待核)' : ''}${pending}`
    })
    .join('; ')
}

/**
 * **首次认定出处** —— 每个首次认定指回它自己那条认定事件的原始出处(RL-08)。
 *
 * 票面要求「显示称号、年份和来源证据」,而证据指的就是这里:哪个文件、哪个附件、哪个序号。
 * 指不回去的**不编** —— 写「待确认:原因」,让人知道要补什么。
 * 出处的写法取自 `first-recognition.ts` 的单一出处(台账表与展开面板用同一个函数)。
 */
function firstRecognitionEvidenceText(row: RosterEnterpriseRow): string {
  return row.firstRecognition
    .map((f) => {
      const title = TITLES[f.titleCode] ?? f.titleCode
      if (!f.evidence.length) {
        const why = FIRST_RECOGNITION_REASONS[f.pendingReason ?? ''] ?? f.pendingReason
        return `${title} —（待确认:${why ?? '没有存下来的出处'}）`
      }
      return `${title} — ${f.evidence.map(evidencePointerText).join(' ; ')}`
    })
    .join('\n')
}

export default defineEventHandler(async (event) => {
  const { rows, counts } = allRosterEnterprises(useDb(), parseRosterEnterpriseQuery(getQuery(event)))

  const columns = [
    { header: '企业名称', width: 34 }, { header: '统一社会信用代码', width: 20 },
    { header: '区县', width: 12 }, { header: '城市', width: 10 },
    { header: '登记状态', width: 14 }, { header: '当前总表状态', width: 26 },
    { header: '称号(一行一家企业,多称号用、分隔)', width: 40 },
    { header: '曾用名(已确认)', width: 30 },
    { header: '首次认定', width: 42, wrap: true },
    { header: '首次认定出处', width: 60, wrap: true },
    { header: '下次复核', width: 12 },
  ]
  return streamXlsx(event, `企业总表-${counts.total}家.xlsx`, '企业总表', columns, (function* () {
    yield [
      `口径:一行 = 一家企业(跨称号去重)。本次筛选共 ${counts.total} 家企业,` +
        `合计 ${counts.titlePairs} 个「企业 × 称号」(多称号企业在「称号」列内以、分隔,不重复成多行);` +
        `其中 ${counts.recognitionPairs} 个「企业 × 称号」有首次认定。` +
        `首次认定按**企业 × 称号**算最早那次认定:复核通过不是新的首次认定,复核失败后再次获批也不重置。` +
        `标「待确认」的以「首次认定出处」列为准(认定事件定不了年 / 存在更早但定不了年的认定 / 没有存下来的出处)。` +
        `导出为当前筛选下的全部企业,不受页面分页限制。`,
    ]
    yield columns.map(column => column.header)
    for (const row of rows) {
      yield [
        row.name, row.uscc ?? '', row.district ?? '', row.city ?? '',
        row.regStatus ?? '', ROSTER_STATE_LABELS[row.rosterState] ?? row.rosterState,
        row.titles.map((code) => TITLES[code] ?? code).join('、'),
        row.aliasNames.join('、'), firstRecognitionText(row), firstRecognitionEvidenceText(row),
        row.nextReviewYear == null ? '' : `${row.nextReviewYear}${row.anchorNeedsReview ? '(待核)' : ''}`,
      ]
    }
  })())
})
