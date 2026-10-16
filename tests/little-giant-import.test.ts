import { describe, expect, it } from 'vitest'
import {
  buildLittleGiantImportReport,
  buildLittleGiantImportRequest,
  LITTLE_GIANT_SOURCE_FILE,
} from '../lib/roster/little-giant-import'
import { parseLittleGiantWorkbook } from '../lib/roster/little-giant-workbook'
import { buildLittleGiantWorkbookBuffer } from './helpers/little-giant-workbook-fixture'

/**
 * RL-02 —— 把解析结果拼成**契约 §8.3 的 payload**(以及给人看的报告)。
 *
 * 这一层只回答两个问题:
 *  1. 交给 `POST /api/roster/import/commit` 的请求体长什么样(**企业去重、事件不折叠**);
 *  2. 这次导入的**重复 / 缺失 / 缺口**报告长什么样。
 *
 * 它**不**发请求 —— 「经真实 HTTP 提交」在 `tests/little-giant-import-e2e.test.ts` 里。
 */

/** 2 批 + 6 批各一次的同一家企业(与真件里的 `91330211316904639T` 同形)。 */
const DUPLICATE_ACROSS_BATCHES = [
  { seq: 14, district: '镇海区', name: '宁波昌扬机械工业有限公司', uscc: '91330211316904639T', batch: '第2批' },
  { seq: 20, district: '镇海区', name: '宁波昌扬机械工业有限公司', uscc: '91330211316904639T', batch: '第6批' },
] as const

describe('RL-02 导入请求:企业去重、批次事件不折叠', () => {
  it('同一信用代码跨批次 → 合成**一条**企业记录,但带**两条**认定事件', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer(DUPLICATE_ACROSS_BATCHES),
    )
    const { payload } = buildLittleGiantImportRequest(workbook)

    expect(payload.announcement.records).toHaveLength(1)
    const [record] = payload.announcement.records
    expect(record!.enterprise).toEqual({
      name: '宁波昌扬机械工业有限公司',
      uscc: '91330211316904639T',
      district: '镇海区',
    })
    expect(record!.titleCode).toBe('little_giant')
    expect(record!.events.map((event) => [event.batchSeq, event.year])).toEqual([
      [2, 2020],
      [6, 2024],
    ])
    expect(record!.events.map((event) => event.eventType)).toEqual(['award', 'award'])
  })

  it('不同企业各成一条记录;记录数 = 去重后的企业数', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer([
        { seq: 1, district: '镇海区', name: '甲公司', uscc: '91330211MA2AB00001', batch: '第1批' },
        { seq: 2, district: '北仑区', name: '乙公司', uscc: '91330211MA2AB00002', batch: '第3批' },
        { seq: 3, district: '北仑区', name: '乙公司', uscc: '91330211MA2AB00002', batch: '第5批' },
      ]),
    )
    const { payload } = buildLittleGiantImportRequest(workbook)

    expect(payload.announcement.records.map((record) => record.enterprise.name)).toEqual(['甲公司', '乙公司'])
    expect(payload.announcement.records.flatMap((record) => record.events)).toHaveLength(3)
  })

  it('缺信用代码的企业照样成一条记录,uscc 为 null(不因缺码丢弃)', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer([
        { seq: 74, district: '鄞州区', name: '宁波上航测绘有限公司', batch: '第2批' },
      ]),
    )
    const { payload } = buildLittleGiantImportRequest(workbook)

    expect(payload.announcement.records).toHaveLength(1)
    expect(payload.announcement.records[0]!.enterprise).toEqual({
      name: '宁波上航测绘有限公司',
      uscc: null,
      district: '鄞州区',
    })
  })

  it('被阻塞的源行**不进** payload;只有警示的行照进', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer([
        { seq: 1, district: '镇海区', name: '好公司', uscc: '91330211MA2AB00001', batch: '第1批' },
        { seq: 2, district: '镇海区', name: '缺批次公司', uscc: '91330211MA2AB00002' },
        { seq: 3, district: '', name: '缺属地的公司', uscc: '91330211MA2AB00003', batch: '第4批' },
      ]),
    )
    const { payload } = buildLittleGiantImportRequest(workbook)

    const names = payload.announcement.records.map((record) => record.enterprise.name)
    expect(names).toEqual(['好公司', '缺属地的公司'])
    // 缺批次那条既不在 payload 里,也不是被悄悄丢掉 —— 它在报告里带原因。
    expect(names).not.toContain('缺批次公司')
    expect(workbook.issues.filter((issue) => issue.severity === 'blocked')).toHaveLength(1)
  })
})

