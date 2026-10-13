import ExcelJS from 'exceljs'
import { useDb } from '@db'
import { allRecords } from '~~/lib/query'

const TITLES: Record<string, string> = {
  little_giant: '专精特新“小巨人”',
  specialized_sme: '专精特新中小企业',
  innovative_sme: '创新型中小企业',
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const rows = allRecords(useDb(), {
    title: typeof q.title === 'string' && q.title ? q.title : undefined,
    source: typeof q.source === 'string' && q.source ? q.source : undefined,
    district: typeof q.district === 'string' && q.district ? q.district : undefined,
    q: typeof q.q === 'string' && q.q ? q.q : undefined,
  })

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('台账')
  ws.columns = [
    { header: '企业名称', key: 'name', width: 34 },
    { header: '统一社会信用代码', key: 'uscc', width: 20 },
    { header: '区县', key: 'district', width: 12 },
    { header: '称号', key: 'title', width: 18 },
    { header: '来源', key: 'source', width: 10 },
    { header: '事件', key: 'events', width: 28 },
  ]
  for (const r of rows) {
    ws.addRow({
      name: r.name,
      uscc: r.uscc ?? '',
      district: r.district ?? '',
      title: TITLES[r.titleCode] ?? r.titleCode,
      source: r.source === 'jxj' ? '经信局' : '工信部',
      events: r.events,
    })
  }

  const buffer = await wb.xlsx.writeBuffer()
  setHeader(event, 'content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'content-disposition', 'attachment; filename="roster.xlsx"')
  return new Uint8Array(buffer as ArrayBuffer)
})
