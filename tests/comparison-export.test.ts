import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'spztx-comparison-export-'))
const db = useDb({ dbPath: join(dir, 'test.db') })
vi.doMock('@db', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDb: () => db,
}))
let query: Record<string, unknown>
let headers: Record<string, string>
let handler: (event: unknown) => Promise<Uint8Array>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('setHeader', (_event: unknown, name: string, value: string) => {
    headers[name] = value
  })
  vi.stubGlobal('createError', (opts: object) =>
    Object.assign(new Error('Bad query'), opts),
  )
  handler = (await import('../server/api/export.get'))
    .default as unknown as typeof handler
  const seed = (
    name: string,
    source: 'jxj' | 'miit',
    titleCode: string,
    usccNorm: string | null,
  ) => {
    const enterpriseId = db
      .insert(schema.enterprise)
      .values({
        name,
        nameNorm: name,
        usccNorm,
        city: '嘉兴市',
        regStatus: '注销',
      })
      .returning({ id: schema.enterprise.id })
      .get().id
    db.insert(schema.record)
      .values({ enterpriseId, source, titleCode, district: '鄞州区' })
      .run()
  }
  // 超过一页,验证导出未被页面参数截断;其他称号与反方向必须被排除。
  for (let i = 0; i < 27; i++)
    seed(
      `市专${String(i).padStart(2, '0')}`,
      'jxj',
      'specialized_sme',
      i ? `USCC${i}` : null,
    )
  seed('反方向', 'miit', 'specialized_sme', 'EXTRA')
  seed('其他称号', 'jxj', 'innovative_sme', 'INNOVATIVE')
})
afterAll(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

async function exported(params: Record<string, unknown>) {
  query = params
  headers = {}
  const bytes = await handler({})
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(bytes) as never)
  return wb.worksheets[0]!
}

describe('comparison export route', () => {
  it('exports all selected title and direction rows with eight columns and a Chinese filename', async () => {
    const ws = await exported({
      mode: 'comparison',
      title: 'specialized_sme',
      direction: 'missing_in_miit',
      page: 2,
      pageSize: 1,
    })
    expect(ws.rowCount).toBe(28)
    expect(ws.getRow(1).values).toEqual([
      undefined,
      '企业名称',
      '统一社会信用代码',
      '区县',
      '称号',
      '方向',
      '当前城市',
      '登记状态',
      '备注',
    ])
    expect(ws.getRow(2).values).toEqual([
      undefined,
      '市专00',
      '',
      '鄞州区',
      '专精特新中小企业',
      '应纳未纳',
      '嘉兴市',
      '注销',
      '无统代,另一侧无可匹配身份',
    ])
    expect(ws.getRow(28).getCell(1).value).toBe('市专26')
    expect(decodeURIComponent(headers['content-disposition']!)).toContain(
      '专精特新中小企业-应纳未纳.xlsx',
    )
  })
  it('exports only the reverse direction', async () => {
    const ws = await exported({
      mode: 'comparison',
      title: 'specialized_sme',
      direction: 'extra_in_miit',
    })
    expect(ws.rowCount).toBe(2)
    expect(ws.getRow(2).getCell(1).value).toBe('反方向')
    expect(ws.getRow(2).getCell(5).value).toBe('应出未出')
  })
  it('keeps the existing ledger export available without mode', async () => {
    const ws = await exported({ title: 'innovative_sme' })
    expect(ws.name).toBe('台账')
    expect(ws.rowCount).toBe(2)
    expect(ws.getRow(2).getCell(1).value).toBe('其他称号')
  })
  it('rejects incomplete or invalid comparison filters', async () => {
    for (const params of [
      {},
      { title: 'unknown', direction: 'missing_in_miit' },
      { title: 'specialized_sme', direction: 'unknown' },
    ]) {
      query = { mode: 'comparison', ...params }
      await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    }
  })
})
