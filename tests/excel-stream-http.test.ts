import { once } from 'node:events'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createServer, get, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import { createEvent, createError, defineEventHandler, getQuery, sendStream, setHeader } from 'h3'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

const jszip = createRequire(createRequire(import.meta.url).resolve('exceljs/package.json'))('jszip')

const source = vi.hoisted(() => ({ rows: [] as object[], read: 0 }))
vi.mock('@db', () => ({ useDb: () => ({}) }))
vi.mock('../lib/query', () => ({ allRecords: () => source.rows }))

let handler: (event: ReturnType<typeof createEvent>) => Promise<unknown>

beforeAll(async () => {
  for (const [name, value] of Object.entries({ createError, createEvent, defineEventHandler, getQuery, sendStream, setHeader })) {
    vi.stubGlobal(name, value)
  }
  handler = (await import('../server/api/export.get')).default
})
afterAll(() => vi.unstubAllGlobals())

function fixture(count: number) {
  source.read = 0
  source.rows = Array.from({ length: count }, (_, i) => {
    const content = Array.from({ length: 480 }, (_, n) =>
      createHash('sha256').update(`${i}:${n}`).digest('hex')).join('')
    return {
      enterpriseId: i + 1,
      get name() { source.read++; return i === 0 ? '企业-0_x0001_' : `企业-${i}` },
      uscc: `USCC${i}`, district: '鄞州区', titleCode: 'specialized_sme',
      sources: ['jxj'], events: '认定 2024', evidence: content,
    }
  })
}

