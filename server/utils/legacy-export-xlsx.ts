import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { setImmediate } from 'node:timers/promises'
import type { H3Event } from 'h3'
import { Stream } from 'documonster/excel'
import { appLog, requestLogContext } from '../../layers/core/lib/logging'

type Pace = (characters: number) => Promise<void>

/** SpreadsheetML escapes are distinct from XML escaping. Encode once so literal
 * _xHHHH_ text cannot be mistaken for a generated control-character escape. */
function textXml(value: string) {
  return value.replace(/_[xX][0-9A-Fa-f]{4}_|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF&<>"'\r]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, char => {
    if (char.length > 1) return `_x005F_${char.slice(1)}`
    if (char === '\r') return '&#13;'
    const code = char.charCodeAt(0)
    if (code < 0x20 || code >= 0xD800) return `_x${code.toString(16).padStart(4, '0').toUpperCase()}_`
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!
  })
}

/** Stage the XLSX before sending headers, then let h3 stream the completed file.
 * The owned sink lets disk errors and disconnected requests remove partial files.
 * The query's existing row array remains; serialized workbook bytes are not collected.
 */
export async function writeLegacyXlsx(
  event: H3Event,
  write: (workbook: Stream.WorkbookWriter, pace: Pace) => Promise<void>,
  kind: 'records' | 'comparison' | 'enterprises' = 'records',
) {
  const logContext = requestLogContext({ context: event.context ?? {} }), startedAt = Date.now()
  const operation = `export.legacy.${kind}`
  appLog({ module: 'sme-roster', source: 'export', operation: operation + '.workbook', outcome: 'started' }, logContext)
  let disconnected = false, downloadRecorded = false
  const recordDownload = (outcome: 'success' | 'failure' | 'cancelled', errorCode?: string) => {
    if (downloadRecorded) return
    downloadRecorded = true
    appLog({ module: 'sme-roster', source: 'export', operation: operation + '.download', outcome, durationMs: Date.now() - startedAt, errorCode, level: outcome === 'failure' ? 'error' : outcome === 'success' ? 'info' : 'warn' }, logContext)
  }
  let dir: string
  try { dir = mkdtempSync(join(tmpdir(), 'roster-export-')) }
  catch (error) {
    appLog({ module: 'sme-roster', source: 'export', operation: operation + '.workbook', outcome: 'failure', level: 'error', errorCode: 'legacy_workbook_failed' }, logContext)
    throw error
  }
  const filename = join(dir, 'download.xlsx')
  let sink: ReturnType<typeof createWriteStream> | undefined
  let textSink: ReturnType<typeof createWriteStream> | undefined
  let download: ReturnType<typeof createReadStream> | undefined
  let settled: Promise<void> | undefined
  let textSettled: Promise<void> | undefined
  let failure: Error | undefined
  let rows = 0
  let characters = 0
  const cleanup = () => {
    event.node?.res?.off('close', abort)
    try {
      rmSync(dir, { recursive: true, force: true })
      appLog({ module: 'sme-roster', source: 'export', operation: operation + '.cleanup', outcome: 'success' }, logContext)
    } catch (error) {
      appLog({ module: 'sme-roster', source: 'export', operation: operation + '.cleanup', outcome: 'failure', level: 'error', errorCode: 'legacy_cleanup_failed' }, logContext)
      throw error
    }
  }
  const abort = () => {
    if (event.node?.res?.writableFinished) return
    disconnected = true
    recordDownload('cancelled', 'download_disconnected')
    failure ??= new Error('Export download disconnected')
    sink?.destroy(failure)
    textSink?.destroy(failure)
    // h3 waits for end/error, not close: destroy with an error to settle sendStream.
    download?.destroy(failure)
  }
  event.node?.res?.once('close', abort)
  // File close can precede socket finish when the response still has buffered
  // bytes. Keep this observer after cleanup removes the generation abort hook.
  event.node?.res?.once('close', () => { if (!event.node?.res?.writableFinished) recordDownload('cancelled', 'download_disconnected') })
  event.node?.res?.once('finish', () => { if (download) recordDownload('success') })
  try {
    sink = createWriteStream(filename, { mode: 0o600 })
    settled = finished(sink).catch((error: Error) => { failure ??= error })
    const textPath = join(dir, 'strings.xml.part')
    textSink = createWriteStream(textPath, { mode: 0o600 })
    textSettled = finished(textSink).catch((error: Error) => { failure ??= error })
    if (event.node?.res?.destroyed) abort()
    const pace: Pace = async (size) => {
      if (failure) throw failure
      characters += size
      if (++rows < 32 && characters < 32 * 1024) return
      rows = characters = 0
      // 0.20.2's Node ZIP compressor is synchronous. Yield so its output handlers
      // run, then queue a write callback behind every byte already sent to disk.
      // This bounds the producer batch even for a slow sink; waiting only at
      // workbook.commit() would allow an entire worksheet's output to queue.
      await setImmediate()
      if (failure) throw failure
      await new Promise<void>((resolve, reject) => {
        sink!.write(new Uint8Array(0), (error) => error ? reject(error) : resolve())
      })
      await new Promise<void>((resolve, reject) => {
        textSink!.write(new Uint8Array(0), (error) => error ? reject(error) : resolve())
      })
      if (failure) throw failure
    }
    const workbook = new Stream.WorkbookWriter({
      stream: sink, useSharedStrings: true, useStyles: true, trueStreaming: true,
    })
    // Documonster 0.20.2's plain-cell XML path strips forbidden XML characters
    // and normalizes CRLF. Its public shared-string hooks let this text-only
    // adapter provide lossless SpreadsheetML without retaining a string table.
    // The worksheet, styles, relationships and ZIP remain owned by Documonster.
    let stringCount = 0
    Object.defineProperty(workbook.sharedStrings, 'count', { get: () => stringCount })
    workbook.sharedStrings.add = value => {
      if (typeof value !== 'string') throw new TypeError('Legacy export columns must be text')
      const index = stringCount++
      textSink!.write(`<si><t xml:space="preserve">${textXml(value)}</t></si>`)
      return index
    }
    workbook.addSharedStrings = async () => {
      textSink!.end()
      await textSettled
      if (failure) throw failure
      if (!stringCount) return
      const packageSink = workbook.packageSink()
      const part = packageSink.open('xl/sharedStrings.xml')
      part.write(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${stringCount}">`)
      for await (const chunk of createReadStream(textPath)) {
        if (failure) throw failure
        part.write(chunk)
        await packageSink.drain()
      }
      part.write('</sst>')
      part.end()
    }
    await write(workbook, pace)
    if (failure) throw failure
    await workbook.commit()
    await settled
    if (failure) throw failure
    event.node?.res?.setHeader('content-length', statSync(filename).size)
    download = createReadStream(filename)
    download.on('error', () => recordDownload(disconnected ? 'cancelled' : 'failure', disconnected ? 'download_disconnected' : 'legacy_read_failed')) // Observe before h3 attaches.
    download.once('close', cleanup)
    appLog({ module: 'sme-roster', source: 'export', operation: operation + '.workbook', outcome: 'success', durationMs: Date.now() - startedAt }, logContext)
    return download
  } catch (error) {
    appLog({ module: 'sme-roster', source: 'export', operation: operation + '.workbook', outcome: disconnected ? 'cancelled' : 'failure', level: disconnected ? 'warn' : 'error', errorCode: disconnected ? 'download_disconnected' : 'legacy_workbook_failed' }, logContext)
    sink?.destroy()
    textSink?.destroy()
    await settled
    await textSettled
    cleanup()
    throw error
  }
}

interface ExportColumn {
  header: string
  key: string
  width: number
  wrapText?: boolean
}

/** Fixed text columns; no formula coercion or retained rows/string table. */
export function legacyExportSheet(
  workbook: Stream.WorkbookWriter,
  pace: Pace,
  name: string,
  columns: ExportColumn[],
  preamble?: string,
) {
  const sheet = workbook.addWorksheet(name)
  sheet.columns = columns.map((column) => ({
    key: column.key,
    width: column.width,
    ...(column.wrapText ? { style: { alignment: { wrapText: true, vertical: 'top' as const } } } : {}),
  }))
  if (preamble != null) Stream.commitRow(sheet.addRow([preamble]))
  Stream.commitRow(sheet.addRow(columns.map((column) => column.header)))
  return {
    async addRow(values: Record<string, string | undefined>) {
      // Preserve absent cells as absent; only the routes' explicit '' means empty text.
      const cells = columns.map((column) => values[column.key])
      Stream.commitRow(sheet.addRow(cells))
      await pace(cells.reduce((sum, value) => sum + (value?.length ?? 0), 0))
    },
  }
}
