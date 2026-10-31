import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseLittleGiantWorkbook } from '../lib/roster/little-giant-workbook'
import {
  buildLittleGiantWorkbookBuffer,
  LITTLE_GIANT_HEADERS,
  LITTLE_GIANT_SHEET_NAME,
} from './helpers/little-giant-workbook-fixture'

/**
 * RL-02 —— 经信局历年小巨人工作簿的**解析面**。
 *
 * 这一层只回答一个问题:**这份工作簿里的名单是什么**。所有断言都落在
 * 可被人核对的「源行 → 字段」上(源行号、序号、企业名、信用代码、属地、批次、年份),
 * 不碰写库、不碰 payload 形状。
 *
 * 结构事实来自 `03-RESEARCH-export-and-source-files.md` 的 B3/B5 节(已实测):
 * 单工作表、**单行表头**、数据从 **r2** 起、A:J 是名单区、K 起是杂项,
 * 且 **G 与 I 列表头都叫「联系方式」**。
 */

const sha256 = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex')

/** 三行最小可解析数据。 */
const THREE_ROWS = [
  { seq: 1, district: '镇海区', name: '宁波中意液压马达有限公司', uscc: '9133021125599246XE', batch: '第1批' },
  { seq: 2, district: '北仑区', name: '宁波菲仕技术股份有限公司', uscc: '91330206732109570E', batch: '第1批' },
  { seq: 3, district: '鄞州区', name: '宁波荣大昌办公设备有限公司', uscc: '913302127449520044', batch: '第1批' },
] as const

describe('RL-02 工作簿解析:源文件身份与表头', () => {
  it('记录源文件 SHA-256、工作表名与表个数 —— 按 index 取表(表名带遗留的 " (2)")', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(THREE_ROWS)
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.sha256).toBe(sha256(buffer))
    expect(workbook.sheetName).toBe(LITTLE_GIANT_SHEET_NAME)
    expect(workbook.sheetIndex).toBe(0)
    expect(workbook.worksheetCount).toBe(1)
  })

  it('表头只有一行,数据从第 2 行起(与工信部三张导出表的两行表头不同)', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(THREE_ROWS)
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.headerRow).toBe(1)
    expect(workbook.rows.map((row) => row.sourceRowNo)).toEqual([2, 3, 4])
    expect(workbook.rows.map((row) => row.listNo)).toEqual([1, 2, 3])
  })

  it('G 与 I 表头都叫「联系方式」,仍按列号取到属地/企业名/信用代码/批次', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(THREE_ROWS)
    const workbook = await parseLittleGiantWorkbook(buffer)

    // 先证明这份夹具真的复现了「表头撞车」这个坑。
    expect(LITTLE_GIANT_HEADERS[6]).toBe('联系方式')
    expect(LITTLE_GIANT_HEADERS[8]).toBe('联系方式')

    expect(workbook.rows[0]).toMatchObject({
      district: '镇海区',
      name: '宁波中意液压马达有限公司',
      uscc: '9133021125599246XE',
      batchLabel: '第1批',
    })
    expect(workbook.rows[1]).toMatchObject({ district: '北仑区' })
    expect(workbook.rows[2]).toMatchObject({ district: '鄞州区' })
  })

  it('字段映射记的是列号(A/B/C/D/J),不是表头名', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(THREE_ROWS)
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.fieldMapping).toEqual({
      listNo: 'A',
      district: 'B',
      name: 'C',
      uscc: 'D',
      batch: 'J',
    })
    expect(workbook.noticeColumnRange).toEqual({ from: 'A', to: 'J' })
  })
})

