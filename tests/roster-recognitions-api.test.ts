import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { FIRST_RECOGNITION_STATUS_ORDER } from '../lib/labels'
import { FIRST_RECOGNITION_STATUS_VALUES } from '../lib/roster/first-recognition'

/**
 * RL-08 —— 首次认定的**接口面**(契约 §7.5 + 增量)。
 *
 * 测的是接口契约本身:参数怎么解析(多值 / 缺省 / 非法值 400)、错误码、响应信封、
 * 以及**出处能不能回到文件 / 附件 / 序号**。业务口径已经在
 * `tests/first-recognition.test.ts`(纯函数)与 `tests/roster-recognitions.test.ts`
 * (读模型)里测过,这一层不重复,只保证 HTTP 面没把参数弄丢、没把口径改掉。
 *
 * 读接口**不鉴权**(与既有分法一致),所以用例里也不带 token。
 */

const dir = mkdtempSync(join(tmpdir(), 'spztx-recognitions-api-'))
let db = useDb({ dbPath: join(dir, 'api.db') })

const FILE_2022 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'

let jiaId = 0
let yiId = 0

function seed(
  name: string,
  uscc: string,
  district: string | null,
  titleCode: string,
  events: {
    eventType: 'award' | 'review'
    year: number | null
    decidedYear?: number | null
    evidence?: { sourceFile: string; attachment?: string | null; listNo?: number | null; page?: number | null }[]
  }[],
) {
  const id = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district })
    .returning({ id: schema.enterprise.id })
    .get().id
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId: id, titleCode, source: 'jxj' })
    .returning({ id: schema.record.id })
    .get().id
  for (const e of events) {
    const eventId = db
      .insert(schema.recordEvent)
      .values({
        recordId,
        eventType: e.eventType,
        year: e.year,
        decidedYear: e.decidedYear === undefined ? e.year : e.decidedYear,
      })
      .returning({ id: schema.recordEvent.id })
      .get().id
    for (const v of e.evidence ?? []) {
      db.insert(schema.recordEvidence)
        .values({
          recordEventId: eventId,
          sourceFile: v.sourceFile,
          attachment: v.attachment ?? null,
          listNo: v.listNo ?? null,
          page: v.page ?? null,
        })
        .run()
    }
  }
  return id
}

let query: Record<string, unknown> = {}
let headers: Record<string, string> = {}

