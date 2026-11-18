import { existsSync, readFileSync } from 'node:fs'
import { LITTLE_GIANT_SOURCE_FILE } from '../../../../layers/sme-roster/lib/roster/little-giant-import'
import { buildLittleGiantWorkbookBuffer, type FixtureRow } from './workbook'

// Deterministic synthetic input by default; real-source acceptance is explicit.
export const littleGiantSourcePath = process.env.LITTLE_GIANT_SOURCE_XLSX ?? ''
export const hasRealSource = Boolean(littleGiantSourcePath)
if (hasRealSource && !existsSync(littleGiantSourcePath)) throw new Error('LITTLE_GIANT_SOURCE_XLSX does not exist')

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
    label: '合成名录夹具',
    path: null,
    real: false,
    buffer: await buildLittleGiantWorkbookBuffer(SYNTHETIC_LITTLE_GIANT_ROWS),
    sourceFile: 'tests/fixtures/little-giant/synthetic-historical-list.xlsx',
  }
}
