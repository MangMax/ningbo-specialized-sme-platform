// Independent literal oracle: node scripts/acceptance/file-event-sync-671-workbook-oracle.mjs BEFORE.xlsx AFTER.xlsx
// Reads downloaded workbooks only; no app builder, qualification implementation or database dependency.
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
const read = async (path) => {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  return wb.worksheets.flatMap((s) => s.getSheetValues().filter(Array.isArray))
}
const [beforePath, afterPath] = process.argv.slice(2)
assert(beforePath && afterPath, 'two actual downloaded XLSX files required')
const before = await read(beforePath),
  after = await read(afterPath)
const row = (rows, name) => {
  const matches = rows.filter((r) => r[2] === name)
  assert.equal(matches.length, 1, name)
  return matches[0]
}
assert.match(row(before, '反例19')[7], /原认定年份待核/)
assert.equal(row(after, '反例19')[7], '2025年第2批认定')
assert.equal(row(after, '同步第二组合2022')[7], '2022年第1批认定')
assert.match(row(after, '同步未解决缺页')[7], /原认定年份待核/)
assert.match(row(after, '反例19')[15], /公布名称未留档/)
console.log(
  'PASS: literal 2025/2 and 2022/1, year gap removed only for supported events; missing-page and unpublished-name gaps retained',
)
