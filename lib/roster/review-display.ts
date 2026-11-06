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

/**
 * #108: an absent actor is a real answer ("not recorded"), not a reason to invent a user.
 * Never render a placeholder id such as `unknown`, `system` or `admin`.
 */
export function recordedActorLabel(actor: { type: 'user' | 'agent'; id: string } | null | undefined): string {
  if (!actor) return '未记录'
  const kind = actor.type === 'agent' ? '代理' : '人工'
  return actor.id ? `${kind} · ${actor.id}` : '未记录'
}

/** Only a genuinely recorded business rule version is shown; protocol/schema versions never substitute. */
export function recordedRuleVersionLabel(value: string | null | undefined): string {
  return value?.trim() ? value : '未记录'
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

/**
 * 核对界面的方向用词。
 *
 * 旧版比对沿用 `COMPARISON_LABELS`（应出未出），核对台两方向矩阵与队列统一用
 * 「应纳未纳 / 平台多出」；不能一边写列头、一边在 aria 与筛选里换另一个词。
 */
export function directionLabel(direction: string | null | undefined): string {
  if (!direction) return '方向待核'
  if (direction === 'extra_in_miit') return '平台多出'
  return comparisonDirectionLabel(direction)
}

/** 企业头部只陈述正式称号这一条业务轴；与平台核对范围分开。 */
export function officialTitlesLabel(titleNames: string[]): string {
  return titleNames.length ? `正式称号：${titleNames.join(' / ')}` : '正式称号：暂无'
}

/**
 * 头部只回答平台查询时间，不推断“是否核对完成”。
 *
 * 同一根时间轴只用一种说法：有查询记录写日期，没有写“未记录”。
 * 已有决定 / 待复核但没有查询来源时，也不会与正文互相否定。
 */
export function headerCheckLabel(latestQueryAt: string | null | undefined): string {
  return `平台查询时间：${latestQueryAt ? reviewDateLabel(latestQueryAt) : '未记录'}`
}

const LIFECYCLE_ACTION_LABELS: Record<string, string> = {
  replace: '追加更正',
  withdraw: '撤回',
}

/** #102 生命周期动作的业务名。`null` 是历史导入，不是受管版本。 */
export function lifecycleActionLabel(action: string | null | undefined): string {
  if (!action) return '历史导入'
  return LIFECYCLE_ACTION_LABELS[action] ?? '生命周期更新'
}

export function decisionOriginLabel(origin: string | null | undefined): string {
  if (origin === 'lifecycle') return '受管决定'
  if (origin === 'legacy_import') return '历史导入'
  return origin ?? '未记录'
}

/**
 * 历史版本行只依据实际 API 字段说明它如何形成。
 *
 * `maintain` 不新增 `difference_reason` 版本，因此这里不会出现“维持”版本；
 * replace + previousId 才是追加更正，replace + 无前版是首次受管决定。
 */
export function decisionVersionActionLabel(row: {
  lifecycleAction: string | null | undefined
  previousId: number | null | undefined
}): string {
  if (!row.lifecycleAction) return '历史导入 · 未纳入受管生命周期'
  if (row.lifecycleAction === 'replace') {
    return row.previousId == null ? '首次决定' : `追加更正 · 原决定 #${row.previousId} 保留`
  }
  if (row.lifecycleAction === 'withdraw') return '撤回 · 当前决定已置空'
  return lifecycleActionLabel(row.lifecycleAction)
}

/** 矩阵/详情摘要：先给当前决定坐标，再给原因；不把历史版本写成当前。 */
export function decisionReasonWithCoordinate(assessment: ReviewAssessment): string {
  const coordinate = currentDecisionCoordinateLabel(assessment)
  return coordinate ? `${coordinate} · ${decisionReasonLabel(assessment)}` : decisionReasonLabel(assessment)
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
      return { tone: 'action', label: '原决定保留 · 待复核', detail: '原原因与措施未被改写；请核对后明确维持或更正。', action: '核对证据' }
    }
    if (assessment.explanationValidity.status === 'valid') {
      const decision = assessment.currentDecision.current
      // “已复核”只说明证据基线覆盖到最近修订，不能据此断言维持：
      // 当前决定若由 replace 生成，原决定是 previousId，原因/措施可能已经改变。
      if (decision?.lifecycleAction === 'replace') {
        return decision.previousId != null
          ? { tone: 'done', label: '当前决定已复核', detail: `已追加更正为新决定 #${decision.id}；原决定 #${decision.previousId} 保留。`, action: '查看复核记录' }
          : { tone: 'done', label: '当前决定已复核', detail: `当前决定 #${decision.id} 为首次决定，已登记证据复核。`, action: '查看复核记录' }
      }
      return { tone: 'done', label: '当前决定已复核', detail: '最近证据已登记复核；决定内容仍以当前版本为准。', action: '查看复核记录' }
    }
    return { tone: 'waiting', label: '已有业务决定', detail: '解释有效性未确认：尚无已登记的可核验证据基线。', action: '查看决定' }
  }
  if (assessment.assessment === 'queried_unjudged') {
    return { tone: 'waiting', label: '等待业务判断', detail: '查询完成不等于一致或无需处理。', action: '查看查询范围' }
  }
  if (assessment.assessment === 'not_queried') {
    return { tone: 'muted', label: '尚未查询', detail: '未查询不等于无记录。', action: '查看范围' }
  }
  if (coverage === 'failed') {
    return { tone: 'failed', label: '无法判断 · 查询失败', detail: '失败或授权失败不等于零记录；保留上次结果与查询范围。', action: '查看失败记录' }
  }
  if (coverage === 'partial') {
    return { tone: 'waiting', label: '无法判断 · 覆盖不完整', detail: '平台数据只覆盖部分页，不能据此判断一致或无需处理。', action: '查看已查范围' }
  }
  if (coverage === 'complete') {
    return { tone: 'waiting', label: '已查询 · 判断待核', detail: '查询已完成，但尚没有明确业务决定。', action: '查看查询范围' }
  }
  return { tone: 'waiting', label: '无法判断 · 查询范围待核', detail: '查询范围或主体尚未确认，不能推断为零记录。', action: '查看范围' }
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

