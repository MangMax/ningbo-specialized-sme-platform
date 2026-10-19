import { computed, onBeforeUnmount, onMounted, reactive, type ComputedRef, type InjectionKey } from 'vue'

/**
 * 核对面板的未提交草稿。
 *
 * 草稿按复核项保存在宿主（企业详情页 / 列表 / 抽屉）内存里，结构性卸载
 * （收起、重选、筛选、翻页、父级折叠）只断开视图，不清空草稿；只有明确的
 * “丢弃”动作、页面卸载或 pagehide 才清理。凭证只存在内存，pagehide 时清空。
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
  token: string
  actor: string
  basis: string
  ruleVersion: string
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
  clearTokens: () => void
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
    token: '',
    actor: '',
    basis: '',
    ruleVersion: '',
    mode: 'maintain',
    decision: emptyReviewDraftDecision(),
  }
}

export function reviewDraftIsDirty(draft: ReviewDraft): boolean {
  if (draft.token.trim() || draft.actor.trim() || draft.basis.trim() || draft.ruleVersion.trim()) return true
  if (draft.mode !== 'maintain') return true
  return Object.entries(draft.decision).some(([key, value]) => key !== 'status' && String(value).trim() !== '')
}

/**
 * 创建一个由当前宿主持有生命周期的草稿仓库。
 *
 * 页面/列表卸载时清空凭证与草稿；pagehide 时只清空凭证，其他待填写内容保留。
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

  function clearTokens() {
    for (const draft of Object.values(drafts)) draft.token = ''
  }

  const hasDirty = computed(() => Object.values(drafts).some(reviewDraftIsDirty))

  function onPageHide() { clearTokens() }
  onMounted(() => window.addEventListener('pagehide', onPageHide))
  onBeforeUnmount(() => {
    window.removeEventListener('pagehide', onPageHide)
    clearTokens()
    discardAll()
  })

  return { drafts, draftFor, hasDraft, hasDirty, discard, discardAll, clearTokens }
}
