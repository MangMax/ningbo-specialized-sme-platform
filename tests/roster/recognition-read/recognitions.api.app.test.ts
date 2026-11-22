import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { nativeAppAdapter } from '../../support/native-app'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { readExportWorkbook } from '../../support/read-workbook'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../fixtures/postgres-tables'

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
const app = nativeAppAdapter({ dir, token: 'recognition-contract-token' })

const FILE_2022 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'

let jiaId = 0
let yiId = 0

async function seed(
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
  const db = app.db
  const id = (await db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district })
    .returning({ id: schema.enterprise.id }))[0]!.id
  await db.insert(schema.rosterLegacyMember).values({ enterpriseId: id })
  const recordId = (await db
    .insert(schema.record)
    .values({ enterpriseId: id, titleCode, source: 'jxj' })
    .returning({ id: schema.record.id }))[0]!.id
  for (const e of events) {
    const eventId = (await db
      .insert(schema.recordEvent)
      .values({
        recordId,
        eventType: e.eventType,
        year: e.year,
        decidedYear: e.decidedYear === undefined ? e.year : e.decidedYear,
      })
      .returning({ id: schema.recordEvent.id }))[0]!.id
    for (const v of e.evidence ?? []) {
      await db.insert(schema.recordEvidence)
        .values({
          recordEventId: eventId,
          sourceFile: v.sourceFile,
          attachment: v.attachment ?? null,
          listNo: v.listNo ?? null,
          page: v.page ?? null,
        })
    }
  }
  return id
}

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
type RecognitionResponse = {
  rows: RecognitionRow[]
  counts: { titlePairs: number; enterprises: number; titles: Record<string, number> }
  page: number
  pageSize: number
}
type EnterpriseResponse = {
  rows: { enterpriseId: number; name: string }[]
  counts: { total: number; titlePairs: number; recognitionPairs: number }
}

function request(path: string, query: Record<string, string | string[]> = {}) {
  const params = new URLSearchParams()
  for (const [key, values] of Object.entries(query)) {
    for (const value of Array.isArray(values) ? values : [values]) params.append(key, value)
  }
  return fetch(app.url('/api/roster/' + path + '?' + params), { signal: AbortSignal.timeout(10000) })
}

async function readJson<T>(path: string, query?: Record<string, string | string[]>) {
  const response = await request(path, query)
  expect(response.status, await response.clone().text()).toBe(200)
  return response.json() as Promise<T>
}

const readRecognitions = (query?: Record<string, string | string[]>) => readJson<RecognitionResponse>('recognitions', query)
const readEnterprises = (query?: Record<string, string | string[]>) => readJson<EnterpriseResponse>('enterprises', query)
const readYears = () => readJson<{ eventYears: number[]; firstRecognitionYears: number[] }>('ledger-years')

async function readWorkbook(query?: Record<string, string | string[]>) {
  const response = await request('export', query)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  return readExportWorkbook(new Uint8Array(await response.arrayBuffer()))
}

beforeAll(async () => {
  await app.prepare()
  // 甲:2021 认定 → 2024 复核未通过 → 2025 再次获批。首次仍是 2021,出处指到 2022 年那份公布件。
  jiaId = await seed('宁波甲接口测试股份有限公司', '91330211AAAAAAA101X', '鄞州区', 'specialized_sme', [
    { eventType: 'award', year: 2021, evidence: [{ sourceFile: FILE_2022, attachment: '附件一', listNo: 74, page: 74 }] },
    { eventType: 'review', year: 2021, decidedYear: 2024 },
    { eventType: 'award', year: 2025, evidence: [{ sourceFile: 'jxj/announcement/2025/1/2025一批.pdf' }] },
  ])
  // 乙:2021 认定但没有存下来的出处 ⇒ 待确认。
  yiId = await seed('宁波乙接口测试有限公司', '91330211AAAAAAA102X', null, 'specialized_sme', [
    { eventType: 'award', year: 2021 },
  ])

  await app.start()
}, 90000)

afterAll(async () => {
  try { await app.close() } finally { rmSync(dir, { recursive: true, force: true }) }
})

