import { leadSourceRows, type VersionInput } from './contracts'

type SheetRow = { number: number; cells: string[] }
export type LeadImport = { rows: VersionInput['rows']; name: string }
export const MAX_LEAD_WORKBOOK_BYTES = 10 * 1024 * 1024

const columnLabels = [
  ['企业名称', '公司名称'],
  ['统一社会信用代码', '信用代码'],
  ['区县', '所在区县'],
  ['备注'],
] as const

function parseRows(records: SheetRow[], requireHeader: boolean): VersionInput['rows'] {
  const populated = records.filter(row => row.cells.some(cell => cell))
  const headings = populated[0]?.cells ?? []
  const columns = columnLabels.map(labels => headings.findIndex(value => labels.some(label => label === value)))
  const hasHeader = columns[0] !== -1
  if (requireHeader && !hasHeader) throw new Error('首行需要包含「企业名称」列。')
  if (hasHeader && columnLabels.some(labels => headings.filter(value => labels.some(label => label === value)).length > 1)) {
    throw new Error('名单有重复列名，请保留每类字段的一列。')
  }

  const input = hasHeader ? populated.slice(1) : populated
  if (input.length > 2000) throw new Error('每个名单版本最多登记 2,000 条。')
  for (const record of input) {
    if (!hasHeader && record.cells.slice(4).some(Boolean)) {
      throw new Error(`第 ${record.number} 行超过四列，请加上表头或核对列顺序。`)
    }
  }
  const [name = -1, uscc = -1, district = -1, note = -1] = hasHeader ? columns : [0, 1, 2, 3]
  const parsed = leadSourceRows.safeParse(input.map(({ cells, number }) => ({
    rowNumber: number,
    name: cells[name] ?? '',
    uscc: cells[uscc] || undefined,
    district: cells[district] || undefined,
    note: cells[note] || undefined,
  })))
  if (parsed.success) return parsed.data
  const [row, field] = parsed.error.issues[0]?.path ?? []
  if (typeof row !== 'number') throw new Error('名单为空，请添加至少一家企业。')
  const labels = { name: '企业名称', uscc: '信用代码', district: '区县', note: '备注' }
  const label = labels[field as keyof typeof labels] ?? '内容'
  throw new Error(`第 ${input[row]?.number} 行的${label}为空或格式有误，请核对后重新导入。`)
}

export async function readPastedLeadRows(text: string): Promise<LeadImport> {
  const { Csv } = await import('documonster/csv')
  const result = Csv.parse(text, { delimiter: '\t', info: true, skipEmptyLines: false })
  if (result.errors?.length) throw new Error('粘贴内容有未闭合的引号，请从工作表重新复制。')
  const records = result.rows.map(({ record, info }) => ({
    number: info.line,
    cells: record.map(cell => cell.trim()),
  }))
  return { rows: parseRows(records, false), name: '从表格粘贴' }
}

export async function readLeadWorkbook(file: File) {
  if (!/\.xlsx$/i.test(file.name)) throw new Error('请选择 .xlsx 工作簿。')
  if (file.size > MAX_LEAD_WORKBOOK_BYTES) throw new Error('工作簿超过 10 MB，请另存为仅含本次名单的工作簿。')
  const { Workbook, Worksheet, Row, Cell } = await import('documonster/excel')
  const workbook = await Workbook.read(Workbook.create(), await file.arrayBuffer()).catch(() => {
    throw new Error('无法打开工作簿，请检查文件是否损坏或加密。')
  })
  const sheets = Workbook.getWorksheets(workbook)
  if (!sheets.length) throw new Error('工作簿没有可读取的工作表。')
  return {
    names: sheets.map(Worksheet.getName),
    read(index: number): LeadImport {
      const sheet = sheets[index]!
      const records: SheetRow[] = []
      Worksheet.eachRow(sheet, (_, number) => {
        if (records.length > 2000) throw new Error('每个名单版本最多登记 2,000 条。')
        const cells = Row.getValues(sheet, number).map((value, column) => (
          typeof value === 'string' ? value : Cell.getText(sheet, number, column + 1)
        ).trim())
        if (cells.some(Boolean)) records.push({ number, cells })
      })
      return { rows: parseRows(records, true), name: `${file.name} · ${Worksheet.getName(sheet)}` }
    },
  }
}
