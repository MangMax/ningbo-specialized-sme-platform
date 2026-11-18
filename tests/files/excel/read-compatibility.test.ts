import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { Workbook, Cell } from 'documonster/excel'
import { readPlatformExport } from '../../../layers/sme-roster/lib/platform-export'
import { parseLittleGiantWorkbook } from '../../../lib/roster/little-giant-workbook'

// ExcelJS writes independent fixtures; all assertions exercise the public parsers.
const directory = mkdtempSync(join(tmpdir(), 'roster-excel-read-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function readBoth(workbook: ExcelJS.Workbook, id: string) {
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  return readBytes(bytes, id)
}

async function readBytes(bytes: Buffer, id: string) {
  const path = join(directory, `${id}.xlsx`)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, bytes)
  return { platform: () => readPlatformExport(path), giant: () => parseLittleGiantWorkbook(bytes) }
}

function fixture(date1904 = false) {
  const workbook = new ExcelJS.Workbook()
  workbook.properties.date1904 = date1904
  const sheet = workbook.addWorksheet('创新型中小企业导出Excel')
  sheet.getCell('A1').value = '序号'
  sheet.getCell('C3').value = '合成企业'
  sheet.getCell('B3').value = '鄞州区'
  sheet.getCell('J3').value = '第1批'
  return { workbook, sheet }
}