describe('GET /api/roster/recognitions(契约 §7.5)', () => {
  it('不筛 = 全部;信封是 rows / counts / page / pageSize', async () => {
    const out = await readRecognitions()
    expect(Object.keys(out).sort()).toEqual(['counts', 'page', 'pageSize', 'rows'])
    expect(out.page).toBe(1)
    expect(out.pageSize).toBe(50)
    // 一行 = 一个**企业 × 称号**;甲虽然有三次事件,首次认定只有一条。
    expect(out.rows).toHaveLength(2)
    expect(out.counts.titlePairs).toBe(2)
    expect(out.counts.enterprises).toBe(2)
    expect(out.counts.titles).toMatchObject({ specialized_sme: 2 })
  })

  it('行形状 = §7.5 的五个字段 + 增量(身份、状态、待确认原因、出处、无法定年的事件)', async () => {
    const row = (await readRecognitions()).rows.find((r) => r.enterpriseId === jiaId)!
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

  it('★ 出处可回到「哪个文件、哪个附件、哪个序号」—— 不是只给一个年份数字', async () => {
    const row = (await readRecognitions()).rows.find((r) => r.enterpriseId === jiaId)!
    expect(row.evidence).toEqual([
      { sourceFile: FILE_2022, attachment: '附件一', listNo: 74, page: 74 },
    ])
    expect(row.firstEventId).not.toBeNull()
    // 出处必须挂在**首次认定那条事件**上:它在库里查得到。
    const connectionString = app.postgresUrl
    if (!connectionString) throw new Error('PostgreSQL fixture is not running')
    const client = new pg.Client({ connectionString })
    await client.connect()
    try {
      const evidence = await client.query<{ list_no: string }>('SELECT list_no FROM business.record_evidence WHERE record_event_id = $1', [row.firstEventId])
      expect(evidence.rows.map(v => v.list_no)).toEqual(['74'])
    } finally { await client.end() }
  })

  it('待确认的企业如实带出状态与原因', async () => {
    const out = await readRecognitions({ status: 'pending' })
    expect(out.rows.map((r) => r.enterpriseId)).toEqual([yiId])
    expect(out.rows[0]!.status).toBe('pending')
    expect(out.rows[0]!.pendingReason).toBe('no_evidence')
    expect(out.rows[0]!.evidence).toEqual([])
  })

  it('title / year / status 可筛,多值取或;三者之间取与', async () => {
    expect((await readRecognitions({ title: 'specialized_sme' })).rows).toHaveLength(2)
    expect((await readRecognitions({ year: '2021' })).rows).toHaveLength(2)
    expect((await readRecognitions({ year: '1999' })).rows).toHaveLength(0)
    expect((await readRecognitions({ title: 'specialized_sme', status: 'pending' })).rows.map((r) => r.enterpriseId)).toEqual([yiId])
    expect((await readRecognitions({ status: ['confirmed', 'pending'] })).rows).toHaveLength(2)
  })

  it('分页参数生效,非法值退回默认而不是报错', async () => {
    const one = await readRecognitions({ pageSize: '1' })
    expect(one.rows).toHaveLength(1)
    expect(one.counts.titlePairs).toBe(2) // 计数与筛选同口径、先于分页
    const fallback = await readRecognitions({ pageSize: 'abc', page: '0' })
    expect(fallback.page).toBe(1)
    expect(fallback.pageSize).toBe(50)
  })

  it('unknown title / status ⇒ 400(取值说不清就不猜)', async () => {
    for (const [key, value] of [['title', 'nope'], ['status', 'maybe']] as const) {
      const response = await request('recognitions', { [key]: value })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain(key)
    }
  })

})

describe('总表与导出继承首次认定筛选(筛选状态能进 URL、也被导出继承)', () => {
  it('总表认 firstYear / firstStatus,并在 counts 里给出「企业 × 称号」计数', async () => {
    const out = await readEnterprises({ firstYear: '2021' })
    expect(out.rows.map((r) => r.enterpriseId).sort()).toEqual([yiId, jiaId].sort())
    expect((await readEnterprises({ firstStatus: 'pending' })).rows.map((r) => r.enterpriseId)).toEqual([yiId])
    expect((await readEnterprises()).counts.recognitionPairs).toBe(2)
  })

  it('firstStatus 取值非法 ⇒ 400', async () => {
    const response = await request('enterprises', { firstStatus: 'sure' })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('firstStatus')
  })

  it('导出与列表同筛选:firstYear 生效,且首次认定列带出处与待确认', async () => {
    const wb = await readWorkbook({ firstYear: '2021' })
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
  })

  it('导出继承 firstStatus=pending,只导出待确认企业', async () => {
    const wb = await readWorkbook({ firstStatus: 'pending' })
    const ws = wb.worksheets[0]!
    expect(String(ws.getRow(1).getCell(1).value)).toContain('1 家企业')
    expect(ws.rowCount).toBe(3) // 说明 + 表头 + 乙企业

    const headersRow = (ws.getRow(2).values as unknown[]).map(String)
    const col = (name: string) => headersRow.indexOf(name)
    expect(String(ws.getRow(3).getCell(col('企业名称')).value)).toBe('宁波乙接口测试有限公司')
    expect(String(ws.getRow(3).getCell(col('首次认定')).value)).toContain('待确认')
    expect(String(ws.getRow(3).getCell(col('首次认定出处')).value)).toContain('待确认')
  })

  it('导出的筛选继承是**同一份**解析:非法 firstYear 不炸(与既有 year 同口径,非数字剔除)', async () => {
    const wb = await readWorkbook({ firstYear: 'abc' })
    // 全被剔除 ⇒ 等于没筛 ⇒ 两家都在。
    expect(String(wb.worksheets[0]!.getRow(1).getCell(1).value)).toContain('2 家企业')
  })

  it('台账年份选项不读取无关平台原文，保留结论年份口径', async () => {
    await app.resetBusiness()
    await app.prepare()
    await seed('年份选项合成企业', '91330211STATS00001X', null, 'specialized_sme', [
      { eventType: 'award', year: 2022, decidedYear: 2024 },
      { eventType: 'review', year: 2022, decidedYear: 2025 },
    ])
    await seedPostgresPlatformQuery(app.db, { interface: 'business_list', queryKey: 'unrelated-ledger-years', queriedAt: '2026-10-19', status: 'success', rawResponse: 'unrelated'.repeat(1000) })
    await app.start()
    expect(await readYears()).toEqual({ eventYears: [2022], firstRecognitionYears: [2024] })
  }, 90000)

  it('空库返回空的首次认定、企业列表、年份选项和导出', async () => {
    await app.resetBusiness()
    await app.start()

    const recognitions = await readRecognitions()
    expect(recognitions.rows).toEqual([])
    expect(recognitions.counts).toMatchObject({ titlePairs: 0, enterprises: 0 })

    const enterprises = await readEnterprises()
    expect(enterprises.rows).toEqual([])
    expect(enterprises.counts).toMatchObject({ total: 0, titlePairs: 0, recognitionPairs: 0 })

    expect(await readYears()).toEqual({ eventYears: [], firstRecognitionYears: [] })

    const workbook = await readWorkbook()
    expect(workbook.worksheets[0]!.rowCount).toBe(2)
    expect(String(workbook.worksheets[0]!.getRow(1).getCell(1).value)).toContain('0 家企业')
  }, 90000)
})