async function server() {
  const results: unknown[] = []
  const downloads: Readable[] = []
  let resolveCompleted!: (result: unknown) => void
  const completed = new Promise<unknown>(resolve => { resolveCompleted = resolve })
  const http = createServer(async (req, res) => {
    try {
      const event = createEvent(req, res)
      const result = await handler(event)
      if (result instanceof Readable) { downloads.push(result); await sendStream(event, result) }
      results.push(result)
    }
    catch (error) { results.push(error) }
    finally {
      if (!res.destroyed && !res.writableEnded) res.end()
      resolveCompleted(results[0])
    }
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  return { http, port, results, downloads, completed }
}

async function request(port: number): Promise<{ res: IncomingMessage; client: ReturnType<typeof get> }> {
  return new Promise((resolve, reject) => {
    const client = get({ hostname: '127.0.0.1', port, path: '/api/export', agent: false }, res => {
      res.pause()
      resolve({ res, client })
    })
    client.once('error', reject)
  })
}

async function waitForPausedRows(): Promise<number> {
  const deadline = Date.now() + 8_000
  let last = source.read
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    if (source.read !== last) {
      last = source.read
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= 500) {
      return last
    }
  }
  throw new Error('XLSX row production did not pause behind the HTTP consumer')
}

describe('GET /api/export transport', () => {
  it('reads back apostrophes, XML metacharacters, Chinese, emoji, newlines, and formula-looking strings unchanged', async () => {
    const name = `O'Brien & <宁波> "企" 😀\n第二行\r\n第三行`
    source.rows = [
      {
        enterpriseId: 1, name, uscc: 'USCC1', district: '鄞州区',
        titleCode: 'specialized_sme', sources: ['jxj'],
        events: '=SUM(1,2)', evidence: '+1+1',
      },
      {
        enterpriseId: 2, name: '-1+1', uscc: 'USCC2', district: '鄞州区',
        titleCode: 'specialized_sme', sources: ['jxj'],
        events: '@SUM(1,2)', evidence: '普通出处',
      },
    ]
    const { http, port } = await server()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/export`)
      expect(response.status).toBe(200)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(Buffer.from(await response.arrayBuffer()) as never)
      const row = wb.getWorksheet('台账')!.getRow(3)
      expect(row.getCell(1).value).toBe(name)
      expect(row.getCell(6).value).toBe('=SUM(1,2)')
      expect(row.getCell(6).type).toBe(ExcelJS.ValueType.String)
      expect(row.getCell(7).value).toBe('+1+1')
      expect(row.getCell(7).type).toBe(ExcelJS.ValueType.String)
      const next = wb.getWorksheet('台账')!.getRow(4)
      expect(next.getCell(1).value).toBe('-1+1')
      expect(next.getCell(1).type).toBe(ExcelJS.ValueType.String)
      expect(next.getCell(6).value).toBe('@SUM(1,2)')
      expect(next.getCell(6).type).toBe(ExcelJS.ValueType.String)
    } finally { await new Promise<void>(resolve => http.close(() => resolve())) }
  })

  it('reads back every XML 1.0 forbidden C0 control without raw forbidden worksheet XML', async () => {
    const controls = Array.from({ length: 32 }, (_, code) => code)
      .filter(code => ![9, 10, 13].includes(code))
      .map(code => String.fromCharCode(code)).join('')
    const name = `甲${controls}\t\n\r乙`
    source.rows = [{
      enterpriseId: 1, name, uscc: 'USCC1', district: '鄞州区',
      titleCode: 'specialized_sme', sources: ['jxj'], events: '', evidence: '',
    }]
    const { http, port } = await server()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/export`)
      expect(response.status).toBe(200)
      const bytes = Buffer.from(await response.arrayBuffer())
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(bytes as never)
      expect(wb.getWorksheet('台账')!.getRow(3).getCell(1).value).toBe(name)
      const zip = await jszip.loadAsync(bytes)
      const worksheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string')
      const stringXml = await zip.file('xl/sharedStrings.xml').async('string')
      expect(worksheetXml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/)
      expect(stringXml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/)
      expect(stringXml).toContain('_x0000_')
      expect(stringXml).toContain('_x001F_')
    } finally { await new Promise<void>(resolve => http.close(() => resolve())) }
  })

  it('preserves literal OOXML escape-looking text, including adjacent and mixed-case forms', async () => {
    const name = '_x0001_ _x0041_ _x005F_ _x00aF_ _x00Af_ _X0001_ _x0041__x0001_'
    source.rows = [{
      enterpriseId: 1, name, uscc: 'USCC1', district: '鄞州区',
      titleCode: 'specialized_sme', sources: ['jxj'], events: '=SUM(_x0041_)', evidence: '',
    }]
    const { http, port } = await server()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/export`)
      expect(response.status).toBe(200)
      const bytes = Buffer.from(await response.arrayBuffer())
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(bytes as never)
      const cell = wb.getWorksheet('台账')!.getRow(3).getCell(1)
      expect(cell.value).toBe(name)
      expect(cell.type).toBe(ExcelJS.ValueType.String)
      const formulaLooking = wb.getWorksheet('台账')!.getRow(3).getCell(6)
      expect(formulaLooking.value).toBe('=SUM(_x0041_)')
      expect(formulaLooking.type).toBe(ExcelJS.ValueType.String)
      const zip = await jszip.loadAsync(bytes)
      const stringXml = await zip.file('xl/sharedStrings.xml').async('string')
      expect(stringXml).toContain('_x005F_x0001_')
      expect(stringXml).toContain('_x005F_x0041_')
      expect(stringXml).toContain('_x005F_x005F_')
      expect(stringXml).toContain('_x005F_x00aF_')
    } finally { await new Promise<void>(resolve => http.close(() => resolve())) }
  })

  it('reads back XML 1.0 forbidden noncharacters and lone surrogates as text', async () => {
    const name = '甲\uFFFE\uFFFF\uD800乙\uDC00😀'
    source.rows = [{
      enterpriseId: 1, name, uscc: 'USCC1', district: '鄞州区',
      titleCode: 'specialized_sme', sources: ['jxj'], events: '', evidence: '',
    }]
    const { http, port } = await server()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/export`)
      expect(response.status).toBe(200)
      const bytes = Buffer.from(await response.arrayBuffer())
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(bytes as never)
      expect(wb.getWorksheet('台账')!.getRow(3).getCell(1).value).toBe(name)
      const zip = await jszip.loadAsync(bytes)
      const stringXml = await zip.file('xl/sharedStrings.xml').async('string')
      for (const illegal of ['\uFFFE', '\uFFFF', '\uD800', '\uDC00']) {
        expect(stringXml).not.toContain(illegal)
      }
      expect(stringXml).toContain('_xFFFE_')
      expect(stringXml).toContain('_xFFFF_')
      expect(stringXml).toContain('_xD800_')
      expect(stringXml).toContain('_xDC00_')
      expect(stringXml).toContain('😀')
    } finally { await new Promise<void>(resolve => http.close(() => resolve())) }
  })

  it('streams a staged workbook with bounded read buffering behind a paused HTTP consumer', async () => {
    fixture(500)
    const { http, port, results, downloads, completed } = await server()
    let client: ReturnType<typeof get> | undefined
    try {
      const requested = await request(port)
      client = requested.client
      const { res } = requested
      const pausedRows = await waitForPausedRows()
      expect(pausedRows).toBeGreaterThan(0)
      // Main stages the complete workbook before headers; the download itself
      // must stay bounded and its temporary file must remain owned until close.
      expect(pausedRows).toBe(source.rows.length)
      expect(downloads).toHaveLength(1)
      expect(downloads[0]!.readableLength).toBeLessThanOrEqual(64 * 1024)
      const folder = dirname(String((downloads[0] as import('node:fs').ReadStream).path))
      expect(existsSync(folder)).toBe(true)
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.resume()
      await once(res, 'end')
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(Buffer.concat(chunks) as never)
      const ws = wb.getWorksheet('台账')!
      expect(ws.rowCount).toBe(502)
      expect(ws.getRow(1).getCell(1).text).toContain('共 500 行')
      expect(ws.getRow(2).getCell(1).text).toBe('企业名称')
      expect(ws.getRow(3).getCell(1).text).toBe('企业-0_x0001_')
      expect(ws.getRow(502).getCell(1).text).toBe('企业-499')
      await completed
      expect(results).toHaveLength(1)
      await vi.waitFor(() => expect(existsSync(folder)).toBe(false))
    } finally {
      client?.destroy()
      await new Promise<void>(resolve => http.close(() => resolve()))
    }
  }, 20_000)

  it('settles a disconnected staged download and removes its owned workbook', async () => {
    fixture(500)
    const { http, port, results, downloads, completed } = await server()
    try {
      const { res, client } = await request(port)
      res.destroy()
      client.destroy()
      await completed
      expect(source.read).toBe(source.rows.length)
      expect(downloads).toHaveLength(1)
      const folder = dirname(String((downloads[0] as import('node:fs').ReadStream).path))
      await vi.waitFor(() => expect(existsSync(folder)).toBe(false))
      expect(downloads[0]!.destroyed).toBe(true)
      expect(results).toHaveLength(1)
      expect(results[0]).toBeInstanceOf(Error)
    } finally { await new Promise<void>(resolve => http.close(() => resolve())) }
  })
})
