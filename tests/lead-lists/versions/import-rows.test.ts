import { Workbook, Worksheet } from 'documonster/excel'
import { expect, it } from 'vitest'
import { readLeadWorkbook, readPastedLeadRows } from '../../../layers/lead-lists/lib/import-rows'

it('reads a chosen Excel worksheet by column names and retains the original row numbers and credit-code text', async () => {
  const book = Workbook.create()
  Worksheet.addRows(Workbook.addWorksheet(book, '说明'), [['编制时间']])
  const sheet = Workbook.addWorksheet(book, '核对名单')
  Worksheet.addRows(sheet, [
    ['序号', '区县', '企业名称', '统一社会信用代码', '备注'],
    [1, '海曙区', '验收企业甲', '001234567890123456', '已核对'],
    [],
    [2, '奉化区', '验收企业乙', '91330200MATEST0001'],
  ])
  const workbook = await readLeadWorkbook(new File([Uint8Array.from(await Workbook.toBuffer(book))], '名单.xlsx'))
  expect(workbook.names).toEqual(['说明', '核对名单'])
  expect(() => workbook.read(0)).toThrow('首行需要包含「企业名称」列')
  expect(workbook.read(1)).toEqual({
    name: '名单.xlsx · 核对名单',
    rows: [
      { rowNumber: 2, name: '验收企业甲', uscc: '001234567890123456', district: '海曙区', note: '已核对' },
      { rowNumber: 4, name: '验收企业乙', uscc: '91330200MATEST0001', district: '奉化区', note: undefined },
    ],
  })
})

it('retains blank positions and quoted tabs and line breaks in pasted spreadsheet cells', async () => {
  const result = await readPastedLeadRows('企业名称\t信用代码\t区县\t备注\r\n验收企业甲\t00123\t海曙区\t"一行\r\n二行\t补充"\r\n\r\n验收企业乙')
  expect(result.rows).toEqual([
    { rowNumber: 2, name: '验收企业甲', uscc: '00123', district: '海曙区', note: '一行\n二行\t补充' },
    { rowNumber: 5, name: '验收企业乙', uscc: undefined, district: undefined, note: undefined },
  ])
})

it('reports the source row of a missing enterprise name before registration', async () => {
  await expect(readPastedLeadRows('企业名称\t信用代码\n\t00123')).rejects.toThrow('第 2 行的企业名称')
  await expect(readPastedLeadRows('企业名称\t信用代码\t统一社会信用代码\n企业甲\t00123\t00456')).rejects.toThrow('重复列名')
  await expect(readPastedLeadRows('企业甲\t00123\t海曙区\t备注\t多余列')).rejects.toThrow('第 1 行超过四列')
})
