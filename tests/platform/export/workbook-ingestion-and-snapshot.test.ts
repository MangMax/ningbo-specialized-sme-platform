/**
 * RL-05 —— 三张工信部导出表 → 年度对照快照。
 *
 * 缝(契约已定,见 `lib/roster-import-client.ts`/§1.7/§8.3):
 *   1. `splitRegistrationAddress` —— 「浙江省 宁波市 宁海县」这种**单列空格分隔**文本拆省/市/区县;
 *   2. `readPlatformExport`      —— 按**列号**(不是列名)读两行表头、数据从 r3 起,产出规范化快照行;
 *   3. `buildExportSnapshotPayload` —— 产出契约 §8.3 的 `exportSnapshot` payload(交给统一写 API)。
 *
 * 真实源文件的三张表列号各不相同(实测:统代 18/18/15、审核状态 300/271/95、
 * 维护批次 303/274/98),所以**必须按列号定位**。合成夹具也按列号构造。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { buildExportSnapshotPayload, readPlatformExport, splitRegistrationAddress } from '../../../layers/sme-roster/lib/platform-export'

// ---------------------------------------------------------------------------
// 合成夹具:按列号摆好两行表头与数据,验证「按列号读」而不是「按列名读」。
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'spztx-export-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/**
 * 造一张导出表:
 *  - r1 分组表头(故意把「统一社会信用代码」放在也会出现在别处的组名下);
 *  - r2 叶子表头(故意让**多个叶子列同名**,证明按名取列会撞车);
 *  - r3 起数据。
 */
async function writeFixture(
  filename: string,
  sheetName: string,
  layout: { uscc: number; status: number; batch: number },
  rows: Array<Record<number, string>>,
): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)
  const maxCol = Math.max(layout.uscc, layout.status, layout.batch, ...rows.flatMap((r) => Object.keys(r).map(Number)))
  // r1 分组:故意多列同名(按名取会撞车)。
  ws.getRow(1).getCell(1).value = '企业名称'
  ws.getRow(1).getCell(2).value = '企业注册地'
  for (let c = 3; c <= maxCol; c++) ws.getRow(1).getCell(c).value = '分组'
  ws.getRow(1).getCell(layout.uscc).value = '统一社会信用代码'
  ws.getRow(1).getCell(layout.status).value = '审核状态'
  ws.getRow(1).getCell(layout.batch).value = '维护批次'
  // r2 叶子:三个「备注」同名,真正的语义只在列位上。
  ws.getRow(2).getCell(1).value = '企业名称'
  ws.getRow(2).getCell(2).value = '企业注册地'
  for (let c = 3; c <= maxCol; c++) ws.getRow(2).getCell(c).value = '备注'
  ws.getRow(2).getCell(layout.uscc).value = '统一社会信用代码'
  ws.getRow(2).getCell(layout.status).value = '审核状态'
  ws.getRow(2).getCell(layout.batch).value = '维护批次'
  rows.forEach((row, i) => {
    const r = i + 3
    for (const [col, value] of Object.entries(row)) ws.getRow(r).getCell(Number(col)).value = value
  })
  const path = join(tmp, filename)
  await wb.xlsx.writeFile(path)
  return path
}

// ---------------------------------------------------------------------------

describe('splitRegistrationAddress:注册地单列文本 → 省 / 市 / 区县', () => {
  it('标准三段的省市区县按位置拆开', () => {
    expect(splitRegistrationAddress('浙江省 宁波市 宁海县')).toEqual({
      province: '浙江省',
      city: '宁波市',
      district: '宁海县',
    })
  })

  it('非标准区县名(高新区 / 前湾新区)照原样留给 district', () => {
    expect(splitRegistrationAddress('浙江省 宁波市 高新区').district).toBe('高新区')
    expect(splitRegistrationAddress('浙江省 宁波市 前湾新区').district).toBe('前湾新区')
  })

  it('多余空白(含制表符)不产生空段', () => {
    expect(splitRegistrationAddress('  浙江省\t 宁波市   宁海县 ')).toEqual({
      province: '浙江省',
      city: '宁波市',
      district: '宁海县',
    })
  })

  it('凑不齐三段时缺项留空,不猜填', () => {
    expect(splitRegistrationAddress('宁波市 宁海县')).toEqual({ province: '宁波市', city: '宁海县', district: null })
    expect(splitRegistrationAddress('宁海县')).toEqual({ province: null, city: null, district: '宁海县' })
    for (const v of [null, undefined, '', '   ']) {
      expect(splitRegistrationAddress(v as string)).toEqual({ province: null, city: null, district: null })
    }
  })
})

// ---------------------------------------------------------------------------

