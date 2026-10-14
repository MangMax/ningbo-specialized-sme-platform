import ExcelJS from 'exceljs'
import { useDb } from '@db'
import { allRecords, type EventType } from '~~/lib/query'
import {
  TITLES,
  SOURCES,
  TITLE_ORDER,
  COMPARISON_LABELS,
  COMPARISON_NO_USCC,
} from '~~/lib/labels'
import {
  COMPARISON_DIRECTIONS,
  getComparison,
  type ComparisonDirection,
} from '~~/lib/comparison'

const EVENT_TYPES: EventType[] = ['award', 'review', 'maintain', 'nurture']

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

  const wb = new ExcelJS.Workbook()
  let filename = 'roster.xlsx'
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
    const { rows } = getComparison(useDb(), { title: [title], direction })
    const ws = wb.addWorksheet('比对')
    ws.columns = [
      { header: '企业名称', key: 'name', width: 34 },
      { header: '统一社会信用代码', key: 'uscc', width: 20 },
      { header: '区县', key: 'district', width: 12 },
      { header: '称号', key: 'title', width: 24 },
      { header: '方向', key: 'direction', width: 14 },
      { header: '当前城市', key: 'city', width: 12 },
      { header: '登记状态', key: 'regStatus', width: 24 },
      { header: '备注', key: 'notes', width: 34 },
    ]
    for (const row of rows) {
      ws.addRow({
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

    const ws = wb.addWorksheet('台账')
    ws.columns = [
      { header: '企业名称', key: 'name', width: 34 },
      { header: '统一社会信用代码', key: 'uscc', width: 20 },
      { header: '区县', key: 'district', width: 12 },
      { header: '称号', key: 'title', width: 18 },
      { header: '来源', key: 'source', width: 14 },
      { header: '事件', key: 'events', width: 32 },
      { header: '出处', key: 'evidence', width: 44 },
    ]
    for (const r of rows) {
      ws.addRow({
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

  const buffer = await wb.xlsx.writeBuffer()
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
  return new Uint8Array(buffer as ArrayBuffer)
})