/**
 * 一个影响行所指向决定的角色。
 *
 * `decisionId` 是被这条影响坐标引用的决定，不恒等于“当前决定”：
 * 历史、撤回、归并行即使 `oldDecision.isCurrent` 缺失也不能写成当前。
 * 只有 `lineage=current` 且没有被显式标为非当前时才用当前措辞。
 */
export interface ImpactDecisionRef {
  decisionId: number
  lineage: string
  pending: boolean
  oldDecision?: {
    id: number
    isCurrent?: boolean
    lifecycleAction?: string | null
    previousId?: number | null
  } | null
}

export function impactEffectiveLineage(row: ImpactDecisionRef): string {
  return row.lineage === 'current' && row.oldDecision?.isCurrent === false ? 'historical' : row.lineage
}

export function impactDecisionRoleLabel(row: ImpactDecisionRef): string {
  const lineage = impactEffectiveLineage(row)
  if (lineage === 'merged') return '归并前决定'
  if (lineage === 'withdrawn') return '已撤回决定'
  if (lineage === 'historical') return '历史决定'
  if (lineage === 'current') return row.pending ? '待复核的当前决定' : '当前决定'
  return '历史决定'
}

/**
 * 队列行/详情卡的决定坐标。
 *
 * replace 的 `previousId` 只来自 API；API 没给前版时写“首次决定”，
 * 不从 `oldDecision.id` 反推一个源决定。
 */
export function impactDecisionCoordinate(row: ImpactDecisionRef): string {
  const decision = row.oldDecision
  const role = impactDecisionRoleLabel(row)
  const base = `${role} #${row.decisionId}`
  if (role !== '当前决定' && role !== '待复核的当前决定') return base
  if (decision?.lifecycleAction === 'replace') {
    return decision.previousId != null
      ? `${base}（追加更正）· 复核前决定 #${decision.previousId} 保留`
      : `${base}（首次决定）`
  }
  return base
}

/** 表单标题描述“正在复核哪一条决定”，不把当前决定固定叫作原决定。 */
export function impactReviewFormTitle(row: ImpactDecisionRef): string {
  return impactDecisionCoordinate(row)
}

/** 矩阵里原因/措施属于哪一条当前决定；与队列和详情使用同一坐标措辞。 */
export function currentDecisionCoordinateLabel(assessment: ReviewAssessment): string {
  const decision = assessment.currentDecision.current
  return decision ? `当前决定 #${decision.id}` : ''
}

/** 待复核清单里被影响决定的业务摘要；原文不可用时把“不可用”本身说清楚。 */
export function impactOldDecisionText(row: ImpactRow): string {
  const decision = row.oldDecision
  const coordinate = impactDecisionCoordinate(row)
  if (!decision) return `${coordinate}：历史决定原文不可用；原坐标与来源仍保留。`
  const status = DIFFERENCE_STATUSES[decision.status] ?? '状态待核'
  const reason = decision.reasonCode
    ? DIFFERENCE_REASONS[decision.reasonCode] ?? decision.reasonCode
    : '原因未填写'
  const measure = decision.measureCode
    ? DIFFERENCE_MEASURES[decision.measureCode] ?? decision.measureCode
    : '措施未填写'
  const note = decision.reasonNote ? ` · ${decision.reasonNote}` : ''
  return `${coordinate}：${status} · ${reason}${note} · ${measure}`
}
