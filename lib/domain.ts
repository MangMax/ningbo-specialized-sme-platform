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

/** 功能区/园区——公布文件里作为“属地”使用,并非行政区划。 */
export const NINGBO_FUNCTIONAL_ZONES = ['杭州湾', '保税区', '大榭'] as const

/** 该区县是否在宁波(含功能区)范围内。用于识别漂移/写法异常。 */
export function isNingboDistrict(district: string): boolean {
  return (
    (NINGBO_DISTRICTS as readonly string[]).includes(district) ||
    (NINGBO_FUNCTIONAL_ZONES as readonly string[]).includes(district)
  )
}

const INVISIBLE = /[​‌‍﻿　]/g

/**
 * 企业名称归一化:去所有空白与零宽、去全/半角括号、去尾随符号。
 * 既用于 pipeline 写入 `enterprise.name_norm`,也用于 app 的按名搜索 —— 两者必须同规则,
 * 所以只有这一处实现。
 */
export function normalizeName(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  return String(raw)
    .replace(INVISIBLE, '')
    .replace(/[\s ]+/g, '')
    .replace(/[（）()]/g, '')
    .replace(/[√✓、,，.。;；]+$/g, '')
    .trim()
}
