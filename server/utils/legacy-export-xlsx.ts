import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { setImmediate } from 'node:timers/promises'
import type { H3Event } from 'h3'
import { Stream } from 'documonster/excel'

type Pace = (characters: number) => Promise<void>

/** Stage the XLSX before sending headers, then let h3 stream the completed file.
 * The owned sink lets disk errors and disconnected requests remove partial files.
 * The query's existing row array remains; serialized workbook bytes are not collected.
 */
export async function writeLegacyXlsx(
  event: H3Event,
  write: (workbook: Stream.WorkbookWriter, pace: Pace) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'roster-export-'))
  const filename = join(dir, 'download.xlsx')
  let sink: ReturnType<typeof createWriteStream> | undefined
  let download: ReturnType<typeof createReadStream> | undefined
  let settled: Promise<void> | undefined
  let failure: Error | undefined
  let rows = 0
  let characters = 0
  const cleanup = () => {
    event.node?.res?.off('close', abort)
    rmSync(dir, { recursive: true, force: true })
  }
  const abort = () => {
    if (event.node?.res?.writableFinished) return
    failure ??= new Error('Export download disconnected')
    sink?.destroy(failure)
    // h3 waits for end/error, not close: destroy with an error to settle sendStream.
    download?.destroy(failure)
  }
  event.node?.res?.once('close', abort)
  try {
    sink = createWriteStream(filename, { mode: 0o600 })
    settled = finished(sink).catch((error: Error) => { failure ??= error })
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
      if (failure) throw failure
    }
    const workbook = new Stream.WorkbookWriter({
      stream: sink, useSharedStrings: false, useStyles: true, trueStreaming: true,
    })
    await write(workbook, pace)
    if (failure) throw failure
    await workbook.commit()
    await settled
    if (failure) throw failure
    event.node?.res?.setHeader('content-length', statSync(filename).size)
    download = createReadStream(filename)
    download.on('error', () => {}) // Also observe errors before h3 attaches its listener.
    download.once('close', cleanup)
    return download
  } catch (error) {
    sink?.destroy()
    await settled
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

/** Fixed text columns; no formula coercion, shared-string table or retained rows. */
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
