import archiver from 'archiver'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { H3Event } from 'h3'

export interface XlsxColumn {
  header: string
  width: number
  wrap?: boolean
}

type XlsxCell = string | number | null | undefined

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NEEDS_XSTRING = /_[xX][0-9A-Fa-f]{4}_|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function escapeXml(value: string): string {
  // SpreadsheetML text escapes preserve C0 controls; a literal escape-looking
  // sequence must have its leading underscore escaped before Excel decodes it.
  // Replace in one pass so generated _xHHHH_ sequences are not escaped again.
  return value.replace(/_[xX][0-9A-Fa-f]{4}_|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF&<>"'\r]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, char => {
    if (char.length > 1) return `_x005F_${char.slice(1)}`
    if (char === '\r') return '&#13;'
    const code = char.charCodeAt(0)
    if (code < 0x20 || code >= 0xD800) return `_x${code.toString(16).padStart(4, '0').toUpperCase()}_`
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!
  })
}

function columnName(index: number): string {
  let name = ''
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name
  return name
}

function cellXml(value: XlsxCell, row: number, col: number, wrap: boolean): string {
  if (value == null) return ''
  const attrs = `r="${columnName(col)}${row}"${wrap ? ' s="1"' : ''}`
  if (typeof value === 'number') return `<c ${attrs}><v>${value}</v></c>`
  return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

/** The ZIP reader pulls one row at a time; a stopped HTTP reader stops worksheet production. */
export async function streamXlsx(
  event: H3Event,
  filename: string,
  sheetName: string,
  columns: XlsxColumn[],
  rows: Iterable<readonly XlsxCell[]>,
): Promise<unknown> {
  const response = event.node?.res
  const request = event.node?.req
  const disconnected = () => Object.assign(new Error('Excel export disconnected'), { name: 'AbortError' })
  if (request?.aborted || response?.destroyed || response?.closed) throw disconnected()

  // Only text needing SpreadsheetML escapes uses shared strings. Spooling that
  // part keeps memory bounded while the worksheet and HTTP response stream.
  const tempDir = await mkdtemp(join(tmpdir(), 'xlsx-stream-'))
  const sharedPath = join(tempDir, 'shared-strings.xml.part')
  const sharedWriter = createWriteStream(sharedPath)
  const sharedReady = finished(sharedWriter)
  void sharedReady.catch(() => {})
  let sharedCount = 0
  const output = new PassThrough({ highWaterMark: 64 * 1024 })
  const zip = archiver('zip', { zlib: { level: 6 } })
  const worksheet = Readable.from((async function* () {
    yield `${XML}<worksheet xmlns="${MAIN}"><cols>${columns.map((col, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${col.width}" customWidth="1"/>`).join('')}</cols><sheetData>`
    let rowNumber = 0
    for (const values of rows) {
      if (response?.destroyed || response?.closed || request?.aborted) throw disconnected()
      rowNumber++
      const cells: string[] = []
      for (let i = 0; i < values.length; i++) {
        const value = values[i]
        const wrap = !!columns[i]?.wrap && rowNumber > 2
        if (typeof value === 'string' && NEEDS_XSTRING.test(value)) {
          const attrs = `r="${columnName(i + 1)}${rowNumber}"${wrap ? ' s="1"' : ''}`
          cells.push(`<c ${attrs} t="s"><v>${sharedCount++}</v></c>`)
          if (!sharedWriter.write(`<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)) {
            await once(sharedWriter, 'drain')
          }
        } else {
          cells.push(cellXml(value, rowNumber, i + 1, wrap))
        }
      }
      yield `<row r="${rowNumber}">${cells.join('')}</row>`
    }
    yield '</sheetData></worksheet>'
    sharedWriter.end()
    await sharedReady
  })())
  const sharedStrings = Readable.from((async function* () {
    await sharedReady
    yield `${XML}<sst xmlns="${MAIN}" count="${sharedCount}" uniqueCount="${sharedCount}">`
    for await (const chunk of createReadStream(sharedPath)) yield chunk
    yield '</sst>'
  })())

  const abort = () => {
    if (response?.writableFinished) return
    zip.abort()
    worksheet.destroy(disconnected())
    sharedStrings.destroy(disconnected())
    sharedWriter.destroy(disconnected())
    output.destroy(disconnected())
  }
  request?.once('aborted', abort)
  response?.once('close', abort)
  zip.once('error', error => output.destroy(error))
  worksheet.once('error', error => output.destroy(error))
  sharedStrings.once('error', error => output.destroy(error))
  sharedWriter.once('error', error => output.destroy(error))
  zip.pipe(output)

  zip.append(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`, { name: '[Content_Types].xml' })
  zip.append(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`, { name: '_rels/.rels' })
  zip.append(`${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`, { name: 'xl/workbook.xml' })
  zip.append(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`, { name: 'xl/_rels/workbook.xml.rels' })
  zip.append(`${XML}<styleSheet xmlns="${MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>`, { name: 'xl/styles.xml' })
  zip.append(worksheet, { name: 'xl/worksheets/sheet1.xml' })
  zip.append(sharedStrings, { name: 'xl/sharedStrings.xml' })

  setHeader(event, 'content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'content-disposition',
    `attachment; filename="${filename.startsWith('企业总表-') ? 'roster-enterprises.xlsx' : 'roster.xlsx'}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  response?.flushHeaders()
  const finalized = zip.finalize()
  // sendStream may reject first on disconnect; keep a rejected finalizer observed.
  void finalized.catch(() => {})
  try {
    const sent = await sendStream(event, output)
    await finalized
    return sent
  } catch (error) {
    // Headers may already be sent. A failed ZIP must end the transfer as an error,
    // never as a successful 200 response containing a truncated workbook.
    if (response && !response.destroyed && !response.writableFinished) response.destroy(error as Error)
    throw error
  } finally {
    request?.off('aborted', abort)
    response?.off('close', abort)
    if (response && !response.writableFinished) abort()
    await rm(tempDir, { recursive: true, force: true })
  }
}
