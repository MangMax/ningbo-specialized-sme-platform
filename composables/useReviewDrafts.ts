import { createInitialDecisionState, initialDecisionNeedsGuard, type InitialDecisionState } from '../layers/sme-roster/app/composables/useInitialDifferenceDecision'
import type { ReviewDecisionDraft, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import { computed, onBeforeUnmount, reactive, type ComputedRef, type InjectionKey } from 'vue'

/**
 * 核对面板的未提交草稿。
 *
 * 草稿按复核项保存在宿主（企业详情页 / 列表 / 抽屉）内存里，结构性卸载
 * （收起、重选、筛选、翻页、父级折叠）只断开视图，不清空草稿；可编辑草稿由明确的
 * “丢弃”动作清理；首次登记的请求/回执在收起、切换或丢弃时保留到宿主页面卸载。
 * 只含业务内容与提交进度，不含凭证、操作人或规则版本。
 */
export type ReviewDraftDecision = ReviewDecisionDraft

export interface EvidenceReviewSubmission {
  retry: { signature: string; body: Record<string, unknown> } | null
  pending: boolean
  unknown: boolean
  committed: boolean
  failure: string
  conflict: boolean
}

export interface ReviewDraft {
  reviewSubmission?: EvidenceReviewSubmission
  /** Initial registration only: host-memory business command/receipt, never credentials. */
  initialSubmission?: InitialDecisionState
  basis: string
  mode: 'maintain' | 'replace'
  decision: ReviewDraftDecision
}

export interface ReviewDraftStore {
  register: (source: { dirty: () => boolean; locked: () => boolean; discard: () => void }) => () => void
  hasLocked: ComputedRef<boolean>
  drafts: Record<string, ReviewDraft>
  draftFor: (impactId: number) => ReviewDraft
  hasDraft: (impactId: number) => boolean
  hasDirty: ComputedRef<boolean>
  discard: (impactId: number | string) => void
  discardAll: () => void
  initialFor: (scope: ReviewScope) => InitialDecisionState
  ownsInitial: (scope: ReviewScope, session: InitialDecisionState) => boolean
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
  if (draft.reviewSubmission?.committed) return false
  if (draft.reviewSubmission?.unknown || draft.reviewSubmission?.pending) return true
  if (draft.initialSubmission) return initialDecisionNeedsGuard(draft.initialSubmission)
  if (draft.basis.trim()) return true
  if (draft.mode !== 'maintain') return true
  return Object.entries(draft.decision).some(([key, value]) => key !== 'status' && key !== 'factReferences' && String(value).trim() !== '')
}

/**
 * 创建一个由当前宿主持有生命周期的草稿仓库。
 *
 * 页面/列表卸载时清空草稿；没有需要随页面隐藏而清理的秘密。
 */
export function useReviewDrafts(): ReviewDraftStore {
  const drafts = reactive<Record<string, ReviewDraft>>({})
  const sources = reactive(new Set<{ dirty: () => boolean; locked: () => boolean; discard: () => void }>())
  function register(source: { dirty: () => boolean; locked: () => boolean; discard: () => void }) {
    sources.add(source)
    return () => { sources.delete(source) }
  }
  const hasLocked = computed(() => [...sources].some(source => source.locked()) || Object.values(drafts).some(draft => draft.reviewSubmission?.pending || draft.reviewSubmission?.unknown))
  let alive = true
  const initialKey = (scope: ReviewScope) => `initial:${scope.enterpriseId}:${scope.titleCode}:${scope.direction}`
  function initialFor(scope: ReviewScope): InitialDecisionState {
    const key = initialKey(scope), retained = drafts[key]
    const session = retained?.initialSubmission ?? createInitialDecisionState(scope)
    if (retained && !retained.initialSubmission) { session.basis = retained.basis; session.draft = { ...retained.decision } }
    if (!alive) throw new Error('Review draft host has ended')
    // Even a clean session has an owner; dirty remains based only on business/request state.
    drafts[key] = { basis: session.basis, mode: 'replace', decision: { ...session.draft }, initialSubmission: session }
    return drafts[key]!.initialSubmission!
  }
  function ownsInitial(scope: ReviewScope, session: InitialDecisionState): boolean {
    return alive && drafts[initialKey(scope)]?.initialSubmission === session
  }

  function draftFor(impactId: number): ReviewDraft {
    const key = String(impactId)
    if (!drafts[key]) drafts[key] = emptyReviewDraft()
    return drafts[key]!
  }

  function hasDraft(impactId: number): boolean {
    const draft = drafts[String(impactId)]
    return !!draft && reviewDraftIsDirty(draft)
  }

  function discard(impactId: number | string) {
    const key = String(impactId)
    const review = drafts[key]?.reviewSubmission
    if (!drafts[key]?.initialSubmission?.request && !review?.pending && !review?.unknown && !review?.committed) delete drafts[key]
  }

  function discardAll() {
    if (hasLocked.value) return
    for (const source of sources) source.discard()
    // Discard editable fields, not an unresolved or receipted command. Reopening must recover its identity.
    for (const key of Object.keys(drafts)) discard(key)
  }

  const hasDirty = computed(() => Object.values(drafts).some(reviewDraftIsDirty) || [...sources].some(source => source.dirty()))

  // The owner page is the lifetime boundary; no localStorage/sessionStorage or credential persistence.
  onBeforeUnmount(() => { alive = false; sources.clear(); for (const key of Object.keys(drafts)) delete drafts[key] })

  return { register, hasLocked, drafts, draftFor, hasDraft, hasDirty, discard, discardAll, initialFor, ownsInitial }
}
