import { computed, onBeforeUnmount, reactive, type ComputedRef, type InjectionKey } from 'vue'

/**
 * 核对面板的未提交草稿。
 *
 * 草稿按复核项保存在宿主（企业详情页 / 列表 / 抽屉）内存里，结构性卸载
 * （收起、重选、筛选、翻页、父级折叠）只断开视图，不清空草稿；只有明确的
 * “丢弃”动作或页面卸载才清理。草稿只含业务内容，不含凭证、操作人或规则版本。
 */
export interface ReviewDraftDecision {
  status: string
  reasonCode: string
  reasonNote: string
  measureCode: string
  measureNote: string
  evidenceQueryId: string
  evidenceRelationId: string
}

export interface ReviewDraft {
  basis: string
  mode: 'maintain' | 'replace'
  decision: ReviewDraftDecision
}

export interface ReviewDraftStore {
  drafts: Record<string, ReviewDraft>
  draftFor: (impactId: number) => ReviewDraft
  hasDraft: (impactId: number) => boolean
  hasDirty: ComputedRef<boolean>
  discard: (impactId: number) => void
  discardAll: () => void
}

export const REVIEW_DRAFTS_KEY: InjectionKey<ReviewDraftStore> = Symbol('review-drafts')

export function emptyReviewDraftDecision(): ReviewDraftDecision {
  return {
    status: 'confirmed_reason',
    reasonCode: '',
    reasonNote: '',
    measureCode: '',
    measureNote: '',
    evidenceQueryId: '',
    evidenceRelationId: '',
  }
}

export function emptyReviewDraft(): ReviewDraft {
  return {
    basis: '',
    mode: 'maintain',
    decision: emptyReviewDraftDecision(),
  }
}

export function reviewDraftIsDirty(draft: ReviewDraft): boolean {
  if (draft.basis.trim()) return true
  if (draft.mode !== 'maintain') return true
  return Object.entries(draft.decision).some(([key, value]) => key !== 'status' && String(value).trim() !== '')
}

/**
 * 创建一个由当前宿主持有生命周期的草稿仓库。
 *
 * 页面/列表卸载时清空草稿；没有需要随页面隐藏而清理的秘密。
 */
export function useReviewDrafts(): ReviewDraftStore {
  const drafts = reactive<Record<string, ReviewDraft>>({})

  function draftFor(impactId: number): ReviewDraft {
    const key = String(impactId)
    if (!drafts[key]) drafts[key] = emptyReviewDraft()
    return drafts[key]!
  }

  function hasDraft(impactId: number): boolean {
    const draft = drafts[String(impactId)]
    return !!draft && reviewDraftIsDirty(draft)
  }

  function discard(impactId: number) {
    delete drafts[String(impactId)]
  }

  function discardAll() {
    for (const key of Object.keys(drafts)) delete drafts[key]
  }

  const hasDirty = computed(() => Object.values(drafts).some(reviewDraftIsDirty))

  onBeforeUnmount(() => { discardAll() })

  return { drafts, draftFor, hasDraft, hasDirty, discard, discardAll }
}
