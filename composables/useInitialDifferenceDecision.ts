import { computed, ref, shallowRef } from 'vue'
import type { DecisionVersion, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import { DIFFERENCE_MEASURES, DIFFERENCE_REASONS } from '~~/lib/labels'

export interface InitialDecisionHead extends ReviewScope { versionId: number | null; current: DecisionVersion | null }
interface InitialDecisionApi {
  context: () => Promise<{ writeEnabled?: boolean }>
  current: () => Promise<InitialDecisionHead>
  post: (body: Record<string, unknown>) => Promise<{ versionId: number }>
}
/** Owns one exact scope and one unresolved command. No impact or evidence review is invented. */
export function useInitialDifferenceDecision(scope: ReviewScope, api: InitialDecisionApi) {
  const basis = ref('')
  const draft = ref({ status: '', reasonCode: '', reasonNote: '', measureCode: '', measureNote: '', evidenceQueryId: '', evidenceRelationId: '' })
  const head = shallowRef<InitialDecisionHead | null>(null)
  const writeState = ref<'loading' | 'ready' | 'readonly' | 'unavailable'>('loading')
  const phase = ref<'loading' | 'ready' | 'saving' | 'conflict' | 'unknown' | 'readback' | 'saved' | 'error'>('loading')
  const message = ref('')
  const correctionAccepted = ref(false)
  const committed = ref(false)
  let request: Record<string, unknown> | null = null
  const busy = ref(false)
  const dirty = computed(() => !committed.value && (!!basis.value || Object.values(draft.value).some(Boolean) || phase.value === 'unknown'))
  const locked = computed(() => committed.value || ['saving', 'unknown', 'loading'].includes(phase.value))
  const validId = (id: string) => !id || /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))
  const decisionReady = computed(() => {
    const d = draft.value
    return Object.hasOwn(DIFFERENCE_MEASURES, d.measureCode)
      && (d.status === 'confirmed_no_diff' ? d.measureCode === 'none'
        : d.status === 'confirmed_reason' && Object.hasOwn(DIFFERENCE_REASONS, d.reasonCode) && (d.reasonCode !== 'pending_review' || d.measureCode === 'follow_review'))
      && validId(d.evidenceQueryId) && validId(d.evidenceRelationId)
  })
  const canSave = computed(() => !busy.value && phase.value === 'ready' && writeState.value === 'ready' && !!head.value
    && (!head.value.current || correctionAccepted.value) && !!basis.value.trim() && basis.value.trim().length <= 4000 && decisionReady.value)
  function begin() { if (phase.value === 'ready') correctionAccepted.value = true }
  async function readHead() {
    const value = await api.current()
    if (!value || !Object.hasOwn(value, 'current') || value.current === undefined || value.enterpriseId !== scope.enterpriseId || value.titleCode !== scope.titleCode || value.direction !== scope.direction
      || !(value.versionId === null || Number.isSafeInteger(value.versionId) && value.versionId > 0)
      || (value.current != null && value.current.id !== value.versionId)) throw new Error('Invalid scope head')
    head.value = value
  }
  async function load() {
    // An unknown response must be resolved with the original command, never by making a new request.
    if (busy.value || phase.value === 'unknown') return
    busy.value = true
    phase.value = committed.value ? 'readback' : 'loading'
    message.value = ''
    correctionAccepted.value = false
    try {
      if (!committed.value) {
        writeState.value = 'loading'
        try {
          const context = await api.context()
          writeState.value = context?.writeEnabled === true ? 'ready' : context?.writeEnabled === false ? 'readonly' : 'unavailable'
        }
        catch { writeState.value = 'unavailable' }
      }
      await readHead()
      phase.value = committed.value ? 'saved' : 'ready'
      if (committed.value) message.value = '已提交并读回当前决定；原决定和历史保留。'
    } catch {
      phase.value = committed.value ? 'readback' : 'error'
      message.value = committed.value ? '判断已提交，当前决定读回失败。请仅重试读取，不要重复登记。' : '当前决定读取失败；填写内容保留，读取成功前只读。'
    } finally { busy.value = false }
  }
  async function save() {
    if (busy.value || committed.value || (!canSave.value && phase.value !== 'unknown')) return
    if (!request) {
      const d = draft.value
      request = { ...scope, action: 'replace', expectedCurrentId: head.value!.versionId, basis: basis.value.trim(),
        effectiveAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
        decision: { status: d.status, reasonCode: d.status === 'confirmed_no_diff' ? null : d.reasonCode,
          reasonNote: d.reasonNote.trim() || null, measureCode: d.measureCode, measureNote: d.measureNote.trim() || null,
          verificationStatus: 'confirmed', evidenceQueryId: d.evidenceQueryId ? Number(d.evidenceQueryId) : null,
          evidenceRelationId: d.evidenceRelationId ? Number(d.evidenceRelationId) : null } }
    }
    busy.value = true; phase.value = 'saving'; message.value = ''
    try {
      const receipt = await api.post(request)
      // Malformed success remains unknown; do not generate another key.
      if (!Number.isSafeInteger(receipt?.versionId) || receipt.versionId <= 0) throw new Error('Invalid receipt')
      committed.value = true
      phase.value = 'readback'
    } catch (error) {
      const e = error as { status?: number; statusCode?: number; data?: { error?: { code?: string } } }
      const code = e?.data?.error?.code
      if (['stale_version', 'stale_evidence', 'idempotency_conflict'].includes(code ?? '') || e.status === 409 || e.statusCode === 409) {
        phase.value = 'conflict'; request = null
        message.value = '当前决定已变化或提交冲突。草稿保留；请重新读取当前决定，核对后明确追加更正。'
      } else if (['browser_review_disabled', 'origin_required', 'origin_mismatch', 'cross_site_request', 'unsupported_media_type', 'invalid_request', 'evidence_mismatch', 'evidence_not_found', 'invalid_prior_time'].includes(code ?? '')) {
        phase.value = 'ready'; request = null
        if (code === 'browser_review_disabled') writeState.value = 'readonly'
        message.value = '提交未被接受，填写内容保留。请核对业务字段或重新读取页面提交能力。'
      } else {
        phase.value = 'unknown'
        message.value = '提交结果尚不能确认。填写内容已锁定；请重试同一次提交，系统会复用原提交标识。'
      }
    } finally { busy.value = false }
    if (committed.value) await load()
  }
  return { basis, draft, head, writeState, phase, message, correctionAccepted, dirty, locked, canSave, begin, load, save }
}
