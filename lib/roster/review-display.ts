/**
 * 核对界面的展示用语与状态归纳。
 *
 * 这一层只把 #109/#114 已经给出的事实翻译成业务语言，不反推
 * 查询结果、不生成业务决定，也不把“查询完成”写成“一致”。
 */
import {
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  PLATFORM_INTERFACES,
  TITLES,
  comparisonDirectionLabel,
} from '../labels'
import { formatFetchTime } from '../reconcile-time'
import type { ImpactRow, ReviewAssessment } from './evidence-review-ui'

export type CaseTone = 'action' | 'failed' | 'waiting' | 'done' | 'muted'

export interface CaseHeadline {
  tone: CaseTone
  label: string
  detail: string
  action: string
}

const INTERFACE_ALIASES: Record<string, string> = {
  businessList: 'business_list',
  queryList: 'apply_list',
  queryBusList: 'recognized_list',
  recognizedList: 'recognized_list',
}

const SOURCE_KIND_LABELS: Record<string, string> = {
  platform_query: '平台查询',
  platform_export: '导出快照',
  identity: '企业身份归并',
  alias: '曾用名确认',
  profile: '企业资料变更',
  event: '正式事件',
  evidence: '出处登记',
  maintenance: '维护记录',
}

const CONDITION_LABELS: Record<string, string> = {
  rddqrq: '认定日期',
  whpcyear: '维护年份',
  whpc: '维护批次',
  szq: '属地代码',
  rdsj: '认定时间',
  rdxq: '认定信息',
  rdxx: '认定信息',
  sqsj: '申报时间',
}

export function reviewTimeLabel(value: string | null | undefined): string {
  return formatFetchTime(value) ?? '未记录'
}

export function reviewDateLabel(value: string | null | undefined): string {
  const label = formatFetchTime(value)
  return label ? label.slice(0, 10) : '未记录'
}

export function interfaceLabel(value: string | null | undefined): string {
  if (!value) return '来源待核'
  return PLATFORM_INTERFACES[value] ?? PLATFORM_INTERFACES[INTERFACE_ALIASES[value] ?? ''] ?? '平台记录'
}

export function sourceKindLabel(value: string | null | undefined): string {
  if (!value) return '来源变更'
  return SOURCE_KIND_LABELS[value] ?? '来源变更'
}

export function conditionSummary(conditions: Record<string, unknown> | null | undefined): string {
  if (!conditions) return '未记录查询条件'
  const parts: string[] = []
  if (typeof conditions.uscc === 'string' && conditions.uscc) parts.push('按统一社会信用代码查询')
  if (typeof conditions.name === 'string' && conditions.name) parts.push('按企业名称查询')
  for (const [key, label] of Object.entries(CONDITION_LABELS)) {
    const value = conditions[key]
    if (value != null && value !== '') parts.push(`${label} ${String(value)}`)
  }
  if (conditions.combination === 'and') parts.push('条件同时满足')
  if (conditions.combination === 'or') parts.push('任一条件满足')
  const known = new Set(['uscc', 'name', 'combination', ...Object.keys(CONDITION_LABELS)])
  const extra = Object.keys(conditions).filter(key => !known.has(key)).length
  if (extra) parts.push(`${extra} 项其他条件`)
  return parts.length ? parts.join(' · ') : '未记录查询条件'
}

export function titleLabel(titleCode: string | null | undefined): string {
  if (!titleCode) return '称号待核'
  return TITLES[titleCode] ?? '称号待核'
}

export function directionLabel(direction: string | null | undefined): string {
  if (!direction) return '方向待核'
  return comparisonDirectionLabel(direction)
}

export function decisionReasonLabel(assessment: ReviewAssessment): string {
  const decision = assessment.currentDecision.current
  if (!decision) return '尚无业务决定'
  const reason = decision.reasonCode ? DIFFERENCE_REASONS[decision.reasonCode] ?? decision.reasonCode : '原因未填写'
  const note = decision.reasonNote ? ` · ${decision.reasonNote}` : ''
  return `原因：${reason}${note}`
}