describe('readPlatformExport:按列号读两行表头的数据表', () => {
  // 合成一张「创新型」表:统代在 15、审核状态在 95、维护批次在 98,
  // 叶子表头里塞了会撞车的同名「备注」列。
  const LAYOUT = { uscc: 15, status: 95, batch: 98 }

  const fixture = () =>
    writeFixture('合成导出.xlsx', '创新型中小企业导出Excel', LAYOUT, [
      { 1: '甲公司', 2: '浙江省 宁波市 高新区', 15: '91330201AAAAAAA001', 95: '待审核', 98: '2026-1' },
      { 1: '乙公司', 2: '浙江省 宁波市 奉化区', 15: '91330283BBBBBBB002', 95: '省已审', 98: '2026-1' },
      { 1: '丙公司', 2: '浙江省 宁波市 前湾新区', 15: '91330283CCCCCCC003', 95: '终审通过', 98: '2026-2' },
    ])

  it('数据从第 3 行起,源行号保留;统代/审核状态/注册地都取自**列号**', async () => {
    const parsed = await readPlatformExport(await fixture(), { titleCode: 'innovative_sme' })
    expect(parsed.titleCode).toBe('innovative_sme')
    expect(parsed.headerRowCount).toBe(2)
    expect(parsed.rowCount).toBe(3)
    expect(parsed.rows.map((r) => r.sourceRowNo)).toEqual([3, 4, 5])

    expect(parsed.rows[0]).toMatchObject({
      sourceRowNo: 3,
      nameRaw: '甲公司',
      usccRaw: '91330201AAAAAAA001',
      province: '浙江省',
      city: '宁波市',
      district: '高新区',
      regStatus: '待审核',
    })
    // 审核状态来自列 95,不是列名(叶子表头里 3..N 列全叫「备注」,按名取必撞)。
    expect(parsed.rows[2]!.regStatus).toBe('终审通过')
    // rawFields 按 1-based 列号留非空值。
    expect(parsed.rows[0]!.rawFields['15']).toBe('91330201AAAAAAA001')
    expect(parsed.rows[0]!.rawFields['95']).toBe('待审核')
  })

  it('不给称号时按工作表名自动识别;识别不出直接报错,不猜', async () => {
    const path = await fixture()
    expect((await readPlatformExport(path)).titleCode).toBe('innovative_sme')

    const unknown = await writeFixture('不明导出.xlsx', '某个没见过的表', LAYOUT, [{ 1: '甲', 15: 'X' }])
    await expect(readPlatformExport(unknown)).rejects.toThrow(/无法识别/)
  })

  it('原始文件名与文件内容 SHA-256 如实记录(版本身份)', async () => {
    const path = await fixture()
    const parsed = await readPlatformExport(path, { titleCode: 'innovative_sme' })
    expect(parsed.originalFilename).toBe('合成导出.xlsx')
    const expected = createHash('sha256').update(readFileSync(path)).digest('hex')
    expect(parsed.sha256).toBe(expected)
    // 与磁盘上的真实哈希一致 —— 不是随便一个 64 位十六进制串。
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('文件不存在直接抛,空表也不静默返回空行', async () => {
    await expect(readPlatformExport(join(tmp, '不存在.xlsx'))).rejects.toThrow()
    const empty = await writeFixture('空表.xlsx', '创新型中小企业导出Excel', LAYOUT, [])
    const parsed = await readPlatformExport(empty, { titleCode: 'innovative_sme' })
    expect(parsed.rowCount).toBe(0)
    expect(parsed.rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 真实源文件(路径注入;xlsx 不入 Git)。目录可用时才跑 —— 这是「列号实测」那一层的证据。
// ---------------------------------------------------------------------------

const REAL_DIR =
  process.env.SPZTX_PLATFORM_EXPORT_DIR ?? ''
if (REAL_DIR && !existsSync(REAL_DIR)) throw new Error('SPZTX_PLATFORM_EXPORT_DIR does not exist')
const realFile = (name: string) => join(REAL_DIR, name)

/** 三张表的实测基线:数据行数 / 统代列号 / 版本哈希 / 首行抽样。 */
const REAL_BASELINE = [
  {
    file: '专精特新中小企业导出Excel.xlsx',
    titleCode: 'specialized_sme',
    rowCount: 3267,
    sha256: 'f0395b62c17590544b858cec7fee43a2d0c4744d4262b6114bf38a4c28ce6957',
    first: { nameRaw: '宁波铭辉汽车零部件有限公司', usccRaw: '91330226MA28309443', district: '宁海县', regStatus: '待审核' },
  },
  {
    file: '专精特新小巨人导出Excel.xlsx',
    titleCode: 'little_giant',
    rowCount: 481,
    sha256: 'bafaed4587aabc9aee7fabc6c314e4f40deda18e3a75733b4848466db78285a3',
    first: { nameRaw: '宁波菲仕技术股份有限公司', usccRaw: '91330206732109570E', district: '北仑区', regStatus: '待审核' },
  },
  {
    file: '创新型中小企业导出Excel.xlsx',
    titleCode: 'innovative_sme',
    rowCount: 6273,
    sha256: '6cd6e3b11aca6e4f6005535287fa21490a6b170f57aa7d48a81f7ed9271b703d',
    first: { nameRaw: '宁波东海蓝帆科技有限公司', usccRaw: '91330201753252106U', district: '高新区', regStatus: '待审核' },
  },
] as const

describe.runIf(Boolean(REAL_DIR))('真实导出表:列号、行数、版本哈希都对得上', () => {
  it.each(REAL_BASELINE)('$file', async (base) => {
    const parsed = await readPlatformExport(realFile(base.file))
    // 称号按工作表名自动识别,不需要调用方指定。
    expect(parsed.titleCode).toBe(base.titleCode)
    expect(parsed.rowCount).toBe(base.rowCount)
    expect(parsed.rows).toHaveLength(base.rowCount)
    // 版本身份 = 文件内容 SHA-256(独立量过的字面量,不是重算)。
    expect(parsed.sha256).toBe(base.sha256)

    // 首行抽样:名称 / 统代 / 区县 / 审核状态 —— 这一条同时证明**列号**取对了。
    expect(parsed.rows[0]).toMatchObject({
      sourceRowNo: 3,
      nameRaw: base.first.nameRaw,
      usccRaw: base.first.usccRaw,
      district: base.first.district,
      regStatus: base.first.regStatus,
    })

    // 统代一列不缺失、不重复(实测三张表都是 0/0)—— 再次证明列号没错位。
    const codes = parsed.rows.map((r) => r.usccRaw)
    expect(codes.filter((c) => !c)).toHaveLength(0)
    expect(new Set(codes).size).toBe(base.rowCount)
    for (const code of codes) expect(code).toMatch(/^[0-9A-Z]{18}$/)
  }, 60_000)

  it('同一文件两次解析结果一致(解析是纯映射,不掺时间/随机)', async () => {
    const a = await readPlatformExport(realFile('专精特新小巨人导出Excel.xlsx'))
    const b = await readPlatformExport(realFile('专精特新小巨人导出Excel.xlsx'))
    expect(a).toEqual(b)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 交给统一写 API 的 payload(契约 §8.3 `payload.exportSnapshot`)
// ---------------------------------------------------------------------------

describe('buildExportSnapshotPayload:契约 §8.3 的 exportSnapshot 形状', () => {
  const LAYOUT = { uscc: 15, status: 95, batch: 98 }

  it('顶层字段与契约逐字一致,行携带源行号与平台字段', async () => {
    const path = await writeFixture('payload.xlsx', '创新型中小企业导出Excel', LAYOUT, [
      { 1: '甲公司', 2: '浙江省 宁波市 高新区', 15: '91330201AAAAAAA001', 95: '待审核', 98: '2026-1' },
    ])
    const parsed = await readPlatformExport(path, { titleCode: 'innovative_sme' })
    const payload = buildExportSnapshotPayload(parsed, { year: 2026, collectedOn: '2026-10-15' })

    // 契约 §8.3 里 exportSnapshot 的键集合 —— 多了少了都算违约。
    expect(Object.keys(payload).sort()).toEqual(
      ['collectedOn', 'originalFilename', 'rows', 'sha256', 'titleCode', 'year'].sort(),
    )
    expect(payload).toMatchObject({
      titleCode: 'innovative_sme',
      year: 2026,
      collectedOn: '2026-10-15',
      originalFilename: 'payload.xlsx',
      sha256: parsed.sha256,
    })
    expect(payload.rows).toEqual([
      {
        sourceRowNo: 3,
        usccRaw: '91330201AAAAAAA001',
        nameRaw: '甲公司',
        province: '浙江省',
        city: '宁波市',
        district: '高新区',
        regStatus: '待审核',
        rawFields: { '1': '甲公司', '2': '浙江省 宁波市 高新区', '15': '91330201AAAAAAA001', '95': '待审核', '98': '2026-1' },
      },
    ])
  })

  it('是可 JSON 序列化的纯数据(写 API 直接当 body 用)', async () => {
    const path = await writeFixture('payload-json.xlsx', '创新型中小企业导出Excel', LAYOUT, [
      { 1: '甲公司', 15: '91330201AAAAAAA001' },
    ])
    const parsed = await readPlatformExport(path, { titleCode: 'innovative_sme' })
    const payload = buildExportSnapshotPayload(parsed, { year: 2026, collectedOn: '2026-10-15' })
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('年度与采集日期由调用方给出,不从文件内容臆断', async () => {
    const path = await writeFixture('payload-meta.xlsx', '创新型中小企业导出Excel', LAYOUT, [
      { 1: '甲公司', 15: '91330201AAAAAAA001', 98: '2023-2' },
    ])
    const parsed = await readPlatformExport(path, { titleCode: 'innovative_sme' })
    const payload = buildExportSnapshotPayload(parsed, { year: 2026, collectedOn: '2026-10-15' })
    // 维护批次「2023-2」不是快照年度 —— 不许被用来推断 year。
    expect(payload.year).toBe(2026)
    expect(payload.rows[0]!.rawFields['98']).toBe('2023-2')
  })
})
