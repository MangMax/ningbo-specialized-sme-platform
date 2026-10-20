import { once } from 'node:events'
import { createServer, get, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { createEvent, createError, defineEventHandler, getQuery, sendStream, setHeader } from 'h3'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

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
      get name() { source.read++; return `企业-${i}` },
      uscc: `USCC${i}`, district: '鄞州区', titleCode: 'specialized_sme',
      sources: ['jxj'], events: '认定 2024', evidence: content,
    }
  })
}

async function server() {
  const results: unknown[] = []
  let resolveCompleted!: (result: unknown) => void
  const completed = new Promise<unknown>(resolve => { resolveCompleted = resolve })
  const http = createServer(async (req, res) => {
    try { results.push(await handler(createEvent(req, res))) }
    catch (error) { results.push(error) }
    finally {
      if (!res.destroyed && !res.writableEnded) res.end()
      resolveCompleted(results[0])
    }
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  return { http, port, results, completed }
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

  it.each([
    ['NUL', '\u0000'], ['C0 upper first', '\u0008'],
    ['vertical tab', '\u000b'], ['form feed', '\u000c'],
    ['C0 upper second', '\u000e'], ['unit separator', '\u001f'],
  ])('rejects XML 1.0 illegal control %s instead of silently changing the workbook', async (_label, control) => {
    source.rows = [{
      enterpriseId: 1, name: `甲${control}乙`, uscc: 'USCC1', district: '鄞州区',
      titleCode: 'specialized_sme', sources: ['jxj'], events: '', evidence: '',
    }]
    const { http, port, completed } = await server()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/export`)
      await expect(response.arrayBuffer()).rejects.toThrow()
      await expect(completed).resolves.toMatchObject({
        name: 'InvalidXmlCharacterError',
        message: expect.stringContaining(`U+${control.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`),
      })
    } finally { await new Promise<void>(resolve => http.close(() => resolve())) }
  })

  it('holds row production behind a paused consumer, then sends a complete readable XLSX', async () => {
    fixture(500)
    const { http, port, results } = await server()
    let client: ReturnType<typeof get> | undefined
    try {
      const requested = await request(port)
      client = requested.client
      const { res } = requested
      const pausedRows = await waitForPausedRows()
      expect(pausedRows).toBeGreaterThan(0)
      expect(pausedRows).toBeLessThan(source.rows.length)
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
      expect(ws.getRow(502).getCell(1).text).toBe('企业-499')
      expect(results).toHaveLength(1)
    } finally {
      client?.destroy()
      await new Promise<void>(resolve => http.close(() => resolve()))
    }
  }, 20_000)

  it('stops producing after the client disconnects during download', async () => {
    fixture(500)
    const { http, port, results } = await server()
    try {
      const { res, client } = await request(port)
      res.destroy()
      client.destroy()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(source.read).toBeLessThan(source.rows.length)
      expect(results).toHaveLength(1)
      expect((results[0] as Error).name).toBe('AbortError')
    } finally { await new Promise<void>(resolve => http.close(() => resolve())) }
  })
})