export function decisionMeasureLabel(assessment: ReviewAssessment): string {
  const decision = assessment.currentDecision.current
  if (!decision) return ''
  const measure = decision.measureCode ? DIFFERENCE_MEASURES[decision.measureCode] ?? decision.measureCode : '措施未填写'
  const note = decision.measureNote ? ` · ${decision.measureNote}` : ''
  return `措施：${measure}${note}`
}

export function decisionStatusLabel(assessment: ReviewAssessment): string {
  const decision = assessment.currentDecision.current
  if (!decision) return ''
  return DIFFERENCE_STATUSES[decision.status] ?? '状态待核'
}

export function hasPendingValidity(assessment: ReviewAssessment): boolean {
  return assessment.explanationValidity.status === 'evidence_changed' || assessment.explanationValidity.status === 'premise_invalid'
}

/**
 * 单个“称号 × 方向”的首屏结论。
 * 顺序固定为：人工决定/待复核 → 查询失败/不完整 → 已查未判 → 未核对。
 */
export function assessmentHeadline(assessment: ReviewAssessment): CaseHeadline {
  const coverage = assessment.queryCoverage.status
  if (assessment.assessment === 'withdrawn') {
    return { tone: 'action', label: '决定已撤回', detail: '原决定和历史保留；当前没有生效中的业务决定。', action: '查看决定历史' }
  }
  if (assessment.assessment === 'decided') {
    if (hasPendingValidity(assessment)) {
      return { tone: 'action', label: '证据已变化 · 原决定保留待复核', detail: '原原因与措施未被改写；请核对新证据后明确维持或更正。', action: '核对证据' }
    }
    if (assessment.explanationValidity.status === 'valid') {
      return { tone: 'done', label: '已复核', detail: '当前决定与最近证据已登记复核。', action: '查看复核记录' }
    }
    return { tone: 'waiting', label: '已有业务决定 · 解释有效性未确认', detail: '决定可读，但尚无已登记的可核验证据基线。', action: '查看决定' }
  }
  if (assessment.assessment === 'queried_unjudged') {
    return { tone: 'waiting', label: '已查询 · 尚未判断', detail: '查询完成不等于一致或无需处理；尚没有业务决定。', action: '查看查询范围' }
  }
  if (assessment.assessment === 'not_queried') {
    return { tone: 'muted', label: '尚未核对', detail: '还没有执行过平台查询；未查询不等于无记录。', action: '查看范围' }
  }
  if (coverage === 'failed') {
    return { tone: 'failed', label: '无法判断 · 查询失败', detail: '失败或授权失败不等于零记录；保留上次结果与查询范围。', action: '查看失败记录' }
  }
  if (coverage === 'partial') {
    return { tone: 'failed', label: '无法判断 · 覆盖不完整', detail: '平台数据只覆盖部分页，不能据此判断一致或无需处理。', action: '查看已查范围' }
  }
  if (coverage === 'complete') {
    return { tone: 'waiting', label: '已查询 · 判断待核', detail: '查询已完成，但尚没有明确业务决定。', action: '查看查询范围' }
  }
  return { tone: 'waiting', label: '无法判断 · 查询范围待核', detail: '查询范围或主体尚未确认，不能推断为零记录。', action: '查看范围' }
}

export interface EnterpriseHeadline extends CaseHeadline {
  pendingCount: number
  pendingHasMore: boolean
}

/**
 * 企业级结论。待复核清单读取失败时明确“未读取”，不把未知写成 0 项。
 */
