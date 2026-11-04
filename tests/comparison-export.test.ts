import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { readExportWorkbook } from './helpers/read-export-workbook'
import { Readable } from 'node:stream'
import { createServer, type Server } from 'node:http'
import { createApp, toNodeListener, getQuery as h3Query, setHeader as h3Header, createError as h3Error } from 'h3'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ReadStream } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'spztx-comparison-export-'))
const db = useDb({ dbPath: join(dir, 'test.db') })
vi.doMock('@db', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDb: () => db,
}))
let server: Server
let baseUrl: string
let query: Record<string, unknown>
let headers: Record<string, string> = {}
let handler: (event: unknown) => Promise<Uint8Array | Readable>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', (event: Parameters<typeof h3Query>[0]) => event.node ? h3Query(event) : query)
  vi.stubGlobal('setHeader', (_event: unknown, name: string, value: string) => {
    headers[name] = value
    if ((_event as Parameters<typeof h3Header>[0]).node) h3Header(_event as Parameters<typeof h3Header>[0], name, value)
  })
  vi.stubGlobal('createError', h3Error)
  vi.stubGlobal('useRuntimeConfig', () => ({
    curatedPath: join(dir, 'curation.json'),
    reconcilePath: join(dir, 'reconcile.json'),
  }))
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
    return enterpriseId
  }
  // 超过一页,验证导出未被页面参数截断;其他称号与反方向必须被排除。
  for (let i = 0; i < 27; i++)
    seed(
      `市专${String(i).padStart(2, '0')}`,
      'jxj',
      'specialized_sme',
      i ? `USCC${i}` : null,
    )
  seed('反方向', 'miit', 'specialized_sme', '=001234567890123456')
  seed('其他称号', 'jxj', 'innovative_sme', 'INNOVATIVE')
  const textEnterprise = seed('=宁波文本\n企业', 'jxj', 'little_giant', '001234567890123456')
  for (const source of ['jxj', 'miit'] as const) {
    const recordId = db.insert(schema.record).values({
      enterpriseId: textEnterprise, source, titleCode: 'specialized_sme', district: '鄞州区',
    }).returning({ id: schema.record.id }).get().id
    const eventId = db.insert(schema.recordEvent).values({
      recordId, eventType: source === 'jxj' ? 'award' : 'maintain',
      year: source === 'jxj' ? 2024 : 2025, batchSeq: 1,
    }).returning({ id: schema.recordEvent.id }).get().id
    db.insert(schema.recordEvidence).values({ recordEventId: eventId, sourceFile: `${source}-出处.docx`, attachment: '附件一', listNo: 7 }).run()
  }
  const app = createApp()
  app.use('/api/export', handler as never)
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

async function exported(params: Record<string, unknown>) {
  query = params
  headers = {}
  const result = await handler({})
  const bytes = result instanceof Readable ? await Array.fromAsync(result).then(Buffer.concat) : result
  const wb = await readExportWorkbook(bytes)
  return wb.worksheets[0]!
}

