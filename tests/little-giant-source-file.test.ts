import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildLittleGiantImportReport,
  buildLittleGiantImportRequest,
} from '../lib/roster/little-giant-import'
import { parseLittleGiantWorkbook } from '../lib/roster/little-giant-workbook'

/**
 * RL-02 —— 拿**真实源文件**跑一遍解析与报告。
 *
 * 为什么不把源文件当夹具提交进 Git:它是业务源文件(含 511 家真实企业名与信用代码),
 * brief 与 SPEC 都要求源文件不进仓库。故**路径由环境变量注入**:
 *
 * ```bash
 * RL02_LITTLE_GIANT_XLSX=/abs/path/经信局公布历年小巨人企业名单.xlsx pnpm test
 * ```
 *
 * 未设时退回本机源目录的默认位置;两者都不存在 ⇒ 整组跳过(而不是伪造一个夹具冒充「真件」)。
 *
 * 这份用例守的是**票面点名的验收**:511 条源行全部有交代、批次年份映射正确、
 * 重复信用代码只去重企业而不折叠事件、第 8 批列作缺口且不造空记录。
 */

const DEFAULT_SOURCE =
  '/Users/mang/Workfile/宁波/专精特新/20261013/经信局名单/小巨人/经信局公布历年小巨人企业名单.xlsx'

const SOURCE_PATH = process.env.RL02_LITTLE_GIANT_XLSX ?? DEFAULT_SOURCE
const AVAILABLE = existsSync(SOURCE_PATH)

if (!AVAILABLE) {
  console.warn(
    `[RL-02] 跳过真实源文件用例:找不到 ${SOURCE_PATH}。` +
      '设 RL02_LITTLE_GIANT_XLSX=<绝对路径> 后可跑。',
  )
}

describe.skipIf(!AVAILABLE)('RL-02 真实源文件:经信局公布历年小巨人企业名单.xlsx', () => {
  /** 整册只读一次,免得每组用例都重新解析 187KB 工作簿。 */
  const workbookPromise = (async () =>
    parseLittleGiantWorkbook(readFileSync(SOURCE_PATH)))()
  const buffer = AVAILABLE ? readFileSync(SOURCE_PATH) : Buffer.alloc(0)

  it('单工作表、单行表头、数据从第 2 行起 —— 且记下源文件 SHA-256', async () => {
    const workbook = await workbookPromise

    expect(workbook.worksheetCount).toBe(1)
    expect(workbook.sheetIndex).toBe(0)
    expect(workbook.sheetName).toBe('专精特新小巨人企业 (2)')
    expect(workbook.headerRow).toBe(1)
    expect(workbook.sha256).toBe(createHash('sha256').update(buffer).digest('hex'))
    expect(workbook.fieldMapping).toEqual({
      listNo: 'A', district: 'B', name: 'C', uscc: 'D', batch: 'J',
    })
  })

  it('只读 A:J —— 表头正是那 10 个,且 G 与 I 都叫「联系方式」(所以必须按列号取)', async () => {
    const workbook = await workbookPromise

    expect(workbook.headers).toEqual([
      '序号', '属地', '企业名称', '统一社会信用代码', '地址', '法人', '联系方式', '联系人', '联系方式', '批次',
    ])
    expect(workbook.headers[6]).toBe(workbook.headers[8])
  })

  it('511 条源行全部有交代:进名单 + 待核 + 空白 = 源行数', async () => {
    const workbook = await workbookPromise
    const report = buildLittleGiantImportReport(workbook)

    expect(workbook.dataRowCount).toBe(511)
    expect(workbook.rows).toHaveLength(511)
    expect(report.rowAccounting).toEqual({
      sourceRows: 511,
      events: 511,
      blocked: 0,
      blank: 0,
      reconciled: true,
    })
    expect(report.issues.blocked).toEqual([])
  })

  it('批次就是第 1–7 批;第 8 批列作缺口,不造 2026 年的空记录', async () => {
    const workbook = await workbookPromise
    const report = buildLittleGiantImportReport(workbook)

    expect(report.batches.distribution).toEqual({
      1: 5, 2: 50, 3: 127, 4: 101, 5: 69, 6: 66, 7: 93,
    })
    expect(report.batches.batchYears).toEqual({
      1: 2019, 2: 2020, 3: 2021, 4: 2022, 5: 2023, 6: 2024, 7: 2025,
    })
    expect(report.batches.missingBatchSeqs).toEqual([8])
    expect(report.batches.notes.join(' ')).toContain('第 8 批')
    expect(workbook.rows.some((row) => row.year === 2026)).toBe(false)
  })

  it('整册唯一的重复信用代码:91330211316904639T 在第 2 批与第 6 批各一次', async () => {
    const workbook = await workbookPromise
    const report = buildLittleGiantImportReport(workbook)

    expect(report.duplicates).toHaveLength(1)
    expect(report.duplicates[0]).toMatchObject({
      uscc: '91330211316904639T',
      occurrences: [
        { sourceRowNo: 15, batchSeq: 2, year: 2020, name: '宁波昌扬机械工业有限公司' },
        { sourceRowNo: 367, batchSeq: 6, year: 2024, name: '宁波昌扬机械工业有限公司' },
      ],
    })
  })

  it('去重后 510 家企业、511 条事件 —— 企业去重而批次事件一条不少', async () => {
    const workbook = await workbookPromise
    const request = buildLittleGiantImportRequest(workbook)
    const records = request.payload.announcement.records
    const events = records.flatMap((record) => record.events)

    expect(records).toHaveLength(510)
    expect(events).toHaveLength(511)
    expect(records.filter((record) => record.events.length > 1)).toEqual([
      {
        enterprise: {
          name: '宁波昌扬机械工业有限公司',
          uscc: '91330211316904639T',
          district: '镇海区',
        },
        titleCode: 'little_giant',
        events: [
          expect.objectContaining({ eventType: 'award', batchSeq: 2, year: 2020 }),
          expect.objectContaining({ eventType: 'award', batchSeq: 6, year: 2024 }),
        ],
      },
    ])
    // 每家企业一条记录,记录的身份键互不相同。
    expect(new Set(records.map((record) => record.enterprise.name)).size).toBe(510)
    // 每条事件都带出处。
    expect(events.every((event) => event.evidence.length === 1)).toBe(true)
  })

  it('报告里的合计与逐项对得上', async () => {
    const workbook = await workbookPromise
    const report = buildLittleGiantImportReport(workbook)

    expect(report.totals).toEqual({
      sourceRows: 511,
      enterprises: 510,
      records: 510,
      events: 511,
      evidences: 511,
    })
  })

  it('可把报告落成 JSON 供人工核对(RL02_REPORT_OUT=<绝对路径>)', async () => {
    const out = process.env.RL02_REPORT_OUT
    if (!out) return
    const workbook = await workbookPromise
    writeFileSync(out, JSON.stringify(buildLittleGiantImportReport(workbook), null, 2))
    console.info(`[RL-02] 报告已写到 ${out}`)
  })
})