describe('RL-02 工作簿解析:K 列之后绝不当作名单', () => {
  it('A:J 为空、只有 K/M/N 有值的行**不进名单**,只作为空白源行交代', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer([
      { seq: 1, district: '镇海区', name: '甲有限公司', uscc: 'CODE-A', batch: '第1批' },
      // 这一行「看着像企业」,但它只出现在 K/M/N(备注栏与行业栏)—— 不是名单行。
      { extra: { K: '乙有限公司', M: '某主导产品', N: '3444', O: '液压动力机械及元件制造' } },
    ])
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.rows.map((row) => row.name)).toEqual(['甲有限公司'])
    // 源行 3 必须**有交代**:它是「A:J 全空」的空白行,不是被悄悄丢掉的行。
    expect(workbook.blankRowNumbers).toEqual([3])
    expect(workbook.rows.length + workbook.issues.filter((i) => i.severity === 'blocked').length +
      workbook.blankRowNumbers.length).toBe(workbook.dataRowCount)
  })

  it('同一行的 K 之后有值也不影响该行按 A:J 读到的字段', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer([
      {
        seq: 3,
        district: '鄞州区',
        name: '宁波荣大昌办公设备有限公司',
        uscc: '913302127449520044',
        batch: '第1批',
        extra: { K: '企业注销-2022年未通过第1批复评', M: '大型碎纸机 数码印刷机', N: 3474 },
      },
    ])
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.rows).toHaveLength(1)
    expect(workbook.rows[0]).toMatchObject({
      name: '宁波荣大昌办公设备有限公司',
      district: '鄞州区',
      batchLabel: '第1批',
    })
    // 备注与身份字段分开保存，产品等独立字段仍不进入记录。
    expect(JSON.stringify(workbook.rows)).not.toContain('大型碎纸机')
    expect(workbook.rows[0]!.remarks).toEqual({ primary: '企业注销-2022年未通过第1批复评', secondary: '' })
  })

  it('只读 A:J —— 表头与逐行原值都只到第 10 列', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer([
      { seq: 1, district: '镇海区', name: '甲有限公司', uscc: 'CODE-A', batch: '第1批', extra: { K: '备注K', R: '361匹配一级' } },
    ])
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.headers).toHaveLength(10)
    expect(workbook.headers).toEqual([
      '序号', '属地', '企业名称', '统一社会信用代码', '地址', '法人', '联系方式', '联系人', '联系方式', '批次',
    ])
  })
})

describe('RL-02 工作簿解析:每条源行都要有交代', () => {
  it('缺企业名 → 阻塞待核,不进名单,但原值留证', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer([
      { seq: 9, district: '海曙区', uscc: 'CODE-NO-NAME', batch: '第3批' },
    ])
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.rows).toEqual([])
    expect(workbook.issues).toEqual([
      {
        sourceRowNo: 2,
        listNo: 9,
        name: null,
        uscc: 'CODE-NO-NAME',
        code: 'missing_name',
        severity: 'blocked',
        message: '源行缺「企业名称」,无法归属企业',
        raw: ['9', '海曙区', '', 'CODE-NO-NAME', '', '', '', '', '', '第3批'],
      },
    ])
  })

  it('缺批次 / 批次写法认不出 → 阻塞待核(年份无从确定,不猜)', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer([
      { seq: 1, district: '海曙区', name: '缺批次公司', uscc: 'CODE-1' },
      { seq: 2, district: '海曙区', name: '中文批次公司', uscc: 'CODE-2', batch: '第第一批' },
    ])
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.rows).toEqual([])
    expect(workbook.issues.map((issue) => [issue.sourceRowNo, issue.code, issue.severity])).toEqual([
      [2, 'missing_batch', 'blocked'],
      [3, 'unknown_batch_label', 'blocked'],
    ])
    expect(workbook.issues[1]!.message).toContain('第第一批')
  })

  it('缺统一社会信用代码 → 只警示,该行**仍然进名单**(无统代企业本来就要保留)', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer([
      { seq: 74, district: '鄞州区', name: '宁波上航测绘有限公司', batch: '第2批' },
    ])
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.rows.map((row) => row.name)).toEqual(['宁波上航测绘有限公司'])
    expect(workbook.rows[0]!.uscc).toBe('')
    expect(workbook.issues).toEqual([
      {
        sourceRowNo: 2,
        listNo: 74,
        name: '宁波上航测绘有限公司',
        uscc: null,
        code: 'missing_uscc',
        severity: 'warning',
        message: '源行缺「统一社会信用代码」,企业身份按名称归一(不丢弃该行)',
        raw: ['74', '鄞州区', '宁波上航测绘有限公司', '', '', '', '', '', '', '第2批'],
      },
    ])
  })

  it('信用代码格式异常 → 只警示;归一(去空白、转大写)后仍留原值', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer([
      { seq: 1, district: '慈溪市', name: '格式异常公司', uscc: '91330282ma2abc', batch: '第4批' },
    ])
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.rows[0]).toMatchObject({ uscc: '91330282MA2ABC', usccRaw: '91330282ma2abc' })
    expect(workbook.issues.map((issue) => [issue.code, issue.severity])).toEqual([['invalid_uscc', 'warning']])
    expect(workbook.issues[0]!.message).toContain('18')
  })

  it('属地不在宁波 12 区县/2 管理区内 → 只警示(不丢行);正常属地不产生任何 issue', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer([
      { seq: 1, district: '鄞州区', name: '正常公司', uscc: '91330212MA2AB00009', batch: '第1批' },
      { seq: 2, district: '杭州市余杭区', name: '外地公司', uscc: '91330212MA2AB00002', batch: '第1批' },
      { seq: 3, district: '大榭', name: '管理区公司', uscc: '91330212MA2AB00003', batch: '第1批' },
      { seq: 4, district: '', name: '缺属地公司', uscc: '91330212MA2AB00004', batch: '第1批' },
    ])
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.rows).toHaveLength(4)
    expect(workbook.issues.map((issue) => [issue.sourceRowNo, issue.code, issue.severity])).toEqual([
      [3, 'unknown_district', 'warning'],
      [5, 'missing_district', 'warning'],
    ])
  })
})

