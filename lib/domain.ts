/**
 * 领域常量与身份归一化规则 —— app 与项目外 pipeline 的**共享契约**。
 *
 * app 只读台账;`../pipeline` 解析公布文件/工信部导出并写库时,import 本文件以保证
 * 写入的 `name_norm`、区县取值与 app 的读取/校验完全一致(单一来源,避免两边漂移)。
 * 本文件不含任何 IO 或清洗管线逻辑。
 */

/** 宁波市辖 12 个区县(市)。 */
export const NINGBO_DISTRICTS = [
  '海曙区',
  '江北区',
  '北仑区',
  '镇海区',
  '鄞州区',
  '奉化区',
  '余姚市',
  '慈溪市',
  '宁海县',
  '象山县',
  '高新区',
  '前湾新区',
] as const

/**
 * 独立管理区——公布文件里**独立**作为“属地”使用,不隶属于前述行政区,也**不应并入**它们:
 * - `大榭`:大榭开发区;
 * - `保税区`:宁波保税区(海关特殊监管区域)。
 * 注:`杭州湾`(=杭州湾新区)是 `前湾新区` 的旧名,已在 pipeline 归一化为 `前湾新区`,
 * 因此不在此列(见 GLOSSARY「区县」)。
 */
export const NINGBO_INDEPENDENT_ZONES = ['保税区', '大榭'] as const

/** 该区县/管理区是否在宁波范围内。用于识别漂移/写法异常。 */
export function isNingboDistrict(district: string): boolean {
  return (
    (NINGBO_DISTRICTS as readonly string[]).includes(district) ||
    (NINGBO_INDEPENDENT_ZONES as readonly string[]).includes(district)
  )
}

const INVISIBLE = /\u{200B}|\u{200C}|\u{200D}|\u{FEFF}|\u{3000}/gu

/**
 * 企业名称归一化:去所有空白与零宽、去全/半角括号、去尾随符号。
 * 既用于 pipeline 写入 `enterprise.name_norm`,也用于 app 的按名搜索 —— 两者必须同规则,
 * 所以只有这一处实现。
 */
export interface NameEvidence {
  name: string
  uscc: string | null
}

/** 只用调用方提供的原始来源证据;缺统代、冲突或外市同名均不生成映射。 */
export function normalizeName(
  raw: string | number | boolean | null | undefined,
  evidence: readonly NameEvidence[] = [],
): string {
  if (raw === null || raw === undefined) return ''
  const name = String(raw)
    .replace(INVISIBLE, '')
    .replace(/[\s\u{00A0}]+/gu, '')
    .replace(/[（）()]/g, '')
    .replace(/[√✓、,，.。;；]+$/g, '')
    .trim()
  const long = name.startsWith('宁波') ? name : `宁波${name}`
  const short = long.slice(2)
  const codes = (key: string) => new Set(evidence
    .filter(e => normalizeName(e.name) === key && e.uscc)
    .map(e => e.uscc))
  const longCodes = codes(long)
  const shortCodes = codes(short)
  // SPEC 已核实的公布文件短名 ↔ 工信部规范名;仅此一对,仍拒绝统代冲突。
  if (short === '贝兹德智能科技有限公司' && longCodes.size === 1 &&
      longCodes.has('91330226MA2CL6FP2U') && shortCodes.size === 0 &&
      evidence.some(e => normalizeName(e.name) === short)) return long
  if (longCodes.size === 1 && shortCodes.size === 1 &&
      [...longCodes][0] === [...shortCodes][0]) return long
  return name
}