export function enterpriseHeadline(
  assessments: ReviewAssessment[],
  pending: { rows: ImpactRow[]; hasMore: boolean; loading: boolean; error: boolean },
): EnterpriseHeadline {
  const count = pending.rows.length
  const headline = (
    tone: CaseTone,
    label: string,
    detail: string,
    action: string,
  ): EnterpriseHeadline => ({ tone, label, detail, action, pendingCount: count, pendingHasMore: pending.hasMore })

  if (pending.loading && count === 0) {
    return headline('waiting', '正在读取待复核清单', '企业状态先按已有查询与决定显示；待复核项到达后更新。', '查看核对范围')
  }
  if (pending.error && count === 0) {
    return headline('failed', '待复核清单未读取', '不能确认是否存在待处理项；下方企业判断仍可查看。', '重试读取待复核清单')
  }
  if (count > 0) {
    const suffix = pending.hasMore ? '以上' : ''
    return headline('action', `待处理 · ${count}${suffix ? ` ${suffix}` : ''} 项证据变化`, '原决定保留；请先核对第一项，再决定维持或更正。', '处理第一项')
  }

  const failed = assessments.filter(item => item.queryCoverage.status === 'failed')
  if (failed.length) {
    return headline('failed', `无法判断 · ${failed.length} 个范围查询失败`, '失败不等于零记录；仍可查看已保留的查询范围与上次结果。', '查看失败范围')
  }
  const partial = assessments.filter(item => item.queryCoverage.status === 'partial')
  if (partial.length) {
    return headline('failed', `无法判断 · ${partial.length} 个范围覆盖不完整`, '覆盖不完整不能得出“一致”或“无需处理”。', '查看已查范围')
  }
  const decided = assessments.filter(item => item.assessment === 'decided')
  if (decided.some(hasPendingValidity)) {
    return headline('action', '有待复核的证据变化', '复核清单没有返回可见项，但解释有效性标为待复核；请打开对应范围核对。', '查看待复核范围')
  }
  if (decided.length) {
    const allValid = decided.every(item => item.explanationValidity.status === 'valid')
    return headline(
      allValid ? 'done' : 'waiting',
      allValid ? '已有业务决定 · 已复核' : '已有业务决定 · 解释有效性未确认',
      allValid ? '当前决定保留；没有可见的待复核变化。' : '决定可读；尚未建立已登记的证据复核基线。',
      '查看当前决定',
    )
  }
  const unjudged = assessments.filter(item => item.assessment === 'queried_unjudged')
  if (unjudged.length) {
    return headline('waiting', `已查询 · ${unjudged.length} 个范围尚未判断`, '查询完成不等于一致或无需处理；尚没有业务决定。', '查看尚未判断项')
  }
  const notQueried = assessments.filter(item => item.assessment === 'not_queried')
  if (notQueried.length === assessments.length) {
    return headline('muted', '尚未核对', '三个称号都还没有执行过平台查询；未查询不等于无记录。', '查看核对范围')
  }
  return headline('muted', '尚未判断', '当前没有足够的查询或人工判断；请打开称号范围查看。', '查看核对范围')
}

export function latestQueryTime(assessments: ReviewAssessment[]): string | null {
  let latest: string | null = null
  for (const assessment of assessments) {
    for (const source of assessment.queryCoverage.sources) {
      if (!latest || source.queriedAt > latest) latest = source.queriedAt
    }
  }
  return latest
}

export function impactScopeLabel(row: ImpactRow): string {
  return `${titleLabel(row.titleCode)} · ${directionLabel(row.direction)}`
}

export function impactTone(row: ImpactRow): CaseTone {
  if (row.pending) return 'action'
  if (row.lineage === 'withdrawn' || row.lineage === 'historical' || row.lineage === 'merged') return 'muted'
  return 'done'
}

/** 待复核清单里原决定的业务摘要；原文不可用时把“不可用”本身说清楚。 */
export function impactOldDecisionText(row: ImpactRow): string {
  const decision = row.oldDecision
  if (!decision) return '历史决定原文不可用；原坐标与来源仍保留。'
  const reason = decision.reasonCode
    ? DIFFERENCE_REASONS[decision.reasonCode] ?? decision.reasonCode
    : '原因未填写'
  const measure = decision.measureCode
    ? DIFFERENCE_MEASURES[decision.measureCode] ?? decision.measureCode
    : '措施未填写'
  const note = decision.reasonNote ? ` · ${decision.reasonNote}` : ''
  return `原决定 #${row.decisionId}：${reason}${note} · ${measure}`
}

/** 待复核清单的标题（不含内部 ID 时也能读）。 */
export function impactQueueTitle(row: ImpactRow): string {
  return impactScopeLabel(row)
}
