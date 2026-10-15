import ExcelJS from 'exceljs'

/**
 * 造一份**结构同真件**的小巨人工作簿,供 `lib/roster/little-giant-workbook.ts` 的用例使用。
 *
 * 为什么要自造而不是拿真件(`经信局公布历年小巨人企业名单.xlsx`)当夹具:
 *
 *  - 真件 88M 级、含 511 家企业的**真实企业名与信用代码**,进仓库等于把业务数据搬进 Git,
 *    而 brief 与 SPEC 都要求源文件不进 Git(brief「不要把 88M 源文件或 xlsx 提交进 Git」);
 *  - 真件里**没有**「第 8 批」「缺企业名」「缺批次」「K 列有名字而 A:J 为空」这些分支,
 *    要靠夹具才测得到 —— 而这些正是本票最容易踩坑的地方。
 *
 * 夹具**复刻真件的结构特征**(已实测,见 `03-RESEARCH` B3):
 *  - 单工作表;表头只有**一行**(r1),数据从 **r2** 起;
 *  - **G 列与 I 列表头都叫「联系方式」**(按表头名取列必然撞车 ⇒ 必须按列号取);
 *  - A:J 是名单字段区,**K 起**是备注/主导产品/行业等杂项(不得当名单读)。
 */

/** 真件 r1 的表头原文(A:U,共 21 个非空表头;真件 39 列,后 18 列多无表头)。 */
export const LITTLE_GIANT_HEADERS = [
  '序号',
  '属地',
  '企业名称',
  '统一社会信用代码',
  '地址',
  '法人',
  '联系方式',
  '联系人',
  '联系方式',
  '批次',
  '备注1',
  '备注2',
  '主导产品',
  '行业\n代码',
  '行业全称',
  '二位行业代码',
  '二位行业内容',
  '361匹配\n一级',
  '361匹配\n二级',
  '18个重点细分行业',
  '奖补资金',
] as const

/** 真件的工作表名 —— 带 ` (2)` 后缀,像从别的簿复制来的遗留(所以**不能按名字取表**)。 */
export const LITTLE_GIANT_SHEET_NAME = '专精特新小巨人企业 (2)'

/** A:J 的列号(1 起)与字段名。**按列号取,不按表头名取**。 */
export const FIXTURE_COLUMNS = {
  seq: 1,
  district: 2,
  name: 3,
  uscc: 4,
  address: 5,
  legalPerson: 6,
  legalContact: 7,
  contactPerson: 8,
  contactPhone: 9,
  batch: 10,
} as const

export type FixtureColumnKey = keyof typeof FIXTURE_COLUMNS

export interface FixtureRow {
  seq?: string | number
  district?: string
  name?: string
  uscc?: string
  address?: string
  legalPerson?: string
  legalContact?: string
  contactPerson?: string
  contactPhone?: string
  batch?: string
  /** K 及之后的列,按键名写(如 `{ K: '备注', M: '主导产品' }`)—— **不应被解析成名单**。 */
  extra?: Record<string, string | number>
  /** `true` = 整行不放任何 A:J 值(用来测「空白行也要有交代」)。 */
  blank?: boolean
}

/** 列号 → 列名(1→A、10→J、39→AM)。 */
export function columnLetter(index: number): string {
  let n = index
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function cellValue(value: string | number | undefined): string | number | null {
  return value === undefined ? null : value
}

/** 生成工作簿字节(内存里写完直接给 buffer,不落盘)。 */
export async function buildLittleGiantWorkbookBuffer(
  rows: readonly FixtureRow[],
  options: { sheetName?: string } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(options.sheetName ?? LITTLE_GIANT_SHEET_NAME)

  LITTLE_GIANT_HEADERS.forEach((header, i) => {
    sheet.getCell(1, i + 1).value = header
  })

  rows.forEach((row, i) => {
    const sheetRow = i + 2
    // 先碰一下这一行:数据中间的空行在真实工作簿里**是存在的行**(只是没有值),
    // 不碰它 exceljs 就不会把它算进 `rowCount`,夹具就复刻不出「空行也要有交代」的场景。
    sheet.getRow(sheetRow)
    if (!row.blank) {
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.seq).value = cellValue(row.seq)
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.district).value = cellValue(row.district)
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.name).value = cellValue(row.name)
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.uscc).value = cellValue(row.uscc)
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.address).value = cellValue(row.address)
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.legalPerson).value = cellValue(row.legalPerson)
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.legalContact).value = cellValue(row.legalContact)
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.contactPerson).value = cellValue(row.contactPerson)
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.contactPhone).value = cellValue(row.contactPhone)
      sheet.getCell(sheetRow, FIXTURE_COLUMNS.batch).value = cellValue(row.batch)
    }
    for (const [letter, value] of Object.entries(row.extra ?? {})) {
      sheet.getCell(`${letter}${sheetRow}`).value = value
    }
  })

  // K 起也放一份表头,与真件一致(真件 K:U 有表头,R 起多为杂项)。
  for (let i = 10; i < LITTLE_GIANT_HEADERS.length; i += 1) {
    sheet.getCell(1, i + 1).value = LITTLE_GIANT_HEADERS[i]!
  }

  const written = await workbook.xlsx.writeBuffer()
  return Buffer.from(written as ArrayBuffer)
}
