import { normalizeEnterpriseName } from '../../core/lib/enterprise-name'

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
  const name = normalizeEnterpriseName(raw)
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

/**
 * 统一社会信用代码归一:**去全部空白 + 转大写**。
 *
 * 公布文件与平台响应解析写入、写入 API 的身份比较、以及读侧的统代比对都必须同规则,
 * 所以只有这一处实现 —— 原先 `layers/sme-roster/lib/roster/little-giant-workbook.ts` 与
 * `layers/sme-roster/server/utils/roster-import.ts` 各写了一遍,两处注释都自称「与既有口径一致」,
 * 那正是漂移的开始。
 *
 * 入参是 `unknown`:调用方手上的值常常是「不知道是什么」的(JSON 载荷、工作表单元格)。
 * **给不出值时返回空串**,「空」的落点由调用方决定(写入侧按「未给统代」处理,
 * 解析侧按「源里缺」处理);本函数**不**在这里替调用方决定 `null` 还是 `''`。
 *
 * 唯一**有意**的例外:`layers/sme-roster/lib/platform-snapshots.ts` 的 `snapshotRowKey` 用的是
 * 「trim + 大写」,那是 RL-05 快照行身份键**自己写明**的口径(见该函数注释),
 * 不是这里的漏网之鱼 —— 要改它等于改快照 diff 的键规则,不属本处收敛范围。
 */
export function normalizeUscc(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return ''
  return String(raw).replace(/[\s\u00A0\u200B-\u200D\uFEFF\u3000]+/gu, '').toUpperCase()
}