describe('RL-02 导入请求:来源证据与源文件身份', () => {
  it('每条事件带一条出处:源文件 / 附件(工作表) / 名单序号 / 页码(表格给不出页码 ⇒ null)', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer(DUPLICATE_ACROSS_BATCHES),
    )
    const { payload } = buildLittleGiantImportRequest(workbook)

    expect(payload.announcement.records[0]!.events.map((event) => event.evidence)).toEqual([
      [{ sourceFile: LITTLE_GIANT_SOURCE_FILE, attachment: '专精特新小巨人企业 (2)', listNo: 14, page: null }],
      [{ sourceFile: LITTLE_GIANT_SOURCE_FILE, attachment: '专精特新小巨人企业 (2)', listNo: 20, page: null }],
    ])
  })

  it('请求体就是契约 §8.2 的形状,幂等键由源文件内容 SHA-256 决定', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(DUPLICATE_ACROSS_BATCHES)
    const workbook = await parseLittleGiantWorkbook(buffer)
    const request = buildLittleGiantImportRequest(workbook)

    expect(request.sourceKind).toBe('announcement')
    expect(request.sourceSha256).toBe(workbook.sha256)
    expect(request.sourceIdentity).toBe(LITTLE_GIANT_SOURCE_FILE)
    expect(request.idempotencyKey).toBe(`jxj/little-giant/historical#sha256:${workbook.sha256}`)
    expect(request.payload.announcement.sourceDocument).toEqual({
      source: 'jxj',
      title: '经信局公布历年小巨人企业名单',
      docNumber: null,
    })
  })

  it('同一份文件重复构造 → 请求体**逐字相同**(同一幂等键);换内容 → 换键', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(DUPLICATE_ACROSS_BATCHES)
    const again = await parseLittleGiantWorkbook(buffer)
    const first = buildLittleGiantImportRequest(await parseLittleGiantWorkbook(buffer))
    const second = buildLittleGiantImportRequest(again)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    const changed = buildLittleGiantImportRequest(
      await parseLittleGiantWorkbook(
        await buildLittleGiantWorkbookBuffer([
          ...DUPLICATE_ACROSS_BATCHES,
          { seq: 21, district: '镇海区', name: '新公司', uscc: '91330211MA2AB00009', batch: '第7批' },
        ]),
      ),
    )
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey)
  })

  it('事件写成认定(不猜复核结论):eventType=award、reviewOutcome 留空、结论年份 = 认定年份', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer([
        { seq: 1, district: '镇海区', name: '甲公司', uscc: '91330211MA2AB00001', batch: '第5批' },
      ]),
    )
    const { payload } = buildLittleGiantImportRequest(workbook)

    expect(payload.announcement.records[0]!.events[0]).toMatchObject({
      eventType: 'award',
      year: 2023,
      batchSeq: 5,
      decidedYear: 2023,
      reviewOutcome: null,
    })
  })
})

