import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { Writable } from 'node:stream'
import type { H3Event } from 'h3'
import { afterEach, expect, it, vi } from 'vitest'
import { readExportWorkbook } from './helpers/read-export-workbook'

const state = vi.hoisted(() => ({
  slow: false, failAfter: Infinity, openFailure: false,
  directories: [] as string[], peakQueued: 0, bytes: 0,
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      const directory = fs.mkdtempSync(...args)
      state.directories.push(directory)
      return directory
    },
    createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
      if (state.openFailure) throw new Error('Cannot open export sink')
      const disk = fs.createWriteStream(...args)
      disk.on('error', () => {})
      const sink = new Writable({
        highWaterMark: 4096,
        write(chunk, encoding, callback) {
          state.peakQueued = Math.max(state.peakQueued, sink.writableLength)
          state.bytes += chunk.length
          const write = () => state.bytes > state.failAfter
            ? callback(new Error('Disk full during worksheet'))
            : disk.write(chunk, encoding, callback)
          if (state.slow) setTimeout(write, 1)
          else write()
        },
        final(callback) { disk.end(callback) },
        destroy(error, callback) { disk.destroy(); callback(error) },
      })
      return sink
    },
  }
})
import { legacyExportSheet, writeLegacyXlsx } from '../server/utils/legacy-export-xlsx'

afterEach(() => {
  expect(state.directories.every((dir) => !existsSync(dir))).toBe(true)
  state.directories = []
  state.slow = state.openFailure = false
  state.failAfter = Infinity
  state.peakQueued = state.bytes = 0
})

it('preserves empty text and formula-looking text without filling absent cells', async () => {
  const download = await writeLegacyXlsx({} as H3Event, async (wb, pace) => {
    const sheet = legacyExportSheet(wb, pace, '文本', [
      { key: 'empty', header: '空文本', width: 20 },
      { key: 'absent', header: '未提供', width: 20 },
      { key: 'space', header: '空格', width: 20 },
      { key: 'identity', header: '统代', width: 20 },
    ])
    await sheet.addRow({ empty: '', space: ' ', identity: '=001234567890123456' })
  })
  const sheet = (await readExportWorkbook(download)).worksheets[0]!
  expect(sheet.getCell('A2').value).toBe('')
  expect(sheet.getCell('B2').value).toBeNull()
  expect(sheet.getCell('C2').value).toBe(' ')
  expect(sheet.getCell('D2').value).toBe('=001234567890123456')
})

it('paces a large text producer against a slow sink while preserving every row', async () => {
  state.slow = true
  const texts = Array.from({ length: 600 }, () => randomBytes(2048).toString('hex'))
  const download = await writeLegacyXlsx({} as H3Event, async (wb, pace) => {
    const sheet = legacyExportSheet(wb, pace, '压力', [{ key: 'text', header: '原文', width: 34 }])
    for (const text of texts) await sheet.addRow({ text })
  })
  const workbook = await readExportWorkbook(download)
  expect(workbook.worksheets[0]!.rowCount).toBe(601)
  for (let i = 0; i < texts.length; i++) {
    expect(workbook.worksheets[0]!.getCell(i + 2, 1).value).toBe(texts[i])
  }
  expect(state.bytes).toBeGreaterThan(1024 * 1024)
  // At most a producer batch plus fixed ZIP/deflate buffers, not a worksheet's bytes.
  expect(state.peakQueued).toBeGreaterThan(0)
  expect(state.peakQueued).toBeLessThan(256 * 1024)
})

it('removes the staging directory when the sink cannot open', async () => {
  state.openFailure = true
  await expect(writeLegacyXlsx({} as H3Event, async () => {})).rejects.toThrow('Cannot open export sink')
})

it('rejects and removes a partially serialized worksheet when the disk fills', async () => {
  state.failAfter = 100 * 1024
  let produced = 0
  await expect(writeLegacyXlsx({} as H3Event, async (wb, pace) => {
    const sheet = legacyExportSheet(wb, pace, '数据', [{ key: 'text', header: '原文', width: 34 }])
    for (; produced < 600; produced++) await sheet.addRow({ text: randomBytes(2048).toString('hex') })
  })).rejects.toThrow('Disk full during worksheet')
  expect(produced).toBeGreaterThan(0)
  expect(produced).toBeLessThan(600)
})

it('stops generation and removes the file when the response closes before headers', async () => {
  const response = Object.assign(new EventEmitter(), { writableFinished: false })
  let produced = 0
  await expect(writeLegacyXlsx({ node: { res: response } } as H3Event, async (wb, pace) => {
    const sheet = legacyExportSheet(wb, pace, '数据', [{ key: 'text', header: '原文', width: 34 }])
    for (; produced < 600; produced++) {
      if (produced === 40) response.emit('close')
      await sheet.addRow({ text: '未发送的文本' })
    }
  })).rejects.toThrow('Export download disconnected')
  expect(produced).toBe(40)
  expect(response.listenerCount('close')).toBe(0)
})
