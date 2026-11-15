import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'

// ExcelJS loses explicitly empty inline strings and t="str" values. Decode ONLY
// explicitly serialized empty text, never absent/blank cells; all other cells use
// ExcelJS unchanged. This independent XML check is test-only, not an app parser.
const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip') as {
  loadAsync(bytes: Uint8Array): Promise<{
    files: Record<string, { async(kind: 'string'): Promise<string> }>
  }>
}

export async function readExportWorkbook(input: Uint8Array | Readable) {
  const bytes = input instanceof Readable ? await Array.fromAsync(input).then(Buffer.concat) : input
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(bytes) as never)
  const zip = await JSZip.loadAsync(bytes)
  for (const [index, sheet] of workbook.worksheets.entries()) {
    const entry = zip.files[`xl/worksheets/sheet${index + 1}.xml`]
    if (!entry) throw new Error('Missing export worksheet XML')
    const xml = await entry.async('string')
    for (const match of xml.matchAll(/<c\b([^>]*)>(<is><t><\/t><\/is>|<v><\/v>)<\/c>/g)) {
      if (!(match[2]!.startsWith('<is>') ? /\bt="inlineStr"/ : /\bt="str"/).test(match[1]!)) continue
      const address = /\br="([A-Z]+[0-9]+)"/.exec(match[1]!)?.[1]
      if (!address) throw new Error('Empty text without an address')
      sheet.getCell(address).value = ''
    }
  }
  return workbook
}
