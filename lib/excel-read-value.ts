import { Address, Cell, Row, Stream, Worksheet } from 'documonster/excel'
import { readNativeDateSources } from './excel-source'

const EARLY_DATE_END = Date.UTC(1900, 2, 2)

/** Recover early numeric dates through the public unstyled streaming reader.
 * The normal model collapses serials 60/61; never invert its Date to guess a serial.
 */
export async function createExcelValueReader(
  sheet: Worksheet.Handle,
  input: Uint8Array,
  sourcePart: string,
  bounds: { firstRow: number; columnCount: number },
) {
  const nativeDates = await readNativeDateSources(input, sourcePart)
  const pending = new Map<string, { row: number; col: number; date1904: boolean }>()
  for (let row = bounds.firstRow; row <= Worksheet.rowCount(sheet); row++) {
    Row.eachCell(sheet, row, (cell, col) => {
      if (col > bounds.columnCount) return
      const value = Stream.getCellValue(cell)
      const date = value instanceof Date ? value
        : value && typeof value === 'object' && 'result' in value ? value.result : undefined
      if (!(date instanceof Date) || date.getTime() >= EARLY_DATE_END) return
      const model = Cell.getModel(sheet, row, col)
      const address = model.master ?? model.address
      if (nativeDates.has(address) && Number.isFinite(Number.parseFloat(nativeDates.get(address)!))) return
      const position = Address.decodeCell(address)
      pending.set(address, { row: position.r + 1, col: position.c + 1, date1904: Cell.view(cell).date1904 })
    })
  }

  const dates = new Map<string, Date>()
  if (pending.size > 0) {
    const byRow = new Map<number, Array<[string, { col: number; date1904: boolean }]>>()
    for (const [address, position] of pending) {
      const cells = byRow.get(position.row) ?? []
      cells.push([address, position])
      byRow.set(position.row, cells)
    }
    const reader = new Stream.WorkbookReader(input, {
      worksheets: 'emit', styles: 'ignore', sharedStrings: 'ignore', hyperlinks: 'ignore',
    })
    // Match the selected sheet by its unique name, not ZIP entry order. Consume
    // the iterator completely so the library releases deferred sheet resources.
    // Consumer throws/return bypass cleanup of worksheets still waiting in
    // 0.20.2. Defer adapter rejection until every sheet has been consumed.
    let recoveryError: Error | undefined
    for await (const streamedSheet of reader) {
      for await (const row of streamedSheet) {
        if (streamedSheet.name !== Worksheet.getName(sheet)) continue
        for (const [address, position] of byRow.get(row.number) ?? []) {
          const raw = Stream.getCellValue(Stream.rowCell(row, position.col))
          const serial = typeof raw === 'number' ? raw
            : raw && typeof raw === 'object' && 'result' in raw ? raw.result : undefined
          if (typeof serial !== 'number' || !Number.isFinite(serial)) {
            recoveryError ??= new Error(`无法读取 Excel 原始日期序列:${Worksheet.getName(sheet)}!${address}`)
            continue
          }
          // Preserve ExcelJS 4.4's linear epoch and millisecond rounding from
          // the actual stored number, including the fictitious leap day.
          dates.set(address, new Date(Math.round((serial - 25569 + (position.date1904 ? 1462 : 0)) * 24 * 3600 * 1000)))
        }
      }
    }
    if (recoveryError) throw recoveryError
    for (const address of pending.keys()) {
      if (!dates.has(address)) throw new Error(`缺少 Excel 原始日期序列:${Worksheet.getName(sheet)}!${address}`)
    }
  }

  function dateValue(value: Date, row: number, column: number): Date | number {
    const model = Cell.getModel(sheet, row, column)
    const source = nativeDates.get(model.master ?? model.address)
    if (source !== undefined) {
      const number = Number.parseFloat(source)
      if (!Number.isFinite(number)) throw new Error(`无法读取 Excel 原始日期:${Worksheet.getName(sheet)}!${model.address}`)
      // ExcelJS 4.4 treats native t=d text as a number. Preserve the actual
      // source text (and original year across offsets), never a Date-derived year.
      const format = Cell.getNumFmt(sheet, row, column)
      // Preserve the old number-format classification, including quoted text
      // and bracketed sections; this is value compatibility, not XML decoding.
      const dateFormatted = typeof format === 'string' && /[ymdhMsb]+/.test(format.replace(/\[[^\]]*]/g, '').replace(/"[^"]*"/g, ''))
      return dateFormatted
        ? new Date(Math.round((number - 25569 + (Cell.view(Row.getCell(sheet, row, column)).date1904 ? 1462 : 0)) * 86400000))
        : number
    }
    if (value.getTime() >= EARLY_DATE_END) return value
    const date = dates.get(model.master ?? model.address)
    if (!date) throw new Error(`缺少 Excel 原始日期序列:${Worksheet.getName(sheet)}!${model.address}`)
    return date
  }

  return (row: number, column: number): unknown => {
    const value = Cell.getValue(sheet, row, column)
    if (value instanceof Date) return dateValue(value, row, column)
    if (value && typeof value === 'object' && 'result' in value && value.result instanceof Date) {
      return { ...value, result: dateValue(value.result, row, column) }
    }
    // ExcelJS 4.4 omits falsy formula caches on read. Keep its existing
    // nonempty unknown marker instead of changing identity fields to 0/false
    // or silently making them blank. Plain numeric/boolean cells stay intact.
    if (value && typeof value === 'object' && 'result' in value
      && (value.result === 0 || value.result === false || value.result === '')) {
      return { ...value, result: undefined }
    }
    return value
  }
}
