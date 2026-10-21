import { legacyExportSheet, writeLegacyXlsx } from '../utils/legacy-export-xlsx'
import { useDb } from '@db'
import { allRecords, type EventType } from '~~/lib/query'
import {
  TITLES,
  SOURCES,
  TITLE_ORDER,
  COMPARISON_LABELS,
  COMPARISON_NO_USCC,
} from '~~/lib/labels'
import { attachPlatformEvidence } from '~~/lib/comparison-platform'
import { getCuratedComparison } from '~~/lib/curation'
import { filterComparisonRows } from '~~/lib/comparison-filter'
import {
  COMPARISON_DIRECTIONS,
  type ComparisonDirection,
} from '~~/lib/comparison'

const EVENT_TYPES: EventType[] = ['award', 'review', 'maintain', 'nurture']

/**
 * 导出 Excel(xlsx 二进制)。
 *
 * 两种模式:**默认**导出记录(与 `/api/records` 同一套筛选),`mode=comparison`
 * 导出比对结果(那时 `title` 与 `direction` 必给)。
 *
 * 成功时 `content-type` 是 xlsx、响应体是字节,**不是 JSON** —— spec 里如实写出来,
 * 免得代理按 JSON 去解析。
 */
defineRouteMeta({
  openAPI: {
    tags: ['台账'],
    summary: '导出 Excel',
    responses: {
      200: {
        description: 'xlsx 文件字节(不是 JSON)。',
        content: {
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
            schema: { type: 'string', format: 'binary' },
          },
        },
      },
      400: { description: '`mode=comparison` 时缺 title / direction 或它们的取值非法。' },
    },
    parameters: [
      {
        name: 'mode',
        in: 'query',
        schema: { type: 'string', enum: ['comparison'] },
        description: '不传 = 导出记录;`comparison` = 导出比对结果。',
      },
      { name: 'title', in: 'query', schema: { type: 'string' }, description: '称号代号(comparison 模式必给)。' },
      {
        name: 'direction',
        in: 'query',
        schema: { type: 'string' },
        description: '比对方向(comparison 模式必给)。',
      },
      { name: 'source', in: 'query', schema: { type: 'string' }, description: '来源,多值。' },
      { name: 'district', in: 'query', schema: { type: 'string' } },
      { name: 'eventType', in: 'query', schema: { type: 'string' }, description: '事件类型,多值。' },
      { name: 'year', in: 'query', schema: { type: 'string' }, description: '事件年份,多值。' },
      { name: 'q', in: 'query', schema: { type: 'string' } },
      { name: 'flags', in: 'query', schema: { type: 'string' } },
    ],
  },
})

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

  /** 与 `/api/records` 一致的多值解析:逗号分隔或重复参数。 */
  const csv = (v: unknown): string[] | undefined => {
    if (v == null) return undefined
    const raw = Array.isArray(v)
      ? v.flatMap((x) => String(x).split(','))
      : String(v).split(',')
    const list = raw.map((s) => s.trim()).filter(Boolean)
    return list.length ? list : undefined
  }
  const csvEventTypes = (v: unknown): EventType[] | undefined => {
    const list = csv(v)?.filter((x): x is EventType =>
      EVENT_TYPES.includes(x as EventType),
    )
    return list?.length ? list : undefined
  }
  const csvYears = (v: unknown): number[] | undefined => {
    const list = csv(v)
      ?.map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0)
    return list?.length ? list : undefined
  }

  let filename = 'roster.xlsx'
  let writeWorkbook: Parameters<typeof writeLegacyXlsx>[1]
  if (q.mode === 'comparison') {
    const title = str(q.title)
    const direction = str(q.direction) as ComparisonDirection | undefined
    if (
      !title ||
      !TITLE_ORDER.includes(title) ||
      !direction ||
      !COMPARISON_DIRECTIONS.includes(direction)
    ) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Comparison export requires a valid title and direction',
      })
    }
    if (q.showCurated != null && !['true', 'false', ''].includes(String(q.showCurated))) {
      throw createError({ statusCode: 400, statusMessage: 'showCurated must be true or false' })
    }
    const db = useDb()
    const config = useRuntimeConfig(event)
    const comparison = getCuratedComparison(db, config.curatedPath)
    const enriched = attachPlatformEvidence(comparison.rows, db)
    const rows = filterComparisonRows(enriched, {
      title: [title],
      direction,
      q: str(q.q),
      district: str(q.district),
      showCurated: str(q.showCurated) === 'true',
    })
    writeWorkbook = async (wb, pace) => {
      const ws = legacyExportSheet(wb, pace, '比对', [
        { header: '企业名称', key: 'name', width: 34 },
        { header: '统一社会信用代码', key: 'uscc', width: 20 },
        { header: '区县', key: 'district', width: 12 },
        { header: '称号', key: 'title', width: 24 },
        { header: '方向', key: 'direction', width: 14 },
        { header: '当前城市', key: 'city', width: 12 },
        { header: '登记状态', key: 'regStatus', width: 24 },
        { header: '备注', key: 'notes', width: 34 },
      ])
      for (const row of rows) {
        await ws.addRow({
          name: row.name,
          uscc: row.uscc ?? '',
          district: row.district ?? '',
          title: TITLES[row.titleCode],
          direction: COMPARISON_LABELS[row.direction],
          city: row.evidence.currentCity ?? '',
          regStatus: row.evidence.regStatus ?? '',
          notes: row.uscc ? '' : COMPARISON_NO_USCC,
        })
      }
    }
    filename = `${TITLES[title]}-${COMPARISON_LABELS[direction]}.xlsx`
  } else {
    const rows = allRecords(useDb(), {
      title: csv(q.title),
      source: csv(q.source),
      district: str(q.district),
      eventType: csvEventTypes(q.eventType),
      year: csvYears(q.year),
      q: str(q.q),
      flags: str(q.flags),
    })

    const enterprises = new Set(rows.map((r) => r.enterpriseId)).size
    // 企业数由本次筛选的企业×称号行去重,说明先于表头写入。
    writeWorkbook = async (wb, pace) => {
      const ws = legacyExportSheet(wb, pace, '台账', [
        { header: '企业名称', key: 'name', width: 34 },
        { header: '统一社会信用代码', key: 'uscc', width: 20 },
        { header: '区县', key: 'district', width: 12 },
        { header: '称号', key: 'title', width: 18 },
        { header: '来源', key: 'source', width: 14 },
        { header: '事件', key: 'events', width: 32 },
        { header: '出处', key: 'evidence', width: 44 },
      ],
        `口径:一行 = 一个「企业 × 称号」(同一组合下的多个来源合并成一行)。` +
          `本次筛选共 ${rows.length} 行,属于 ${enterprises} 家企业(多称号企业在行数里按称号各计一次)。` +
          `导出为当前筛选下的全部行,不受页面分页限制;同一筛选条件的「按企业」导出见企业总表导出。`,
      )
      for (const r of rows) {
        await ws.addRow({
          name: r.name,
          uscc: r.uscc ?? '',
          district: r.district ?? '',
          title: TITLES[r.titleCode] ?? r.titleCode,
          source: r.sources.map((s) => SOURCES[s] ?? s).join('、'),
          events: r.events,
          evidence: r.evidence,
        })
      }
    }
  }
  const download = await writeLegacyXlsx(event, writeWorkbook)
  setHeader(
    event,
    'content-type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  setHeader(
    event,
    'content-disposition',
    `attachment; filename="roster.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  )
  return download
})