describe('RL-02 工作簿解析:重复信用代码', () => {
  const DUPLICATE_ROWS = [
    { seq: 14, district: '镇海区', name: '宁波昌扬机械工业有限公司', uscc: '91330211316904639T', batch: '第2批' },
    { seq: 20, district: '镇海区', name: '宁波昌扬机械工业有限公司', uscc: '91330211316904639T', batch: '第6批' },
  ] as const

  it('同一信用代码跨批次出现 → 两行**都保留**,并各自带批次与年份', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(DUPLICATE_ROWS)
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.rows.map((row) => [row.sourceRowNo, row.batchSeq, row.year])).toEqual([
      [2, 2, 2020],
      [3, 6, 2024],
    ])
  })

  it('重复信用代码清单逐条列出「哪几行」,并同时给出逐行提示', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(DUPLICATE_ROWS)
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.duplicateUscc).toEqual([
      {
        uscc: '91330211316904639T',
        occurrences: [
          { sourceRowNo: 2, listNo: 14, name: '宁波昌扬机械工业有限公司', batchSeq: 2, year: 2020 },
          { sourceRowNo: 3, listNo: 20, name: '宁波昌扬机械工业有限公司', batchSeq: 6, year: 2024 },
        ],
      },
    ])
    expect(workbook.issues.map((issue) => [issue.sourceRowNo, issue.code, issue.severity])).toEqual([
      [2, 'duplicate_uscc', 'warning'],
      [3, 'duplicate_uscc', 'warning'],
    ])
  })

  it('不重复的信用代码不进重复清单', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(THREE_ROWS)
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.duplicateUscc).toEqual([])
    expect(workbook.issues).toEqual([])
  })
})

describe('RL-02 工作簿解析:批次 → 年份,以及第 8 批缺口', () => {
  it('第 1 批 = 2019 …… 第 7 批 = 2025,第 8 批 = 2026', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq, i) => ({
        seq: i + 1,
        district: '鄞州区',
        name: `第${seq}批公司`,
        uscc: `CODE-${seq}`,
        batch: `第${seq}批`,
      })),
    )
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.rows.map((row) => [row.batchSeq, row.year])).toEqual([
      [1, 2019], [2, 2020], [3, 2021], [4, 2022], [5, 2023], [6, 2024], [7, 2025], [8, 2026],
    ])
    expect(workbook.missingBatches).toEqual([])
  })

  it('来源里没有第 8 批 → 报缺口,且**不造**第 8 批的空记录', async () => {
    const buffer = await buildLittleGiantWorkbookBuffer(
      [1, 2, 3, 4, 5, 6, 7].map((seq, i) => ({
        seq: i + 1,
        district: '鄞州区',
        name: `第${seq}批公司`,
        uscc: `91330212MA2AB${String(seq).padStart(5, '0')}`,
        batch: `第${seq}批`,
      })),
    )
    const workbook = await parseLittleGiantWorkbook(buffer)

    expect(workbook.missingBatches).toEqual([8])
    expect(workbook.batchDistribution).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 })
    expect(workbook.rows.some((row) => row.year === 2026)).toBe(false)
  })
})
