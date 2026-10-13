import ExcelJS from 'exceljs'
import { useDb } from '@db'
import { allRecords, type EventType } from '~~/lib/query'
import { TITLES, SOURCES } from '~~/lib/labels'

const EVENT_TYPES: EventType[] = ['award', 'review', 'maintain', 'nurture']

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

  /** 与 `/api/records` 一致的多值解析:逗号分隔或重复参数。 */
  const csv = (v: unknown): string[] | undefined => {
    if (v == null) return undefined
    const raw = Array.isArray(v) ? v.flatMap((x) => String(x).split(',')) : String(v).split(',')
    const list = raw.map((s) => s.trim()).filter(Boolean)
    return list.length ? list : undefined
  }
  const csvEventTypes = (v: unknown): EventType[] | undefined => {
    const list = csv(v)?.filter((x): x is EventType => EVENT_TYPES.includes(x as EventType))
    return list?.length ? list : undefined
  }
  const csvYears = (v: unknown): number[] | undefined => {
    const list = csv(v)
      ?.map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0)
    return list?.length ? list : undefined
  }

  const rows = allRecords(useDb(), {
    title: csv(q.title),
    source: csv(q.source),
    district: str(q.district),
    eventType: csvEventTypes(q.eventType),
    year: csvYears(q.year),
    q: str(q.q),
    flags: str(q.flags),
  })

  const wb = new ExcelJS.Workbook()
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

  const buffer = await wb.xlsx.writeBuffer()
  setHeader(event, 'content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'content-disposition', 'attachment; filename="roster.xlsx"')
  return new Uint8Array(buffer as ArrayBuffer)
})
