/**
 * 记录级对比「来源选择」的业务化标题。
 *
 * 现有来源接口对平台查询给出的 `label` 以 `queryKey`（例如 `SYN111…`）结尾；
 * 这里只用已经返回的 `subtitle`（接口）、`titleName`（称号）和 `conditions`
 * （查询范围）拼出可读标题，不把 SYN 编号解码成企业，也不猜测主体。
 */
import { conditionSummary, interfaceLabel } from './review-display'

export interface ComparisonSourceLabelInput {
  kind: string
  label: string
  subtitle?: string | null
  titleName?: string | null
  rdjb?: string | null
  conditions?: Record<string, unknown> | null
}

/**
 * 主标题只写可读范围：企业名称（若有）与“按什么条件查询”。
 * `uscc` / 查询键属于标识，放到次要信息，不参与主体推断。
 */
export function comparisonSourceScope(conditions: Record<string, unknown> | null | undefined): string {
  if (!conditions) return '未记录查询条件'
  const parts: string[] = []
  if (typeof conditions.name === 'string' && conditions.name) parts.push(`企业名称：${conditions.name}`)
  const rest = conditionSummary({ ...conditions, name: undefined })
  if (rest !== '未记录查询条件') parts.push(rest)
  return parts.length ? parts.join(' · ') : '未记录查询条件'
}

export function comparisonSourceTitle(source: ComparisonSourceLabelInput): string {
  if (source.kind !== 'query') return source.label
  const title = source.titleName ?? source.rdjb ?? '多称号'
  return `${interfaceLabel(source.subtitle)} · ${title} · ${comparisonSourceScope(source.conditions)}`
}

/** 原始查询键只作次要信息，不从它推断企业。 */
export function comparisonSourceRawKey(source: ComparisonSourceLabelInput): string {
  if (source.kind !== 'query') return ''
  const parts = source.label.split(' · ')
  return parts.length > 1 ? parts.at(-1) ?? '' : ''
}

/**
 * 次要标识：查询键、信用代码，以及“是否已记录企业名称”。
 *
 * 现有来源契约只返回查询键和条件，没有可验证的企业关联；
 * 这里把缺口直接写出来，不从 SYN 键或信用代码推断主体。
 */
export function comparisonSourceSecondaryIds(source: ComparisonSourceLabelInput): string[] {
  if (source.kind !== 'query') return []
  const ids: string[] = []
  const rawKey = comparisonSourceRawKey(source)
  if (rawKey) ids.push(`查询键 ${rawKey}`)
  const uscc = source.conditions?.uscc
  if (typeof uscc === 'string' && uscc) ids.push(`统一社会信用代码 ${uscc}`)
  const name = source.conditions?.name
  if (!(typeof name === 'string' && name.trim())) ids.push('未关联企业名称')
  return ids
}
