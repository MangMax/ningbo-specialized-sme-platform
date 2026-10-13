import ExcelJS from 'exceljs'
import { normalizeDistrict, normalizeUscc, parseBatch } from './normalize'
import type { ParsedEntry } from './announcement'

/** 工信部导出 → 称号的列位(0-based;表头在第 1 行,子表头在第 2 行,数据从第 3 行起)。 */
export const MIIT_FILES = [
  { titleCode: 'specialized_sme', file: '工信部名单/专精特新中小企业导出Excel.xlsx', uscc: 17, batch: 302 },
  { titleCode: 'little_giant', file: '工信部名单/专精特新小巨人导出Excel.xlsx', uscc: 17, batch: 273 },
  { titleCode: 'innovative_sme', file: '工信部名单/创新型中小企业导出Excel.xlsx', uscc: 14, batch: 97 },
] as const

export interface MiitSource {
  titleCode: string
  file: string
  uscc: number
  batch: number
}

/** 解析一份工信部导出为记录(事件类型统一为 maintain,批次取维护批次)。 */
export async function parseMiitFile(path: string, src: MiitSource): Promise<ParsedEntry[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const ws = wb.worksheets[0]
  if (!ws) return []

  const out: ParsedEntry[] = []
  const cellText = (row: ExcelJS.Row, col: number): string => {
    const v = row.getCell(col + 1).value
    if (v === null || v === undefined) return ''
    if (typeof v === 'object' && 'richText' in v) return (v.richText ?? []).map((t) => t.text).join('')
    if (typeof v === 'object' && 'text' in v) return String((v as { text: string }).text)
    return String(v)
  }

  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return // 表头 + 子表头
    const name = cellText(row, 0).trim()
    if (!name) return
    const regAddr = cellText(row, 1)
    const district = normalizeDistrict(regAddr.split(/\s+/).filter(Boolean).at(-1) ?? '')
    const { year, seq } = parseBatch(cellText(row, src.batch))
    out.push({
      title: src.titleCode,
      source: 'miit',
      eventType: 'maintain',
      year,
      seq,
      district,
      name,
      uscc: normalizeUscc(cellText(row, src.uscc)),
      sourceFile: src.file,
      attachment: null,
      listNo: null,
    })
  })
  return out
}
