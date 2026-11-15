import { existsSync, readFileSync } from 'node:fs'
import { LITTLE_GIANT_SOURCE_FILE } from '../../../../lib/roster/little-giant-import'
import { buildLittleGiantWorkbookBuffer, type FixtureRow } from './workbook'

/**
 * RL-02 的测试源:**真件在就用真件,不在就用合成夹具**,但**永远有一份可跑**。
 *
 * ── 为什么不整组 skip ────────────────────────────────────────────────────
 * 真件是业务数据、不进 Git(brief:不要把 xlsx 提交进 Git),所以它在不在**取决于机器**。
 * 「文件不在 ⇒ 这组用例消失」会让这条链路的验收在新检出上**静默归零** —— 那不是省事,
 * 是把「没跑过」伪装成「跑过了」。所以:
 *
 *  - **结构 / 逐行交代 / 写入链路**这些断言在两种源上都必须成立(合成夹具按真件的
 *    结构特征造:单表、单行表头、r2 起、G 与 I 同表头、K 起是杂项、跨批次同码);
 *  - **只有真件才有的具体数字**(SHA-256、511 行、510 企业、r15/r367)挂在
 *    `hasRealSource` 上,真件在时才断言。
 *
 * 真件路径:`RL02_LITTLE_GIANT_XLSX=<绝对路径>` 覆盖;未设时退回本机源目录默认位置。
 */

/** 本机源目录里的默认位置。 */
export const LITTLE_GIANT_DEFAULT_SOURCE_PATH =
  '/Users/mang/Workfile/宁波/专精特新/20261013/经信局名单/小巨人/经信局公布历年小巨人企业名单.xlsx'

/** 实际使用的真件路径(可能不存在)。 */
export const littleGiantSourcePath =
  process.env.RL02_LITTLE_GIANT_XLSX ?? LITTLE_GIANT_DEFAULT_SOURCE_PATH

/** 真件在不在。**只在「真有才有的数字」上用它**;结构性断言不许依赖它。 */
export const hasRealSource = existsSync(littleGiantSourcePath)

/**
 * 合成夹具:复刻真件的关键**结构**事实,并包含那个唯一的重复信用代码形态
 * (同一码在第 2 批与第 6 批各一次)⇒ 企业去重 / 两条事件这条链路**不依赖真件**也能验。
 *
 * 除那一对之外用的是明显的样例名与样例码(不给真实企业配假代码)。
 */
export const SYNTHETIC_LITTLE_GIANT_ROWS: readonly FixtureRow[] = [
  { seq: 1, district: '鄞州区', name: '样例企业一号有限公司', uscc: '91330212MA2AB00009', batch: '第1批' },
  { seq: 14, district: '镇海区', name: '宁波昌扬机械工业有限公司', uscc: '91330211316904639T', batch: '第2批' },
  { seq: 30, district: '北仑区', name: '样例企业二号有限公司', uscc: '91330206MA2AB0000K', batch: '第3批' },
  { seq: 41, district: '慈溪市', name: '样例企业三号有限公司', uscc: '91330282MA2AB0000M', batch: '第4批' },
  { seq: 52, district: '余姚市', name: '样例企业四号有限公司', uscc: '91330281MA2AB00007', batch: '第5批' },
  { seq: 366, district: '镇海区', name: '宁波昌扬机械工业有限公司', uscc: '91330211316904639T', batch: '第6批' },
  { seq: 500, district: '海曙区', name: '样例企业五号有限公司', uscc: '91330203MA2AB00008', batch: '第7批' },
]

/** 合成夹具里那个跨批次重复的信用代码(与真件里唯一重复的那一个相同)。 */
export const SYNTHETIC_DUPLICATE_USCC = '91330211316904639T'

export interface LittleGiantSource {
  /** 人读的标识,给失败信息用。 */
  label: string
  /** 真件时为磁盘路径;合成夹具时为 `null`。 */
  path: string | null
  real: boolean
  buffer: Buffer
  /**
   * 写进「出处」与 `source_identity` 的标识。
   *
   * **库内相对路径**(RL-16):这份工作簿已入库,出处必须指得到文件,否则名录行点开预览会断。
   * 真件用 `LITTLE_GIANT_SOURCE_FILE`(模块的默认值,与文件库里的那一条逐字相同);
   * 合成夹具用一个明确标着 fixture 的逻辑标识(免得跟真件记录混在一起)。
   */
  sourceFile: string
}

/** 取一份可跑的源:真件优先。 */
export async function loadLittleGiantSource(): Promise<LittleGiantSource> {
  if (hasRealSource) {
    return {
      label: `真件 ${littleGiantSourcePath}`,
      path: littleGiantSourcePath,
      real: true,
      buffer: readFileSync(littleGiantSourcePath),
      // 与模块默认值同源:库内相对路径(真件入库后就在这个位置)。
      sourceFile: LITTLE_GIANT_SOURCE_FILE,
    }
  }
  return {
    label: '合成夹具(真件不在本机 ⇒ 不整组跳过)',
    path: null,
    real: false,
    buffer: await buildLittleGiantWorkbookBuffer(SYNTHETIC_LITTLE_GIANT_ROWS),
    sourceFile: 'tests/fixtures/little-giant/synthetic-historical-list.xlsx',
  }
}

if (!hasRealSource) {
  console.info(
    `[RL-02] 真件不在 ${littleGiantSourcePath} ⇒ 用合成夹具跑同一条链路。` +
      '要跑真件:RL02_LITTLE_GIANT_XLSX=<绝对路径>。',
  )
}
