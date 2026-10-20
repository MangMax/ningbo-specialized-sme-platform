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
  const http = createServer(async (req, res) => {
    try { results.push(await handler(createEvent(req, res))) }
    catch (error) { results.push(error) }
    finally { if (!res.destroyed && !res.writableEnded) res.end() }
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  return { http, port, results }
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

describe('GET /api/export transport', () => {
  it('holds row production behind a paused consumer, then sends a complete readable XLSX', async () => {
    fixture(500)
    const { http, port, results } = await server()
    try {
      const { res } = await request(port)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(source.read).toBeLessThan(250)
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
    } finally { await new Promise<void>(resolve => http.close(() => resolve())) }
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
