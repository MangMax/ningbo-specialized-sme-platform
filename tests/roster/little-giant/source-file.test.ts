import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildLittleGiantImportReport } from '../../../lib/roster/little-giant-import'
import { parseLittleGiantWorkbook, type LittleGiantWorkbook } from '../../../lib/roster/little-giant-workbook'
import {
  SYNTHETIC_DUPLICATE_USCC,
  hasRealSource,
  littleGiantSourcePath,
  loadLittleGiantSource,
  type LittleGiantSource,
} from './fixtures/official-source'

/**
 * RL-02 —— 源文件的**结构与逐行交代**(解析层)。
 *
 * 源文件是业务数据、不进 Git,所以它**在不在取决于机器**。本文件按
 * `helpers/little-giant-source.ts` 的口径取源:**真件在就用真件,不在就用合成夹具**,
 * 结构 / 逐行交代 / 报告这些断言**两种源都要过**;只有真件才有的具体数字
 * (SHA-256、511 行、510 企业、r15/r367、批次分布)挂在 `hasRealSource` 上。
 *
 * ⇒ 「真件不在」时**不会整组消失**:它会退成一份结构等价的工作簿继续跑。
 *
 * 真件路径:`LITTLE_GIANT_SOURCE_XLSX=<绝对路径>` 覆盖。
 */

const source: LittleGiantSource = await loadLittleGiantSource()
const workbook: LittleGiantWorkbook = await parseLittleGiantWorkbook(source.buffer)

describe(`RL-02 源文件结构与逐行交代(${source.label})`, () => {
  it('单工作表、单行表头、数据从第 2 行起,并记下源文件 SHA-256', () => {
    expect(workbook.worksheetCount).toBe(1)
    expect(workbook.sheetIndex).toBe(0)
    expect(workbook.headerRow).toBe(1)
    expect(workbook.sha256).toBe(createHash('sha256').update(source.buffer).digest('hex'))
  })

  it('只读 A:J —— 表头正是那 10 个,且 G 与 I 都叫「联系方式」(所以必须按列号取)', () => {
    expect(workbook.headers).toEqual([
      '序号', '属地', '企业名称', '统一社会信用代码', '地址', '法人', '联系方式', '联系人', '联系方式', '批次',
    ])
    expect(workbook.headers[6]).toBe(workbook.headers[8])
    expect(workbook.fieldMapping).toEqual({
      listNo: 'A', district: 'B', name: 'C', uscc: 'D', batch: 'J',
    })
  })

  it('每条源行都有交代:进名单 + 待核 + 空白 = 源行数;两份源都零待核', () => {
    const report = buildLittleGiantImportReport(workbook)

    expect(report.rowAccounting).toEqual({
      sourceRows: workbook.dataRowCount,
      events: workbook.rows.length,
      blocked: 0,
      blank: 0,
      reconciled: true,
    })
    expect(report.issues.blocked).toEqual([])
  })

  it('批次 → 年份按 2018 + 批次序号;文件里没有的批次列作缺口,不造 2026 的空记录', () => {
    const report = buildLittleGiantImportReport(workbook)
    const observed = Object.keys(report.batches.distribution).map(Number).sort((a, b) => a - b)

    for (const seq of observed) expect(report.batches.batchYears[seq]).toBe(2018 + seq)
    expect(report.batches.missingBatchSeqs).toContain(8)
    expect(report.batches.notes.join(' ')).toContain('第 8 批')
    expect(workbook.rows.some((row) => row.year === 2026)).toBe(false)
  })

  it(`重复信用代码清单逐条列出「哪几行」(${SYNTHETIC_DUPLICATE_USCC} 第 2 批与第 6 批)`, () => {
    expect(workbook.duplicateUscc).toEqual([
      {
        uscc: SYNTHETIC_DUPLICATE_USCC,
        occurrences: [
          expect.objectContaining({ batchSeq: 2, year: 2020 }),
          expect.objectContaining({ batchSeq: 6, year: 2024 }),
        ],
      },
    ])
  })

  it('报告里的合计与 payload 对得上:企业去重、事件不折叠、每条事件一条出处', () => {
    const report = buildLittleGiantImportReport(workbook, { sourceFile: source.sourceFile })

    expect(report.totals.events).toBe(workbook.rows.length + (hasRealSource ? 28 : 0))
    expect(report.totals.evidences).toBe(workbook.rows.length + (hasRealSource ? 28 : 0))
    expect(report.totals.enterprises).toBe(
      new Set(workbook.rows.map((row) => (row.uscc === '' ? `name:${row.name}` : row.uscc))).size,
    )
    expect(report.source.sourceFile).toBe(source.sourceFile)
  })
})

describe.runIf(hasRealSource)('RL-02 真件的具体数字(仅真件在时断言)', () => {
  it(`真件就是 ${littleGiantSourcePath} 那份`, () => {
    expect(source.path).toBe(littleGiantSourcePath)
    expect(workbook.sheetName).toBe('专精特新小巨人企业 (2)')
    expect(workbook.sha256).toBe('5de6298a2a6a7e69a920b70db0e2e8d544acdc3c0a05102b6a2eff76a3323d84')
  })

  it('511 条源行全部有交代;批次就是第 1–7 批,第 8 批列作缺口', () => {
    const report = buildLittleGiantImportReport(workbook)

    expect(workbook.dataRowCount).toBe(511)
    expect(report.rowAccounting).toEqual({
      sourceRows: 511, events: 511, blocked: 0, blank: 0, reconciled: true,
    })
    expect(report.batches.distribution).toEqual({
      1: 5, 2: 50, 3: 127, 4: 101, 5: 69, 6: 66, 7: 93,
    })
    expect(report.batches.batchYears).toEqual({
      1: 2019, 2: 2020, 3: 2021, 4: 2022, 5: 2023, 6: 2024, 7: 2025,
    })
    expect(report.batches.missingBatchSeqs).toEqual([8])
  })

  it('整册唯一的重复信用代码落在 r15(第2批)与 r367(第6批);去重后 510 企业 / 511 事件', () => {
    const report = buildLittleGiantImportReport(workbook)

    expect(report.duplicates).toEqual([
      {
        uscc: '91330211316904639T',
        occurrences: [
          { sourceRowNo: 15, listNo: 14, name: '宁波昌扬机械工业有限公司', batchSeq: 2, year: 2020 },
          { sourceRowNo: 367, listNo: 366, name: '宁波昌扬机械工业有限公司', batchSeq: 6, year: 2024 },
        ],
      },
    ])
    expect(report.totals).toEqual({
      sourceRows: 511, enterprises: 510, records: 510, events: 539, evidences: 539,
    })
    expect(report.issues.byCode).toEqual({ duplicate_uscc: 2 })
  })
})