type RecognitionRow = {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  firstYear: number | null
  firstEventId: number | null
  source: string | null
  status: string
  pendingReason: string | null
  evidence: { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[]
  undatedAwardIds: number[]
}
let handlerRecognitions: (event: unknown) => {
  rows: RecognitionRow[]
  counts: { titlePairs: number; enterprises: number; titles: Record<string, number> }
  page: number
  pageSize: number
}
let handlerEnterprises: (event: unknown) => {
  rows: { enterpriseId: number; name: string; firstRecognition: { titleCode: string; year: number | null; status: string }[] }[]
  counts: { total: number; titlePairs: number; recognitionPairs: number }
}
let handlerExport: (event: unknown) => Promise<Uint8Array>
let handlerStats: (event: unknown) => {
  byYear: { key: string; n: number }[]
  byFirstRecognitionYear: { key: string; n: number }[]
}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('defineRouteMeta', () => undefined)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('setHeader', (_event: unknown, name: string, value: string) => {
    headers[name] = value
  })
  vi.stubGlobal('createError', (opts: { statusMessage?: string; statusCode?: number }) =>
    Object.assign(new Error(opts.statusMessage ?? 'Bad request'), opts),
  )
  vi.doMock('@db', () => ({ useDb: () => db }))

  // 甲:2021 认定 → 2024 复核未通过 → 2025 再次获批。首次仍是 2021,出处指到 2022 年那份公布件。
  jiaId = seed('宁波甲接口测试股份有限公司', '91330211AAAAAAA101X', '鄞州区', 'specialized_sme', [
    { eventType: 'award', year: 2021, evidence: [{ sourceFile: FILE_2022, attachment: '附件一', listNo: 74, page: 74 }] },
    { eventType: 'review', year: 2021, decidedYear: 2024 },
    { eventType: 'award', year: 2025, evidence: [{ sourceFile: 'jxj/announcement/2025/1/2025一批.pdf' }] },
  ])
  // 乙:2021 认定但没有存下来的出处 ⇒ 待确认。
  yiId = seed('宁波乙接口测试有限公司', '91330211AAAAAAA102X', null, 'specialized_sme', [
    { eventType: 'award', year: 2021 },
  ])

  handlerRecognitions = (await import('../server/api/roster/recognitions.get')).default as unknown as typeof handlerRecognitions
  handlerEnterprises = (await import('../server/api/roster/enterprises.get')).default as unknown as typeof handlerEnterprises
  handlerExport = (await import('../server/api/roster/export.get')).default as unknown as typeof handlerExport
  handlerStats = (await import('../server/api/stats.get')).default as unknown as typeof handlerStats
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('GET /api/roster/recognitions(契约 §7.5)', () => {
  it('不筛 = 全部;信封是 rows / counts / page / pageSize', () => {
    query = {}
    const out = handlerRecognitions({})
    expect(Object.keys(out).sort()).toEqual(['counts', 'page', 'pageSize', 'rows'])
    expect(out.page).toBe(1)
    expect(out.pageSize).toBe(50)
    // 一行 = 一个**企业 × 称号**;甲虽然有三次事件,首次认定只有一条。
    expect(out.rows).toHaveLength(2)
    expect(out.counts.titlePairs).toBe(2)
    expect(out.counts.enterprises).toBe(2)
    expect(out.counts.titles).toMatchObject({ specialized_sme: 2 })
  })

  it('行形状 = §7.5 的五个字段 + 增量(身份、状态、待确认原因、出处、无法定年的事件)', () => {
    query = {}
    const row = handlerRecognitions({}).rows.find((r) => r.enterpriseId === jiaId)!
    expect(Object.keys(row).sort()).toEqual([
      'district',
      'enterpriseId',
      'evidence',
      'firstEventId',
      'firstYear',
      'name',
      'pendingReason',
      'source',
      'status',
      'titleCode',
      'undatedAwardIds',
      'uscc',
    ])
    expect(row.name).toBe('宁波甲接口测试股份有限公司')
    expect(row.uscc).toBe('91330211AAAAAAA101X')
    expect(row.district).toBe('鄞州区')
    expect(row.titleCode).toBe('specialized_sme')
    expect(row.firstYear).toBe(2021)
    expect(row.source).toBe('jxj')
    expect(row.status).toBe('confirmed')
    expect(row.pendingReason).toBeNull()
    expect(row.undatedAwardIds).toEqual([])
  })

  it('★ 出处可回到「哪个文件、哪个附件、哪个序号」—— 不是只给一个年份数字', () => {
    query = {}
    const row = handlerRecognitions({}).rows.find((r) => r.enterpriseId === jiaId)!
    expect(row.evidence).toEqual([
      { sourceFile: FILE_2022, attachment: '附件一', listNo: 74, page: 74 },
    ])
    expect(row.firstEventId).not.toBeNull()
    // 出处必须挂在**首次认定那条事件**上:它在库里查得到。
    const evidence = db
      .select()
      .from(schema.recordEvidence)
      .all()
      .filter((v) => v.recordEventId === row.firstEventId)
    expect(evidence.map((v) => v.listNo)).toEqual([74])
  })

  it('待确认的企业如实带出状态与原因', () => {
    query = { status: 'pending' }
    const out = handlerRecognitions({})
    expect(out.rows.map((r) => r.enterpriseId)).toEqual([yiId])
    expect(out.rows[0]!.status).toBe('pending')
    expect(out.rows[0]!.pendingReason).toBe('no_evidence')
    expect(out.rows[0]!.evidence).toEqual([])
    query = {}
  })

  it('title / year / status 可筛,多值取或;三者之间取与', () => {
    query = { title: 'specialized_sme' }
    expect(handlerRecognitions({}).rows).toHaveLength(2)
    query = { year: '2021' }
    expect(handlerRecognitions({}).rows).toHaveLength(2)
    query = { year: '1999' }
    expect(handlerRecognitions({}).rows).toHaveLength(0)
    query = { title: 'specialized_sme', status: 'pending' }
    expect(handlerRecognitions({}).rows.map((r) => r.enterpriseId)).toEqual([yiId])
    query = { status: ['confirmed', 'pending'] }
    expect(handlerRecognitions({}).rows).toHaveLength(2)
    query = {}
  })

  it('分页参数生效,非法值退回默认而不是报错', () => {
    query = { pageSize: '1' }
    const one = handlerRecognitions({})
    expect(one.rows).toHaveLength(1)
    expect(one.counts.titlePairs).toBe(2) // 计数与筛选同口径、先于分页
    query = { pageSize: 'abc', page: '0' }
    const fallback = handlerRecognitions({})
    expect(fallback.page).toBe(1)
    expect(fallback.pageSize).toBe(50)
    query = {}
  })

  it('unknown title / status ⇒ 400(取值说不清就不猜)', () => {
    query = { title: 'nope' }
    expect(() => handlerRecognitions({})).toThrowError(/title/)
    query = { status: 'maybe' }
    expect(() => handlerRecognitions({})).toThrowError(/status/)
    query = {}
  })

  it('路由文件带顶层 defineRouteMeta(OpenAPI 的唯一输入)', () => {
    const source = readFileSync(
      join(process.cwd(), 'server/api/roster/recognitions.get.ts'),
      'utf8',
    )
    expect(source).toContain('defineRouteMeta({')
    expect(/^defineRouteMeta\(/m.test(source)).toBe(true)
  })
})

describe('总表与导出继承首次认定筛选(筛选状态能进 URL、也被导出继承)', () => {
  it('总表认 firstYear / firstStatus,并在 counts 里给出「企业 × 称号」计数', async () => {
    query = { firstYear: '2021' }
    const out = (await handlerEnterprises({}))
    expect(out.rows.map((r) => r.enterpriseId).sort()).toEqual([yiId, jiaId].sort())
    query = { firstStatus: 'pending' }
    expect((await handlerEnterprises({})).rows.map((r) => r.enterpriseId)).toEqual([yiId])
    query = {}
    expect((await handlerEnterprises({})).counts.recognitionPairs).toBe(2)
  })

  it('firstStatus 取值非法 ⇒ 400', () => {
    query = { firstStatus: 'sure' }
    expect(() => handlerEnterprises({})).toThrowError(/firstStatus/)
    query = {}
  })

  it('导出与列表同筛选:firstYear 生效,且首次认定列带出处与待确认', async () => {
    query = { firstYear: '2021' }
    headers = {}
    const bytes = await handlerExport({})
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes) as never)
    const ws = wb.worksheets[0]!
    expect(String(ws.getRow(1).getCell(1).value)).toContain('2 家企业')
    // 列按下标找,不写死:表头改了列序,这条用例不该跟着假红。
    const headersRow = (ws.getRow(2).values as unknown[]).map(String)
    const col = (name: string) => headersRow.indexOf(name)
    expect(col('首次认定出处')).toBeGreaterThan(0)
    expect(ws.rowCount).toBe(4) // 说明 + 表头 + 2 家企业
    const cells = [3, 4].map((r) => String(ws.getRow(r).getCell(col('首次认定出处')).value))
    // 出处列写出文件 / 附件 / 序号;没有出处的那家写明「待确认」而不是留白。
    const text = cells.join('\n')
    expect(text).toContain(FILE_2022)
    expect(text).toContain('附件一')
    expect(text).toContain('序号 74')
    expect(text).toContain('待确认')
    query = {}
  })

  it('导出继承 firstStatus=pending,只导出待确认企业', async () => {
    query = { firstStatus: 'pending' }
    const bytes = await handlerExport({})
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes) as never)
    const ws = wb.worksheets[0]!
    expect(String(ws.getRow(1).getCell(1).value)).toContain('1 家企业')
    expect(ws.rowCount).toBe(3) // 说明 + 表头 + 乙企业

    const headersRow = (ws.getRow(2).values as unknown[]).map(String)
    const col = (name: string) => headersRow.indexOf(name)
    expect(String(ws.getRow(3).getCell(col('企业名称')).value)).toBe('宁波乙接口测试有限公司')
    expect(String(ws.getRow(3).getCell(col('首次认定')).value)).toContain('待确认')
    expect(String(ws.getRow(3).getCell(col('首次认定出处')).value)).toContain('待确认')
    query = {}
  })

  it('导出的筛选继承是**同一份**解析:非法 firstYear 不炸(与既有 year 同口径,非数字剔除)', async () => {
    query = { firstYear: 'abc' }
    headers = {}
    const bytes = await handlerExport({})
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes) as never)
    // 全被剔除 ⇒ 等于没筛 ⇒ 两家都在。
    expect(String(wb.worksheets[0]!.getRow(1).getCell(1).value)).toContain('2 家企业')
    query = {}
  })

  it('仅有 decidedYear 的 award 可在首次年份选项中选择,列表和导出按同一 firstYear 语义返回', async () => {
    const previousDb = db
    try {
      db = useDb({ dbPath: join(dir, 'decided-year-only.db') })
      const decidedYearOnlyId = seed('宁波仅结论年份接口测试有限公司', '91330211AAAAAAA103X', null, 'specialized_sme', [
        {
          eventType: 'award',
          year: null,
          decidedYear: 2024,
          evidence: [
            {
              sourceFile:
                'jxj/announcement/2024/2/甬经信中小〔2024〕192号关于公布2024年第二批认定及2021年第二批到期复核通过宁波市“专精特新”中小企业名单的通知.pdf',
              attachment: '附件一',
              listNo: 3,
            },
          ],
        },
      ])

      const stats = handlerStats({})
      expect(stats.byYear.some((bucket) => bucket.key === '2024')).toBe(false)
      expect(stats.byFirstRecognitionYear).toEqual([{ key: '2024', n: 1 }])

      query = { firstYear: '2024' }
      expect((await handlerEnterprises({})).rows.map((row) => row.enterpriseId)).toEqual([decidedYearOnlyId])

      const bytes = await handlerExport({})
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(Buffer.from(bytes) as never)
      const worksheet = workbook.worksheets[0]!
      expect(String(worksheet.getRow(1).getCell(1).value)).toContain('1 家企业')
      expect(worksheet.rowCount).toBe(3) // 说明 + 表头 + 该企业
      expect(String(worksheet.getRow(3).getCell(1).value)).toContain('宁波仅结论年份接口测试有限公司')

      const pageSource = readFileSync(join(process.cwd(), 'pages/index.vue'), 'utf8')
      expect(pageSource).toContain('yearStats.value?.byFirstRecognitionYear')
      expect(pageSource).toContain('yearStats.value?.byYear')
      expect(pageSource).toContain(':options="firstYearOptions"')
      expect(pageSource).toContain(':options="yearOptions"')
    } finally {
      db = previousDb
      query = {}
    }
  })

  it('空库返回空的首次认定、企业列表、统计桶和导出', async () => {
    const previousDb = db
    try {
      db = useDb({ dbPath: join(dir, 'empty.db') })
      query = {}

      const recognitions = handlerRecognitions({})
      expect(recognitions.rows).toEqual([])
      expect(recognitions.counts).toMatchObject({ titlePairs: 0, enterprises: 0 })

      const enterprises = (await handlerEnterprises({}))
      expect(enterprises.rows).toEqual([])
      expect(enterprises.counts).toMatchObject({ total: 0, titlePairs: 0, recognitionPairs: 0 })

      const stats = handlerStats({})
      expect(stats.byYear).toEqual([])
      expect(stats.byFirstRecognitionYear).toEqual([])

      const bytes = await handlerExport({})
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(Buffer.from(bytes) as never)
      expect(workbook.worksheets[0]!.rowCount).toBe(2) // 说明 + 表头,无数据行
      expect(String(workbook.worksheets[0]!.getRow(1).getCell(1).value)).toContain('0 家企业')
    } finally {
      db = previousDb
      query = {}
    }
  })

  it('企业总表和详情 OpenAPI 描述首次认定筛选、计数单位、recognitions 与状态枚举', () => {
    const listSource = readFileSync(join(process.cwd(), 'server/api/roster/enterprises.get.ts'), 'utf8')
    const detailSource = readFileSync(join(process.cwd(), 'server/api/roster/enterprises/[id].get.ts'), 'utf8')
    const recognitionsSource = readFileSync(join(process.cwd(), 'server/api/roster/recognitions.get.ts'), 'utf8')

    expect(listSource).toContain("name: 'firstYear'")
    expect(listSource).toContain("name: 'firstStatus'")
    expect(listSource).toContain("enum: ['confirmed', 'pending']")
    expect(listSource).toContain('counts.total')
    expect(listSource).toContain('counts.titlePairs')
    expect(listSource).toContain('counts.recognitionPairs')
    expect(listSource).toContain('counts.titles')
    expect(listSource).toContain('企业数')
    expect(listSource).toContain('企业 × 称号')
    expect(detailSource).toContain('recognitions')
    expect(detailSource).toContain('confirmed')
    expect(detailSource).toContain('pending')
    expect(recognitionsSource).toContain("enum: ['confirmed', 'pending']")
    expect(FIRST_RECOGNITION_STATUS_VALUES).toEqual(['confirmed', 'pending'])
    expect(FIRST_RECOGNITION_STATUS_ORDER).toEqual(['confirmed', 'pending'])
    expect(FIRST_RECOGNITION_STATUS_VALUES).toEqual(['confirmed', 'pending'])
  })
})