describe('RL-02 报告:源文件身份、逐行交代、重复与缺口', () => {
  it('记下源文件 SHA-256 / 表名 / 行数 / 字段映射', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(DUPLICATE_ACROSS_BATCHES)
    const workbook = await parseLittleGiantWorkbook(buffer)
    const report = buildLittleGiantImportReport(workbook)

    expect(report.source).toEqual({
      sha256: workbook.sha256,
      sheetName: '专精特新小巨人企业 (2)',
      sheetIndex: 0,
      worksheetCount: 1,
      headerRow: 1,
      noticeColumnRange: { from: 'A', to: 'J' },
      fieldMapping: { listNo: 'A', district: 'B', name: 'C', uscc: 'D', batch: 'J' },
      sourceFile: LITTLE_GIANT_SOURCE_FILE,
    })
  })

  it('每条源行都有交代:事件 + 待核 + 空白 = 源行数', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer([
        { seq: 1, district: '镇海区', name: '甲公司', uscc: '91330211MA2AB00001', batch: '第1批' },
        // 数据中间的空行(源文件里真有这种行):不作名单,但也要有交代。
        { blank: true },
        { seq: 3, district: '镇海区', uscc: '91330211MA2AB00003', batch: '第1批' },
      ]),
    )
    const report = buildLittleGiantImportReport(workbook)

    expect(report.rowAccounting).toEqual({
      sourceRows: 3,
      events: 1,
      blocked: 1,
      blank: 1,
      reconciled: true,
    })
  })

  it('重复信用代码清单:一个码、两行、各自的批次与年份', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer(DUPLICATE_ACROSS_BATCHES),
    )
    const report = buildLittleGiantImportReport(workbook)

    expect(report.duplicates).toEqual([
      {
        uscc: '91330211316904639T',
        occurrences: [
          { sourceRowNo: 2, listNo: 14, name: '宁波昌扬机械工业有限公司', batchSeq: 2, year: 2020 },
          { sourceRowNo: 3, listNo: 20, name: '宁波昌扬机械工业有限公司', batchSeq: 6, year: 2024 },
        ],
      },
    ])
  })

  it('批次分布 + 年份映射 + **第 8 批未提供**的缺口(不造空记录)', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer([
        { seq: 1, district: '镇海区', name: '甲公司', uscc: '91330211MA2AB00001', batch: '第1批' },
        { seq: 2, district: '镇海区', name: '乙公司', uscc: '91330211MA2AB00002', batch: '第7批' },
      ]),
    )
    const report = buildLittleGiantImportReport(workbook)

    expect(report.batches.distribution).toEqual({ 1: 1, 7: 1 })
    expect(report.batches.batchYears).toEqual({ 1: 2019, 7: 2025 })
    expect(report.batches.missingBatchSeqs).toEqual([2, 3, 4, 5, 6, 8])
    expect(report.batches.notes.join(' ')).toContain('第 8 批')
    expect(report.batches.notes.join(' ')).toContain('2026')
  })

  it('无效 / 缺失字段按原因归类成清单', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer([
        { seq: 1, district: '镇海区', name: '缺码公司', batch: '第1批' },
        { seq: 2, district: '火星区', name: '怪属地公司', uscc: '91330211MA2AB00002', batch: '第1批' },
        { seq: 3, district: '镇海区', name: '坏码公司', uscc: 'ABC', batch: '第1批' },
        { seq: 4, district: '镇海区', name: '缺批公司', uscc: '91330211MA2AB00004' },
      ]),
    )
    const report = buildLittleGiantImportReport(workbook)

    expect(report.issues.byCode).toEqual({
      missing_uscc: 1,
      unknown_district: 1,
      invalid_uscc: 1,
      missing_batch: 1,
    })
    expect(report.issues.blocked.map((issue) => issue.code)).toEqual(['missing_batch'])
    expect(report.issues.warnings.map((issue) => issue.sourceRowNo)).toEqual([2, 3, 4])
  })

  it('报告里的计数与 payload 对得上', async () => {
    const workbook = await parseLittleGiantWorkbook(
      await buildLittleGiantWorkbookBuffer(DUPLICATE_ACROSS_BATCHES),
    )
    const report = buildLittleGiantImportReport(workbook)
    const { payload } = buildLittleGiantImportRequest(workbook)

    const events = payload.announcement.records.flatMap((record) => record.events)
    expect(report.totals).toEqual({
      sourceRows: 2,
      enterprises: 1,
      records: 1,
      events: 2,
      evidences: 2,
    })
    expect(events).toHaveLength(report.totals.events)
  })
})
