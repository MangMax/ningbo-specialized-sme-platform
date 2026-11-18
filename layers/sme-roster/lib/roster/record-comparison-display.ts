/**
 * 记录级对比「来源选择」的业务化标题。
 *
 * 现有来源接口对平台查询给出的 `label` 以 `queryKey`（例如 `SYN111…`）结尾；
 * 这里只用已经返回的 `subtitle`（接口）、`titleName`（称号）和 `conditions`
 * （查询范围）拼出可读标题，不把 SYN 编号解码成企业，也不猜测主体。
 */
import { conditionSummary, interfaceLabel } from '../../../../lib/roster/review-display'

export interface ComparisonSourceEnterpriseLink {
  relationId?: number
  sequenceNo?: number
  enterpriseId: number
  enterpriseName: string
  /** 平台原行名称；归并后仍保留，不能用存续主体名替换。 */
  nameRaw?: string | null
  matchBasis?: string | null
  aliasConfirmed?: boolean
  /** 由已确认别名的归并备注解析；没有证据时为 null。 */
  mergedFromEnterpriseId?: number | null
}

export interface ComparisonSourceLabelInput {
  kind: string
  label: string
  subtitle?: string | null
  titleName?: string | null
  rdjb?: string | null
  conditions?: Record<string, unknown> | null
  confirmedEnterprises?: ComparisonSourceEnterpriseLink[] | null
  recordNames?: string[] | null
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
 * 次要标识只放标识，不再用“未关联企业名称”当终态。
 *
 * 企业识别由 {@link comparisonSourceEnterpriseLine} /
 * {@link comparisonSourceRawNameLine} 明确区分“已确认主体”与“平台原行名称”；
 * 查询键与信用代码仍不从 SYN 键推断主体。
 */
export function comparisonSourceSecondaryIds(source: ComparisonSourceLabelInput): string[] {
  if (source.kind !== 'query') return []
  const ids: string[] = []
  const rawKey = comparisonSourceRawKey(source)
  if (rawKey) ids.push(`查询键 ${rawKey}`)
  const uscc = source.conditions?.uscc
  if (typeof uscc === 'string' && uscc) ids.push(`统一社会信用代码 ${uscc}`)
  return ids
}

function uniqueConfirmedEnterprises(source: ComparisonSourceLabelInput): ComparisonSourceEnterpriseLink[] {
  const seen = new Set<number>()
  return (source.confirmedEnterprises ?? []).filter(row => {
    if (seen.has(row.enterpriseId)) return false
    seen.add(row.enterpriseId)
    return true
  })
}

function rawNameRows(source: ComparisonSourceLabelInput): ComparisonSourceEnterpriseLink[] {
  const seen = new Set<string>()
  return (source.confirmedEnterprises ?? []).filter(row => {
    const name = row.nameRaw?.trim()
    if (!name || name === row.enterpriseName) return false
    const key = `${row.enterpriseId}\u0000${name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 主体第一行：有已确认关系时列出主体（一对多只摘要前几条）。
 * 没有已确认关系但有平台原行名称时，由 {@link comparisonSourceUnconfirmedLine}
 * 单独标注；两者皆无才是“名称未读取（待关联）”。
 */
export function comparisonSourceEnterpriseLine(source: ComparisonSourceLabelInput, limit = 3): string {
  if (source.kind !== 'query') return ''
  const enterprises = uniqueConfirmedEnterprises(source)
  if (enterprises.length) {
    const shown = enterprises.slice(0, limit).map(row => `${row.enterpriseName}（#${row.enterpriseId}）`)
    return `已确认主体 ${enterprises.length} 家：${shown.join('、')}${enterprises.length > limit ? ' 等' : ''}`
  }
  return unconfirmedNames(source).length ? '' : '企业名称未读取（待关联）'
}

function unconfirmedNames(source: ComparisonSourceLabelInput): string[] {
  return [...new Set((source.recordNames ?? []).filter(name => name.trim()))]
}

/** 未关联/未确认关系的原行名称：只作为“平台记录名称”，不冒充正式企业名。 */
export function comparisonSourceUnconfirmedLine(source: ComparisonSourceLabelInput, limit = 3): string {
  if (source.kind !== 'query') return ''
  const names = unconfirmedNames(source)
  if (!names.length) return ''
  return `平台记录名称（未确认主体）：${names.slice(0, limit).join('、')}${names.length > limit ? ' 等' : ''}`
}

/**
 * 已确认关系中原行名与主体名不同时并列显示；归并来源只写备注里真实存在的
 * `归并自 enterprise:N`，没有该字段就不猜“曾用名”。
 */
export function comparisonSourceRawNameLine(source: ComparisonSourceLabelInput, limit = 3): string {
  if (source.kind !== 'query') return ''
  const rows = rawNameRows(source)
  if (!rows.length) return ''
  const shown = rows.slice(0, limit).map(row => {
    const lineage = row.mergedFromEnterpriseId
      ? ` · 归并自 #${row.mergedFromEnterpriseId}`
      : row.aliasConfirmed ? ' · 已确认曾用名' : ''
    return `${row.nameRaw} → ${row.enterpriseName}（#${row.enterpriseId}）${lineage}`
  })
  return `平台原行名称：${shown.join('；')}${rows.length > limit ? ` 等 ${rows.length} 条` : ''}`
}

/** 展开详情用的完整主体清单；未确认的平台原行名单独列出。 */
export function comparisonSourceEnterpriseDetails(source: ComparisonSourceLabelInput): string[] {
  if (source.kind !== 'query') return []
  const rows = uniqueConfirmedEnterprises(source)
  const details = rows.map(row => {
    if (!row.nameRaw?.trim() || row.nameRaw === row.enterpriseName) return `已确认主体：${row.enterpriseName}（#${row.enterpriseId}）`
    const lineage = row.mergedFromEnterpriseId
      ? ` · 归并自 #${row.mergedFromEnterpriseId}`
      : row.aliasConfirmed ? ' · 已确认曾用名' : ''
    return `平台原行名称：${row.nameRaw} · 已确认主体：${row.enterpriseName}（#${row.enterpriseId}）${lineage}`
  })
  for (const name of unconfirmedNames(source)) {
    details.push(`平台记录名称（未确认主体）：${name}`)
  }
  return details
}


export const comparisonLinkText = (value: string) => ({ linked: '已对应正式事件', later_process: '独立后续流程', unlinked: '未对应正式事件', mixed: '对应状态混合' }[value] ?? '待核')
export const comparisonQualificationText = (value: string) => ({ matched: '同范围同版本一致', interface_only: '接口原行独有', field_conflict: '同范围同版本字段冲突', not_comparable: '范围或版本待核，暂不可比较', platform_without_official: '已证明范围无正式对应', unresolved: '正式来源覆盖待核' }[value] ?? '待核')
export const comparisonDecisionText = (value: string) => ({ candidate: '候选', confirmed: '已确认', rejected: '已否定', unlinked: '已解除' }[value] ?? '待核')
