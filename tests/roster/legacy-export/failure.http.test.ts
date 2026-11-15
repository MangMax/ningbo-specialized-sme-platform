import { initializeDb } from '../../../db/client'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp, createError, defineEventHandler, getQuery, setHeader, toNodeListener } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useDb } from '../../../db'
import { legacyExportSheet, writeLegacyXlsx } from '../../../server/utils/legacy-export-xlsx'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging, newLogContext } from '../../../lib/logging'

const state = vi.hoisted(() => ({ fail: false, directories: [] as string[], slowRead: false, slowWrite: false, generationRows: 0, settledRequests: 0 }))
// Inject failure at the external filesystem boundary; queries and XLSX serialization stay real.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      const dir = fs.mkdtempSync(...args)
      if (String(args[0]).includes('roster-export-')) state.directories.push(String(dir))
      return dir
    },
    createReadStream: (path: Parameters<typeof fs.createReadStream>[0]) => fs.createReadStream(path, state.slowRead ? { highWaterMark: 1 } : undefined),
    createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
      if (state.fail) return new Writable({ write(_chunk, _encoding, callback) { callback(new Error('Injected disk failure')) } })
      const disk = fs.createWriteStream(...args)
      if (!state.slowWrite) return disk
      const sink = new Writable({
        write(chunk, encoding, callback) { setTimeout(() => disk.write(chunk, encoding, callback), 3) },
        final(callback) { disk.end(callback) },
        destroy(error, callback) { disk.destroy(); callback(error) },
      })
      disk.on('error', (error) => sink.destroy(error))
      return sink
    },
  }
})
const dir = mkdtempSync(join(tmpdir(), 'legacy-export-failure-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'empty.db') })
vi.doMock('@db', () => ({ useDb: () => db }))
let server: Server
let baseUrl: string
beforeAll(async () => {
  vi.stubEnv('NUXT_LOG_DIR', join(dir, 'logs'))
  initializeWorkerLogging()
  for (const [name, value] of Object.entries({ defineEventHandler, getQuery, setHeader, createError })) vi.stubGlobal(name, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ curatedPath: join(dir, 'curation.json') }))
  const app = createApp({ onRequest: event => { event.context.applicationLogContext = newLogContext(); setHeader(event, 'x-request-id', event.context.applicationLogContext.requestId) }, onError: () => { state.settledRequests++ }, onAfterResponse: () => { state.settledRequests++ } })
  app.use('/api/export', (await import('../../../server/api/export.get')).default)
  app.use('/api/roster/export', (await import('../../../server/api/roster/export.get')).default)
  // Exercise the authorized adapter input seam over real HTTP, with a slow disk.
  app.use('/synthetic-export', defineEventHandler((event) => writeLegacyXlsx(event, async (wb, pace) => {
    const sheet = legacyExportSheet(wb, pace, '数据', [{ key: 'text', header: '原文', width: 34 }])
    for (state.generationRows = 0; state.generationRows < 600; state.generationRows++) {
      await sheet.addRow({ text: randomBytes(2048).toString('hex') })
    }
  })))
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  vi.unstubAllGlobals()
  await closeApplicationLogging()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
it('returns HTTP 500 without attachment headers and removes partial files on disk failure', async () => {
  state.fail = true
  for (const route of ['/api/export', '/api/roster/export']) {
    const response = await fetch(baseUrl + route)
    expect(response.status).toBe(500)
    expect(response.headers.get('content-disposition')).toBeNull()
    expect(response.headers.get('content-type')).toContain('application/json')
    await response.arrayBuffer()
    await applicationLogs().flush()
    const requestId = response.headers.get('x-request-id')!
    const events = (await applicationLogs().list({ requestId, source: 'export' })).rows
    expect(events.filter(row => row.operation.endsWith('.workbook') && row.outcome === 'failure')).toHaveLength(1)
    expect(events.filter(row => row.operation.endsWith('.cleanup') && row.outcome === 'success')).toHaveLength(1)
    expect(events.filter(row => row.operation.endsWith('.download') && row.outcome === 'success')).toHaveLength(0)
    expect(state.directories.length).toBeGreaterThan(0)
    expect(state.directories.every((folder) => !existsSync(folder))).toBe(true)
  }
  state.fail = false
})
it('preserves validation errors without leaving staged files even when the disk fails', async () => {
  state.fail = true
  const response = await fetch(`${baseUrl}/api/export?mode=comparison`)
  expect(response.status).toBe(400)
  expect((await response.json()).statusMessage).toBe('Comparison export requires a valid title and direction')
  expect(state.directories.every((folder) => !existsSync(folder))).toBe(true)
  state.fail = false
})

it('settles an interrupted HTTP download and removes its staged workbook', async () => {
  state.slowRead = true
  const before = state.settledRequests
  const controller = new AbortController()
  try {
    const response = await fetch(baseUrl + '/api/export', { signal: controller.signal })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    controller.abort()
    await vi.waitFor(() => {
      expect(state.directories.every((folder) => !existsSync(folder))).toBe(true)
      expect(state.settledRequests).toBeGreaterThan(before)
    })
  } finally {
    controller.abort()
    state.slowRead = false
  }
})

it('settles an HTTP abort during generation and removes the partial workbook', async () => {
  state.slowWrite = true
  const before = state.settledRequests
  const controller = new AbortController()
  const request = fetch(baseUrl + '/synthetic-export', { signal: controller.signal })
  // Observe rejection immediately, including a failure before the wait completes.
  const result = request.catch((error: Error) => error)
  try {
    await vi.waitFor(() => {
      expect(state.generationRows).toBeGreaterThan(32)
      expect(state.generationRows).toBeLessThan(600)
    })
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => {
      expect(state.directories.every((folder) => !existsSync(folder))).toBe(true)
      expect(state.settledRequests).toBeGreaterThan(before)
    })
    expect(state.generationRows).toBeLessThan(600)
  } finally {
    controller.abort()
    state.slowWrite = false
  }
})
