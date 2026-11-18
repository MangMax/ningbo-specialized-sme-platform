import type { ImpactDetail } from '../../../../lib/roster/evidence-review-ui'

export type ReviewEligibility = {
  eligible: boolean
  /** 不可复核时给用户看的真实原因；可复核时为空串。 */
  reason: string
}

/**
 * 复核写入资格只由读回的决定/证据坐标决定。
 *
 * 已复核、历史、撤回、归并、原文缺失、影响检查未完成都不渲染可编辑表单；
 * 这里的判断与表单 canSubmit 共用，避免详情和按钮各说一套。
 */
export function reviewEligibility(detail: ImpactDetail): ReviewEligibility {
  if (!detail.pending) {
    return { eligible: false, reason: '该项已登记复核；已复核记录不提供再次提交入口。' }
  }
  if (detail.lineage !== 'current') {
    return { eligible: false, reason: '该项处于历史、撤回或归并坐标，只读；不替代当前决定。' }
  }
  if (detail.gaps.decisionUnavailable || !detail.oldDecision) {
    return { eligible: false, reason: '原决定原文不可用，只读；不对缺失决定补写或重新提交。' }
  }
  if (!detail.currentDecision?.current) {
    return { eligible: false, reason: '当前决定不可用，只读；请重新读取当前状态。' }
  }
  if (detail.currentDecision.versionId !== detail.decisionId) {
    return {
      eligible: false,
      reason: `当前决定版本 #${detail.currentDecision.versionId} 与该项决定 #${detail.decisionId} 不一致，只读；请重新读取当前状态。`,
    }
  }
  if (detail.evidenceToken.decisionId !== detail.decisionId) {
    return { eligible: false, reason: '证据版本与该项决定不一致，只读；请重新读取当前状态。' }
  }
  if (!detail.evidenceToken.projectionReady) {
    return { eligible: false, reason: '影响检查尚未完成，只读；完成前不能提交复核。' }
  }
  return { eligible: true, reason: '' }
}