describe('comparison export route', () => {
  it('preserves ledger count grain and combined source event year filters over HTTP', async () => {
    const all = await fetch(`${baseUrl}/api/export?${new URLSearchParams({ q: '宁波文本', page: '9', pageSize: '1' })}`)
    const fullSheet = (await readExportWorkbook(new Uint8Array(await all.arrayBuffer()))).worksheets[0]!
    expect(all.status).toBe(200)
    expect(fullSheet.rowCount).toBe(4)
    expect(fullSheet.getCell('A1').text).toContain('共 2 行,属于 1 家企业')
    for (const source of ['source=jxj,miit', 'source=jxj&source=miit']) {
      const response = await fetch(`${baseUrl}/api/export?q=${encodeURIComponent('宁波文本')}&${source}&eventType=award&year=2024&page=9&pageSize=1`)
      expect(response.status).toBe(200)
      const sheet = (await readExportWorkbook(new Uint8Array(await response.arrayBuffer()))).worksheets[0]!
      expect(sheet.rowCount).toBe(3)
      expect(sheet.getCell('D3').value).toBe('专精特新中小企业')
      expect(sheet.getCell('E3').value).toBe('经信局、工信部')
      expect(sheet.getCell('F3').text).toContain('认定 2024-1')
      expect(sheet.getCell('F3').text).toContain('维护 2025-1')
      expect(sheet.getCell('G3').text).toContain('jxj-出处.docx')
      expect(sheet.getCell('G3').text).toContain('miit-出处.docx')
    }
  })
  it('returns a download stream instead of a whole-workbook response buffer', async () => {
    query = { mode: 'comparison', title: 'specialized_sme', direction: 'missing_in_miit' }
    headers = {}
    const download = await handler({})
    expect(download).toBeInstanceOf(Readable)
    const folder = dirname(String((download as ReadStream).path))
    expect(existsSync(folder)).toBe(true)
    if (download instanceof Readable) {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.read(download)
      expect(wb.worksheets[0]!.rowCount).toBe(28)
    }
    expect(existsSync(folder)).toBe(false)
  })

  it('serves actual HTTP XLSX bytes and preserves both directions filters empty sets and errors', async () => {
    for (const [search, count, first, label] of [
      ['direction=missing_in_miit&page=2&pageSize=1', 28, '市专00', '应纳未纳'],
      ['direction=extra_in_miit', 2, '反方向', '应出未出'],
      ['direction=missing_in_miit&q=市专02&district=鄞州区', 2, '市专02', '应纳未纳'],
      ['direction=missing_in_miit&q=市专02&district=海曙区', 1, undefined, '应纳未纳'],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/export?mode=comparison&title=specialized_sme&${encodeURI(search)}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="roster.xlsx"; filename*=UTF-8''${encodeURIComponent(`专精特新中小企业-${label}.xlsx`)}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      expect(Number(response.headers.get('content-length'))).toBe(bytes.byteLength)
      expect([...bytes.slice(0, 4)]).toEqual([80, 75, 3, 4])
      const wb = await readExportWorkbook(bytes)
      const ws = wb.worksheets[0]!
      expect(ws.name).toBe('比对')
      expect(ws.rowCount).toBe(count)
      expect(ws.getColumn(1).width).toBe(34)
      if (first) {
        expect(ws.getCell('A2').value).toBe(first)
        expect(ws.getCell('A2').type).toBe(ExcelJS.ValueType.String)
        expect(ws.getCell('E2').value).toBe(label)
      }
    }
    const invalid = await fetch(`${baseUrl}/api/export?mode=comparison&title=specialized_sme&direction=extra_in_miit&showCurated=bad`)
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).statusMessage).toBe('showCurated must be true or false')
    expect(invalid.headers.get('content-disposition')).toBeNull()
  })

  it('preserves formula-looking names newlines leading-zero identity and ledger count grain over HTTP', async () => {
    const response = await fetch(`${baseUrl}/api/export?title=little_giant&page=3&pageSize=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="roster.xlsx"; filename*=UTF-8''roster.xlsx`)
    const wb = await readExportWorkbook(new Uint8Array(await response.arrayBuffer()))
    const ws = wb.worksheets[0]!
    expect(ws.name).toBe('台账')
    expect(ws.rowCount).toBe(3)
    expect(ws.getCell('A1').text).toContain('共 1 行,属于 1 家企业')
    expect(ws.getRow(3).values).toEqual([undefined, '=宁波文本\n企业', '001234567890123456', '鄞州区', '专精特新“小巨人”', '经信局', '', ''])
    expect(ws.getCell('A3').type).toBe(ExcelJS.ValueType.String)
    expect(ws.getCell('B3').type).toBe(ExcelJS.ValueType.String)
    const empty = await fetch(`${baseUrl}/api/export?title=little_giant&q=不存在`)
    const emptySheet = (await readExportWorkbook(new Uint8Array(await empty.arrayBuffer()))).worksheets[0]!
    expect(emptySheet.rowCount).toBe(2)
    expect(emptySheet.getCell('A1').text).toContain('共 0 行,属于 0 家企业')
  })

  it('removes the staged workbook when a download is abandoned', async () => {
    query = { title: 'innovative_sme' }
    headers = {}
    const download = await handler({}) as ReadStream
    const folder = dirname(String(download.path))
    expect(existsSync(folder)).toBe(true)
    const closed = new Promise<void>((resolve) => download.once('close', resolve))
    download.destroy()
    await closed
    expect(existsSync(folder)).toBe(false)
  })
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
    expect(ws.getCell('B2').value).toBe('=001234567890123456')
    expect(ws.getCell('B2').type).toBe(ExcelJS.ValueType.String)
  })
  it('keeps the existing ledger export available without mode', async () => {
    const ws = await exported({ title: 'innovative_sme' })
    expect(ws.name).toBe('台账')

    // RL-17 给这条导出补了一行**口径**(导出的文件常被单独转发):第 1 行是口径说明,
    // 第 2 行才是表头,数据从第 3 行开始 —— 所以原来断言的「rowCount 2 / 第 2 行是数据」
    // 都往后挪一行,并顺手把口径内容也钉住(它说的正是合并台账的两个口径)。
    expect(ws.rowCount).toBe(3)
    const unit = String(ws.getRow(1).getCell(1).value)
    expect(unit).toContain('一行 = 一个「企业 × 称号」')
    expect(unit).toContain('共 1 行')
    expect(unit).toContain('属于 1 家企业')
    expect(unit).toContain('不受页面分页限制')

    expect(ws.getRow(2).getCell(1).value).toBe('企业名称')
    expect(ws.getRow(3).getCell(1).value).toBe('其他称号')
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


it('473 downloaded comparison workbook shadow preserves columns rows title distribution and notes', async () => {
  const { ensurePlatformObservation } = await import('../server/utils/platform-business-record')
  const owner = db.select().from(schema.enterprise).all().find(e => e.name === '市专01')!
  for (const [index, source] of (['apply_list', 'business_list', 'recognized_list'] as const).entries()) {
    const query = db.insert(schema.platformQuery).values({ interface: source, queryKey: owner.usccNorm!, rdjb: '2', queriedAt: '2026-11-01', status: 'success' }).returning().get()
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: `473-export-${index}`, enterpriseId: owner.id, nameRaw: owner.name, usccRaw: owner.usccNorm,
      rawFields: { id: `473-export-${index}`, qymc: owner.name, tyshxydm: owner.usccNorm, cszt: '终审通过' } }).returning().get()
    expect(ensurePlatformObservation(db, relation.id).versionId).toEqual(expect.any(Number))
  }
  // Same archived rename/migration decisions in both modes. The existing export
  // writes only the no-USCC note; it does not render disposition notes.
  for (const [name, reasonCode, measureCode] of [
    ['市专01', 'renamed', 'update_current_name'],
    ['市专02', 'moved_in', 'record_moved_in'],
  ] as const) {
    const enterprise = db.select().from(schema.enterprise).all().find(e => e.name === name)!
    db.insert(schema.enterpriseAlias).values({ enterpriseId: enterprise.id, name: `${name}旧名`, nameNorm: `${name}旧名`, sourceKind: 'manual', verificationStatus: 'confirmed' }).run()
    db.insert(schema.differenceReason).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode, measureCode,
      reasonNote: '已核验更名或迁入', movedInCity: reasonCode === 'moved_in' ? '杭州市' : null, movedInYear: reasonCode === 'moved_in' ? 2024 : null, recordedAt: '2026-11-02', verificationStatus: 'confirmed' }).run()
  }
  const matrices: unknown[] = []
  try {
    for (const source of ['legacy', 'typed']) {
      vi.stubEnv('ROSTER_COMPARISON_TYPED_READ', source)
      const response = await fetch(`${baseUrl}/api/export?mode=comparison&title=specialized_sme&direction=missing_in_miit`)
      expect(response.status).toBe(200)
      const workbook = await readExportWorkbook(new Uint8Array(await response.arrayBuffer()))
      const sheet = workbook.worksheets[0]!
      expect(sheet.getCell('A3').value).toBe('市专01')
      expect(sheet.getCell('A4').value).toBe('市专02')
      expect(sheet.getCell('H3').text).toBe('')
      expect(sheet.getCell('H4').text).toBe('')
      expect(sheet.getCell('H2').text).toBe('无统代,另一侧无可匹配身份')
      matrices.push(workbook.worksheets.map(sheet => sheet.getSheetValues()))
    }
    expect(matrices[1]).toEqual(matrices[0])
  } finally { vi.unstubAllEnvs() }
})