describe('Excel reader compatibility', () => {
  it.each([
    { id: 'chart-before', order: ['chart', 'first'] },
    { id: 'chart-after', order: ['first', 'chart'] },
    { id: 'chart-between-data', order: ['first', 'chart', 'second'] },
    { id: 'reversed-data-order', order: ['second', 'chart', 'first'] },
  ])('ignores chartsheets while preserving declared worksheet selection and count: $id', async ({ id, order }) => {
    const workbook = Workbook.create()
    for (const name of order) {
      if (name === 'chart') {
        Workbook.addChartsheet(workbook, 'Chart', {
          chart: { type: 'bar', series: [{ values: "'first'!$A$1:$A$2" }] },
        })
      } else {
        const sheet = Workbook.addWorksheet(workbook, name)
        Cell.setValue(sheet, 3, 3, name === 'first' ? '合成首表企业' : '合成次表企业')
        Cell.setValue(sheet, 3, 10, '第1批')
      }
    }
    const bytes = Buffer.from(await Workbook.toBuffer(workbook))
    const old = new ExcelJS.Workbook()
    await old.xlsx.load(new Uint8Array(bytes).buffer)
    const names = order.filter(name => name !== 'chart')
    expect(old.worksheets.map(sheet => sheet.name)).toEqual(names)
    const expectedName = names[0] === 'first' ? '合成首表企业' : '合成次表企业'
    expect(old.worksheets[0]!.getCell('C3').value).toBe(expectedName)
    const readers = await readBytes(bytes, `创新型中小企业导出Excel-${id}`)
    const platform = await readers.platform()
    expect(platform.rows).toHaveLength(1)
    expect(platform.rows[0]!.rawFields[3]).toBe(expectedName)
    const giant = await readers.giant()
    expect(giant).toMatchObject({ sheetIndex: 0, sheetName: names[0], worksheetCount: names.length })
    expect(giant.rows.map(row => row.name)).toEqual([expectedName])
  })

  it('drains deferred worksheets before rejecting an unrecoverable source date without leaking owned temporary storage', async () => {
    const { workbook, sheet } = fixture()
    sheet.getCell('E3').value = 1
    workbook.addWorksheet('second')
    const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip')
    const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
    let xml = await archive.file('xl/worksheets/sheet1.xml').async('string')
    xml = xml.replace(/<c r="E3"[^>]*>.*?<\/c>/, '<c r="E3" t="d"><v>invalid-date</v></c>')
    archive.file('xl/worksheets/sheet1.xml', xml)
    const readers = await readBytes(await archive.generateAsync({ type: 'nodebuffer' }), 'invalid-native-date')
    const ownedTemp = mkdtempSync(join(directory, 'owned-temp-'))
    const previous = process.env.TMPDIR
    process.env.TMPDIR = ownedTemp
    try {
      for (let repeat = 0; repeat < 3; repeat++) {
        await expect(readers.giant()).rejects.toThrow(/原始日期/)
        await expect.poll(() => readdirSync(ownedTemp).filter(name => name.startsWith('documonster-'))).toEqual([])
        await expect(readers.platform()).rejects.toThrow(/原始日期/)
        await expect.poll(() => readdirSync(ownedTemp).filter(name => name.startsWith('documonster-'))).toEqual([])
      }
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  it('recovers early merged dates and fractional caches from the selected sheet despite reversed ZIP entry order', async () => {
    const { workbook, sheet } = fixture()
    sheet.getCell('E3').value = 60
    sheet.getCell('E3').numFmt = 'yyyy-mm-dd'
    sheet.mergeCells('E3:F3')
    sheet.getCell('G3').value = { formula: '1', result: 60.5 }
    sheet.getCell('G3').numFmt = 'yyyy-mm-dd hh:mm:ss.000'
    const other = workbook.addWorksheet('另一张')
    other.getCell('E3').value = 61
    other.getCell('E3').numFmt = 'yyyy-mm-dd'
    const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip')
    const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
    const xml = await archive.file('xl/worksheets/sheet1.xml').async('nodebuffer')
    archive.remove('xl/worksheets/sheet1.xml')
    archive.file('xl/worksheets/sheet1.xml', xml)
    const readers = await readBytes(await archive.generateAsync({ type: 'nodebuffer' }), 'reordered-early-merge')
    expect((await readers.platform()).rows[0]!.rawFields).toMatchObject({ 5: '1900-02-28', 6: '1900-02-28', 7: '1900-02-28' })
    expect((await readers.giant()).rows[0]!.raw.slice(4, 7)).toEqual([
      String(new Date('1900-02-28T00:00:00.000Z')),
      String(new Date('1900-02-28T00:00:00.000Z')),
      String(new Date('1900-02-28T12:00:00.000Z')),
    ])
  })


  it.each([
    ['modern', '2023-10-01T12:00:00Z', '2023'],
    ['early', '1900-02-28T12:00:00Z', '1900'],
    ['cross-year-positive', '2023-01-01T00:30:00+14:00', '2023'],
    ['cross-year-negative', '2022-12-31T23:30:00-12:00', '2022'],
  ])('preserves original unstyled native date source values without inferring UTC years: %s', async (id, source, expected) => {
    const { workbook, sheet } = fixture()
    sheet.getCell('E3').value = 1
    sheet.mergeCells('E3:F3')
    workbook.addWorksheet('second')
    const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip')
    const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
    let xml = await archive.file('xl/worksheets/sheet1.xml').async('string')
    xml = xml.replace(/<c r="E3"[^>]*>.*?<\/c>/, `<c r="E3" t="d"><v>${source}</v></c>`)
    archive.file('xl/worksheets/sheet1.xml', xml)
    const bytes = await archive.generateAsync({ type: 'nodebuffer' })
    const old = new ExcelJS.Workbook()
    await old.xlsx.load(bytes)
    expect(old.worksheets[0]!.getCell('E3').value).toBe(Number(expected))
    const readers = await readBytes(bytes, `native-${id}`)
    expect((await readers.platform()).rows[0]!.rawFields).toMatchObject({ 5: expected, 6: expected })
    expect((await readers.giant()).rows[0]!.raw.slice(4, 6)).toEqual([expected, expected])
  })


  it('preserves styled native dates and native formula caches from the original numeric text', async () => {
    const { workbook, sheet } = fixture()
    sheet.getCell('E3').value = 1
    sheet.getCell('E3').numFmt = 'yyyy-mm-dd'
    sheet.getCell('F3').value = { formula: '1', result: 1 }
    const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip')
    const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
    let xml = await archive.file('xl/worksheets/sheet1.xml').async('string')
    xml = xml.replace(/<c r="E3"([^>]*)>.*?<\/c>/, '<c r="E3"$1 t="d"><v>2023-01-01T00:30:00+14:00</v></c>')
      .replace(/<c r="F3"[^>]*>.*?<\/c>/, '<c r="F3" t="d"><f>1</f><v>1900-02-28T12:00:00Z</v></c>')
    archive.file('xl/worksheets/sheet1.xml', xml)
    const bytes = await archive.generateAsync({ type: 'nodebuffer' })
    const old = new ExcelJS.Workbook()
    await old.xlsx.load(bytes)
    const oldDate = old.worksheets[0]!.getCell('E3').value as Date
    expect(oldDate.toISOString()).toBe('1905-07-15T00:00:00.000Z')
    expect(old.worksheets[0]!.getCell('F3').result).toBe(1900)
    const readers = await readBytes(bytes, 'native-style-formula')
    expect((await readers.platform()).rows[0]!.rawFields).toMatchObject({ 5: '1905-07-15', 6: '1900' })
    expect((await readers.giant()).rows[0]!.raw.slice(4, 6)).toEqual([String(oldDate), '1900'])
  })

  it('preserves plain falsy values, shared formula caches and cached business strings', async () => {
    const { workbook, sheet } = fixture()
    sheet.getCell('A3').value = 0
    sheet.getCell('C3').value = { formula: '"合成缓存企业"', result: '合成缓存企业' }
    sheet.getCell('D3').value = false
    sheet.getCell('E3').value = { formula: '1', result: 0 }
    sheet.getCell('F3').value = { sharedFormula: 'E3', result: false }
    sheet.getCell('J3').value = { formula: '"第2批"', result: '第2批' }
    const readers = await readBoth(workbook, 'shared-cache')
    expect((await readers.platform()).rows[0]!.rawFields).toMatchObject({
      1: '0', 3: '合成缓存企业', 4: 'false', 5: '[object Object]', 6: '[object Object]', 10: '第2批',
    })
    const giant = await readers.giant()
    expect(giant.rows[0]).toMatchObject({ listNo: 0, name: '合成缓存企业', usccRaw: 'false', uscc: 'FALSE', batchSeq: 2, year: 2020 })
    expect(giant.issues.map(issue => [issue.code, issue.sourceRowNo])).toEqual([['invalid_uscc', 3]])
  })


  it('rejects a missing declared first sheet even when an empty second sheet survives', async () => {
    const { workbook } = fixture()
    workbook.addWorksheet('专精特新中小企业导出Excel')
    const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip')
    const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
    archive.remove('xl/worksheets/sheet1.xml')
    const readers = await readBytes(await archive.generateAsync({ type: 'nodebuffer' }), 'missing-first-with-survivor')
    await expect(readers.platform()).rejects.toThrow(/工作表/)
    await expect(readers.giant()).rejects.toThrow(/工作表/)
  })

  it('rejects incomplete reader models for valid relationship-resolved nonstandard sheet parts', async () => {
    const { workbook } = fixture()
    workbook.addWorksheet('second')
    const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip')
    const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
    const first = await archive.file('xl/worksheets/sheet1.xml').async('string')
    archive.remove('xl/worksheets/sheet1.xml')
    archive.file('xl/custom/first.xml', first)
    let rels = await archive.file('xl/_rels/workbook.xml.rels').async('string')
    rels = rels.replace('Target="worksheets/sheet1.xml"', 'Target="custom/../custom/first.xml"')
      .replace('Target="worksheets/sheet2.xml"', 'Target="/xl/worksheets/sheet2.xml"')
    archive.file('xl/_rels/workbook.xml.rels', rels)
    const readers = await readBytes(await archive.generateAsync({ type: 'nodebuffer' }), 'resolved-parts')
    // The package is complete; 0.20.2 cannot expose this part as a worksheet.
    // Reject the incomplete model explicitly rather than selecting its survivor.
    await expect(readers.giant()).rejects.toThrow(/读取器.*工作表/)
    await expect(readers.platform()).rejects.toThrow(/读取器.*工作表/)
  })

  it('keeps an empty first sheet instead of choosing a populated later sheet', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('创新型中小企业导出Excel')
    workbook.addWorksheet('第二张').getCell('C3').value = '不应进入名单'
    const readers = await readBoth(workbook, 'first-empty')
    expect((await readers.platform()).rows).toEqual([])
    expect(await readers.giant()).toMatchObject({ worksheetCount: 2, dataRowCount: 0, rows: [], issues: [] })
  })

  it.each([
    { id: '1904-early-january', serial: -1460, iso: '1900-01-01T00:00:00.000Z' },
    { id: '1904-early-march', serial: -1401, iso: '1900-03-01T00:00:00.000Z' },
  ])('does not apply 1900 corrections to negative 1904 serials: $id', async ({ id, serial, iso }) => {
    const { workbook, sheet } = fixture(true)
    sheet.getCell('E3').value = serial
    sheet.getCell('F3').value = { formula: '1', result: serial }
    for (const address of ['E3', 'F3']) sheet.getCell(address).numFmt = 'yyyy-mm-dd'
    const readers = await readBoth(workbook, id)
    expect((await readers.platform()).rows[0]!.rawFields).toMatchObject({ 5: iso.slice(0, 10), 6: iso.slice(0, 10) })
    expect((await readers.giant()).rows[0]!.raw.slice(4, 6)).toEqual([String(new Date(iso)), String(new Date(iso))])
  })

  it('preserves rich text, links, merged values, literal formulas, sparse rows and source warnings on the first sheet', async () => {
    const { workbook, sheet } = fixture()
    sheet.getCell('C3').value = { richText: [{ text: ' 合成' }, { font: { bold: true }, text: '企业 ' }] }
    sheet.getCell('A3').value = 7
    sheet.getCell('E3').value = '合并原文'
    sheet.mergeCells('E3:F3')
    sheet.getCell('G3').value = { text: '显示文字', hyperlink: 'https://example.test/' }
    sheet.getCell('H3').value = '=literal-not-executed'
    sheet.getCell('I3').value = { error: '#N/A' }
    sheet.getCell('K5').value = '仅旁栏，不是企业'
    sheet.getCell('O1').value = '远列表头'
    sheet.getCell('A6').numFmt = '0'
    workbook.addWorksheet('第二张不应读取').getCell('C3').value = '错误企业'
    const readers = await readBoth(workbook, 'structure')
    const platform = await readers.platform()
    expect(platform.columnCount).toBe(15)
    expect(platform.rows.map(row => [row.sourceRowNo, row.nameRaw])).toEqual([[3, '7'], [5, null]])
    expect(platform.rows[0]!.rawFields).toEqual({
      1: '7', 2: '鄞州区', 3: '合成企业', 5: '合并原文', 6: '合并原文',
      7: '显示文字', 8: '=literal-not-executed', 9: '[object Object]', 10: '第1批',
    })
    const giant = await readers.giant()
    expect(giant).toMatchObject({
      sheetIndex: 0, sheetName: '创新型中小企业导出Excel', worksheetCount: 2,
      dataRowCount: 5, blankRowNumbers: [2, 4, 5, 6],
    })
    expect(giant.rows).toHaveLength(1)
    expect(giant.rows[0]).toMatchObject({ sourceRowNo: 3, listNo: 7, name: '合成企业', uscc: '', year: 2019 })
    expect(giant.rows[0]!.raw).toEqual([
      '7', '鄞州区', ' 合成企业 ', '', '合并原文', '合并原文', '显示文字', '=literal-not-executed', '[object Object]', '第1批',
    ])
    expect(giant.issues.map(issue => [issue.code, issue.severity, issue.sourceRowNo, issue.raw])).toEqual([
      ['missing_uscc', 'warning', 3, giant.rows[0]!.raw],
    ])
  })

  it('distinguishes a valid empty sheet from missing sheet parts and corrupt archives', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('创新型中小企业导出Excel')
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    const empty = await readBytes(bytes, 'empty')
    expect(await empty.platform()).toMatchObject({ rowCount: 0, columnCount: 0, rows: [] })
    expect(await empty.giant()).toMatchObject({ worksheetCount: 1, dataRowCount: 0, rows: [], issues: [], blankRowNumbers: [] })
    // ZIP surgery is fixture-only, via the independent old writer's dependency.
    const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip')
    const archive = await JSZip.loadAsync(bytes)
    archive.remove('xl/worksheets/sheet1.xml')
    const missingPart = await readBytes(await archive.generateAsync({ type: 'nodebuffer' }), 'missing-part')
    await expect(missingPart.platform()).rejects.toThrow(/工作表/)
    await expect(missingPart.giant()).rejects.toThrow(/工作表/)
    for (const [id, content] of [['not-zip', Buffer.from('not an XLSX')], ['truncated', bytes.subarray(0, 40)]] as const) {
      const corrupt = await readBytes(content, id)
      await expect(corrupt.platform()).rejects.toThrow()
      await expect(corrupt.giant()).rejects.toThrow()
    }
    await expect(readPlatformExport(join(directory, 'does-not-exist.xlsx'))).rejects.toThrow()
  })

  const serials = [-1, 0, 1, 59, 60, 61, 45200, 45200 + 0.9994 / 86400, 45200 + 0.9996 / 86400]
  // Literals from independent ExcelJS 4.4 reads, including millisecond rounding.
  const oldDates = [
    ['1899-12-29T00:00:00.000Z', '1899-12-30T00:00:00.000Z', '1899-12-31T00:00:00.000Z',
      '1900-02-27T00:00:00.000Z', '1900-02-28T00:00:00.000Z', '1900-03-01T00:00:00.000Z', '2023-10-01T00:00:00.000Z',
      '2023-10-01T00:00:00.999Z', '2023-10-01T00:00:01.000Z'],
    ['1903-12-31T00:00:00.000Z', '1904-01-01T00:00:00.000Z', '1904-01-02T00:00:00.000Z',
      '1904-02-29T00:00:00.000Z', '1904-03-01T00:00:00.000Z', '1904-03-02T00:00:00.000Z',
      '2027-10-02T00:00:00.000Z', '2027-10-02T00:00:00.999Z', '2027-10-02T00:00:01.000Z'],
  ]
  const dateCases = oldDates.flatMap((dates, epoch) => dates.flatMap((iso, index) =>
    iso === null ? [] : [{ id: `epoch${epoch}-case${index}`, date1904: epoch === 1, serial: serials[index]!, iso: iso! }]))

  it.each(dateCases)('preserves plain and cached dates with original text conventions: $id', async ({ id, date1904, serial, iso }) => {
    const { workbook, sheet } = fixture(date1904)
    sheet.getCell('E3').value = serial
    sheet.getCell('F3').value = { formula: '1', result: serial }
    for (const address of ['E3', 'F3']) sheet.getCell(address).numFmt = 'yyyy-mm-dd hh:mm:ss.000'
    const readers = await readBoth(workbook, id)
    const platform = (await readers.platform()).rows[0]!
    expect(platform.rawFields['5']).toBe(iso.slice(0, 10))
    expect(platform.rawFields['6']).toBe(iso.slice(0, 10))
    const giant = (await readers.giant()).rows[0]!
    expect(giant.raw.slice(4, 6)).toEqual([String(new Date(iso)), String(new Date(iso))])
  })

  it('preserves cached zero/false as the old nonempty unknown text, never an empty row', async () => {
    const { workbook, sheet } = fixture()
    sheet.getCell('E3').value = { formula: '1', result: 0 }
    sheet.getCell('F3').value = { formula: '1', result: false }
    sheet.getCell('G3').value = { formula: '1', result: '' }
    sheet.getCell('H3').value = { formula: '1' }
    sheet.getCell('I3').value = { formula: '1', result: 42 }
    const readers = await readBoth(workbook, 'formula-caches')
    expect((await readers.platform()).rows[0]!.rawFields).toMatchObject({
      5: '[object Object]', 6: '[object Object]', 7: '[object Object]', 8: '[object Object]', 9: '42',
    })
    expect((await readers.giant()).rows[0]!.raw.slice(4, 9)).toEqual([
      '[object Object]', '[object Object]', '[object Object]', '[object Object]', '42',
    ])
  })

})
