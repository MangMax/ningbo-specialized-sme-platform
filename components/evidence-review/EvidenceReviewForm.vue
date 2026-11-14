<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, reactive, toRefs, shallowRef, useId, watch, type Ref } from 'vue'
import type { ImpactDetail } from '~~/lib/roster/evidence-review-ui'
import { reviewEligibility } from '~~/lib/roster/review-eligibility'
import { impactReviewFormTitle } from '~~/lib/roster/review-display'
import { useEvidenceReviewRefresh } from '~/composables/useEvidenceReviewRefresh'
import { REVIEW_DRAFTS_KEY, emptyReviewDraftDecision, type ReviewDraftStore, type EvidenceReviewSubmission } from '~/composables/useReviewDrafts'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import ReplacementDecisionFields from './ReplacementDecisionFields.vue'
import EnterpriseFactReferences from '@/components/enterprise/EnterpriseFactReferences.vue'

const props = defineProps<{ detail: ImpactDetail; refreshing?: boolean; readFailed?: boolean; footer?: boolean }>()
const emit = defineEmits<{ saved: [{ action?: string; versionId?: number }?]; reload: [] }>()
const refreshAffected = useEvidenceReviewRefresh()
const BROWSER_CONTEXT_PATH = '/api/roster/evidence-review/browser-context'
const BROWSER_COMMAND_PATH = '/api/roster/evidence-review/browser-commands'
/**
 * 草稿仓库由宿主提供（企业详情页/清单/抽屉）。没有宿主时组件自己保留到卸载，
 * 让单组件测试和独立使用仍能在同一挂载周期内保存草稿。
 */
const draftStore = inject<ReviewDraftStore | null>(REVIEW_DRAFTS_KEY, null)
const storedDraft = draftStore?.draftFor(props.detail.id)
const basis = shallowRef(storedDraft?.basis ?? '')
// The host owns the envelope through close/reopen and structural unmounts.
if (storedDraft && !storedDraft.reviewSubmission) storedDraft.reviewSubmission = { retry: null, pending: false, unknown: false, committed: false, failure: '', conflict: false }
const submission = storedDraft?.reviewSubmission ?? reactive<EvidenceReviewSubmission>({ retry: null, pending: false, unknown: false, committed: false, failure: '', conflict: false })
const { pending, failure, conflict, committed, retry, unknown } = toRefs(submission)
const failureEl = shallowRef<HTMLElement | { $el?: HTMLElement } | null>(null)
const mode = shallowRef<'maintain' | 'replace'>(storedDraft?.mode ?? 'maintain')
const choiceId = useId()
/** Sheet 模式把主操作放进独立 footer；button[form] 仍提交同一张表单。 */
const formId = useId()
const writeStatusId = useId()
watch(() => props.detail, () => { if (conflict.value) failure.value = ''; conflict.value = false })

const inheritedReferences = props.detail.currentDecision?.current?.factReferences
const draft = ref({ ...emptyReviewDraftDecision(), ...(storedDraft?.decision ?? {}),
  ...(storedDraft?.decision.factReferences == null && inheritedReferences?.length ? { factReferences: [...inheritedReferences] } : {}) })
const factReferencesReady = ref(true)
const canReplay = computed(() => unknown.value || (!!retry.value && !!props.detail.currentDecision && retry.value.signature === JSON.stringify(currentContent())))
watch([basis, mode, draft], () => {
  if (!storedDraft) return
  storedDraft.basis = basis.value
  storedDraft.mode = mode.value
  storedDraft.decision = { ...draft.value }
}, { deep: true, immediate: true, flush: 'sync' })

// A completed command protects its own revision, not a later source change.
watch(() => props.detail.evidenceToken.latestRevisionId, revision => {
  const submittedRevision = (retry.value?.body.reviewedEvidence as { latestRevisionId?: number } | undefined)?.latestRevisionId
  if (!committed.value || pending.value || submittedRevision == null || revision <= submittedRevision) return
  retry.value = null; committed.value = false; unknown.value = false; conflict.value = false; failure.value = ''
  basis.value = ''; mode.value = 'maintain'; draft.value = emptyReviewDraftDecision()
}, { immediate: true })

/**
 * 页面是否可以提交只由服务端的部署能力决定；它不识别操作人，也不向页面提供凭证。
 * 读取失败按“只读”处理（fail closed），并允许只重试这一项检查。
 */
type WriteState = 'loading' | 'ready' | 'readonly' | 'unavailable'
const writeState = shallowRef<WriteState>('loading')
let contextAttempt = 0
async function loadWriteContext() {
  const attempt = ++contextAttempt
  writeState.value = 'loading'
  try {
    const context = await $fetch<{ writeEnabled?: boolean }>(BROWSER_CONTEXT_PATH)
    if (attempt !== contextAttempt) return
    writeState.value = context?.writeEnabled === true ? 'ready' : 'readonly'
  } catch {
    if (attempt !== contextAttempt) return
    writeState.value = 'unavailable'
  }
}
onMounted(loadWriteContext)
const writeReady = computed(() => writeState.value === 'ready')
const writeStatus = computed(() => {
  if (writeState.value === 'loading') return '正在确认页面提交是否已开启…'
  if (writeState.value === 'unavailable') return '复核暂为只读：无法确认页面提交是否已开启。'
  if (writeState.value === 'readonly') return '复核暂为只读：尚未开启页面提交。'
  return ''
})

/**
 * 页面可能用标签页承载核对；切页会卸载本表单。
 * 把“有未提交内容”上报给宿主，由宿主先确认再切，不静默丢掉草稿。
 */
const externalDraft = inject<Ref<boolean> | null>('enterprise-review-draft', null)
const isDirty = computed(() =>
  !!basis.value.trim()
  || mode.value !== 'maintain'
  || Object.entries(draft.value).some(([key, value]) => key !== 'status' && key !== 'factReferences' && String(value).trim() !== ''),
)
watch(isDirty, value => { if (externalDraft && !draftStore) externalDraft.value = value }, { immediate: true })
const validId = (id: string) => !id || (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)))
const replacementReady = computed(() => !!draft.value.measureCode && (draft.value.status === 'confirmed_no_diff' ? draft.value.measureCode === 'none' : !!draft.value.reasonCode && (draft.value.reasonCode !== 'pending_review' || draft.value.measureCode === 'follow_review')) && validId(draft.value.evidenceQueryId) && validId(draft.value.evidenceRelationId))
const eligibility = computed(() => reviewEligibility(props.detail))
const eligible = computed(() => eligibility.value.eligible)
const canSubmit = computed(() => writeReady.value && !pending.value && !props.refreshing && (unknown.value || (eligible.value && !conflict.value && !committed.value && !props.readFailed && (mode.value === 'maintain' || replacementReady.value && (factReferencesReady.value || canReplay.value)) && !!basis.value.trim())))

/** 禁用主按钮时把缺项说出来；不在界面上留一个没有原因的灰按钮。 */
const missingFields = computed(() => {
  const missing: string[] = []
  if (!basis.value.trim()) missing.push('复核依据')
  if (mode.value === 'replace' && !factReferencesReady.value && !canReplay.value) missing.push('可用的主体事实引用')
  if (mode.value === 'replace' && !replacementReady.value) {
    if (draft.value.status === 'confirmed_reason' && !draft.value.reasonCode) missing.push('更正原因')
    if (!draft.value.measureCode) missing.push('更正措施')
    if (!validId(draft.value.evidenceQueryId)) missing.push('查询证据 ID')
    if (!validId(draft.value.evidenceRelationId)) missing.push('平台原行 ID')
  }
  return missing
})
const blockedReason = computed(() => {
  if (unknown.value) return '提交结果未知，原请求已保留。请使用原请求重试，或重新读取当前状态；确认前不能修改内容。'
  if (committed.value) return '复核已提交，正在等待读回当前状态；请重新读取确认。'
  if (!eligible.value) return '该项当前不可完成复核：历史、撤回、归并或尚未完成影响检查。请重新读取当前状态。'
  // 写能力未就绪时，状态行已经说明原因；缺业务项不再压过它。
  if (!writeReady.value) return ''
  if (conflict.value) return '当前决定或证据版本已变化。请先重新读取当前状态，再提交。'
  if (props.readFailed) return '来源变化详情读取失败；草稿保留，请重新读取当前状态后再保存。'
  if (pending.value || props.refreshing) return '正在读取或保存，请稍候。'
  if (!missingFields.value.length) return ''
  return `提交前还需填写：${missingFields.value.join('、')}。`
})
const submitDescribedBy = computed(() => {
  if (eligible.value && writeStatus.value) return writeStatusId
  return blockedReason.value ? 'review-submit-blocked-reason' : undefined
})

function currentContent() {
  return { action: mode.value, enterpriseId: props.detail.enterpriseId, titleCode: props.detail.titleCode, direction: props.detail.direction,
    expectedCurrentId: props.detail.currentDecision!.versionId,
    reviewedEvidence: { latestRevisionId: props.detail.evidenceToken.latestRevisionId, projectionReady: true },
    basis: basis.value.trim(),
    ...(mode.value === 'replace' ? { decision: { status: draft.value.status, reasonCode: draft.value.status === 'confirmed_no_diff' ? null : draft.value.reasonCode,
      reasonNote: draft.value.reasonNote.trim() || null, measureCode: draft.value.measureCode, measureNote: draft.value.measureNote.trim() || null,
      verificationStatus: 'confirmed', evidenceQueryId: draft.value.evidenceQueryId ? Number(draft.value.evidenceQueryId) : null,
      evidenceRelationId: draft.value.evidenceRelationId ? Number(draft.value.evidenceRelationId) : null,
      ...(draft.value.factReferences?.length ? { factReferences: draft.value.factReferences } : {}) } } : {}) }
}

/**
 * 失败原因必须出现在当前屏：Sheet 的主操作在滚动区外，滚动正文里的旧错误
 * 用户看不到。focus 到 footer 内的错误本身，读屏和键盘用户也能立即知道结果。
 */
async function revealFailure() {
  await nextTick()
  await nextTick()
  const value = failureEl.value
  const target = value
    ? (typeof HTMLElement !== 'undefined' && value instanceof HTMLElement ? value : (value as { $el?: HTMLElement }).$el ?? null)
    : null
  target?.focus({ preventScroll: true })
  // 内联：把错误和紧随其后的提交动作一起放进当前屏；Sheet 的 footer 已在滚动区外。
  if (!props.footer) target?.scrollIntoView?.({ block: 'center' })
}
onBeforeUnmount(() => {
  // 有宿主草稿仓库时，结构性卸载（收起/切换/翻页）不能清草稿；仓库自己处理卸载。
  if (externalDraft && !draftStore) externalDraft.value = false
})

async function save() {
  if (!canSubmit.value) return
  pending.value = true; failure.value = ''
  const content = unknown.value && retry.value ? retry.value.body : currentContent()
  const signature = unknown.value && retry.value ? retry.value.signature : JSON.stringify(content)
  const body = retry.value && (unknown.value || retry.value.signature === signature) ? retry.value.body : JSON.parse(JSON.stringify({ ...content, effectiveAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID() }))
  retry.value = { signature, body }
  try {
    // 浏览器不携带 Authorization；部署能力与同源闸门由服务端判定。
    const saved = await $fetch<{ action?: string; versionId?: number }>(BROWSER_COMMAND_PATH, { method: 'POST', body })
    unknown.value = false
    committed.value = true
    // 保留已提交请求，避免重开旧详情再次写入；读回失败不反报为保存失败。
    emit('saved', { action: saved?.action, versionId: saved?.versionId })
    try { await refreshAffected() } catch { /* 宿主详情仍会显式读回并说明状态 */ }
  } catch (error) {
    const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
    unknown.value = unknown.value || !['fact_reference_mismatch', 'stale_version', 'stale_evidence', 'unauthorized', 'origin_required', 'origin_mismatch', 'cross_site_request', 'unsupported_media_type', 'idempotency_conflict', 'transaction_failed', 'invalid_request'].includes(code ?? '')
    // Only translate known codes. Raw responses can contain credentials and are never rendered.
    failure.value = unknown.value ? '提交结果未知，原请求已保留。请使用原请求重试或重新读取当前状态。'
      : code === 'fact_reference_mismatch' ? '关联事实已变化，草稿保留。请刷新可关联事实并重新选择后提交。'
      : code === 'stale_version' ? '决定版本冲突。请重新读取当前决定，核对后再提交。'
      : code === 'stale_evidence' ? '证据版本冲突或影响检查尚未完成。请重新读取后复核。'
      : ['unauthorized', 'origin_required', 'origin_mismatch', 'cross_site_request', 'unsupported_media_type'].includes(code ?? '')
        ? '这次提交没被接受：页面提交未开启或授权已失效。依据还在，重新读取后再试。'
      : code === 'idempotency_conflict' ? '提交标识冲突。请重新读取并核对当前决定。'
      : '复核保存失败，待复核状态保留。请重试；同一请求会复用提交标识。'
    if (['stale_version', 'stale_evidence', 'idempotency_conflict'].includes(code ?? '')) conflict.value = true
    if (code === 'fact_reference_mismatch' && !unknown.value) retry.value = null
    await revealFailure()
  } finally { pending.value = false }
}
</script>

<template>
  <form :id="formId" class="flex min-w-0 flex-col gap-3" @submit.prevent="save">
    <div class="bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold">{{ impactReviewFormTitle(detail) }}</h3>
        <Badge variant="outline" class="font-normal">
          {{ mode === 'maintain' ? '维持原决定' : '追加更正' }}
        </Badge>
      </div>

      <div
        v-if="!eligible"
        data-testid="review-readonly"
        role="status"
        class="bg-muted/20 flex min-w-0 flex-col gap-0.5 rounded-md border px-3 py-2 text-[13px] leading-5"
      >
        <p class="text-foreground font-medium">当前只读</p>
        <p class="text-muted-foreground">{{ eligibility.reason }}</p>
      </div>
      <div
        v-else-if="writeStatus"
        :id="writeStatusId"
        role="status"
        aria-live="polite"
        data-testid="review-write-status"
        class="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5"
      >
        <span>{{ writeStatus }}</span>
        <button
          v-if="writeState === 'unavailable'"
          type="button"
          class="text-primary font-medium hover:underline"
          @click="loadWriteContext"
        >
          重新检查
        </button>
      </div>

      <fieldset class="flex flex-col gap-3" :disabled="pending || refreshing || !eligible || unknown || committed">
        <legend class="sr-only">复核信息</legend>

        <label class="flex min-w-0 flex-col gap-1 text-[13px]">
          <span>复核依据 <span class="text-destructive" aria-hidden="true">*</span></span>
          <Textarea v-model="basis" aria-label="复核依据" maxlength="4000" :rows="3" required placeholder="这次改变了什么、依据哪份材料，维持或更正的理由。" />
        </label>

        <fieldset class="flex flex-col gap-2">
          <legend class="text-[13px] font-medium">处理方式</legend>
          <div class="grid gap-2 sm:grid-cols-2">
            <label class="hover:bg-accent/40 flex cursor-pointer items-start gap-2 rounded-md border p-3 text-[13px] leading-5">
              <input v-model="mode" type="radio" :name="choiceId" value="maintain" class="mt-0.5" />
              <span>
                <span class="block font-medium">维持原决定</span>
                <span class="text-muted-foreground">保留原原因、措施和历史，只登记本次证据复核。</span>
              </span>
            </label>
            <label class="hover:bg-accent/40 flex cursor-pointer items-start gap-2 rounded-md border p-3 text-[13px] leading-5">
              <input v-model="mode" type="radio" :name="choiceId" value="replace" class="mt-0.5" />
              <span>
                <span class="block font-medium">追加更正</span>
                <span class="text-muted-foreground">新增一个决定版本；原决定保留在历史，不会被撤回。</span>
              </span>
            </label>
          </div>
        </fieldset>

        <ReplacementDecisionFields v-if="mode === 'replace'" v-model="draft" />
        <EnterpriseFactReferences v-if="mode === 'replace'" :enterprise-id="detail.enterpriseId" :model-value="draft.factReferences ?? []" editable @update:model-value="draft.factReferences = $event" @validity="factReferencesReady = $event" />
        <p v-else class="text-muted-foreground text-[13px] leading-5">
          明确维持原决定：不会改写原原因或措施，也不会新增业务决定版本。
        </p>
      </fieldset>

      <Alert
        v-if="failure && !footer"
        ref="failureEl"
        variant="destructive"
        tabindex="-1"
        data-testid="review-save-error"
        class="scroll-mt-14 focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none"
      >
        <AlertDescription>{{ failure }}</AlertDescription>
      </Alert>

      <p
        v-if="blockedReason"
        id="review-submit-blocked-reason"
        class="text-muted-foreground text-[13px] leading-5"
        data-testid="review-submit-blocked-reason"
      >
        {{ blockedReason }}
      </p>

      <!--
        Sheet 里主操作放在滚动区外的 footer（由宿主的 #review-sheet-footer 承载），
        不压住正文或输入框；内联展开时保持普通文档流。
      -->
      <Teleport v-if="footer" to="#review-sheet-footer" defer>
        <div class="bg-card flex flex-col gap-2">
          <!-- 失败原因和主操作同处 footer，390 当前屏就能看到；正文里不再重复第二处。 -->
          <Alert
            v-if="failure"
            ref="failureEl"
            variant="destructive"
            tabindex="-1"
            data-testid="review-save-error"
            class="focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none"
          >
            <AlertDescription>{{ failure }}</AlertDescription>
          </Alert>
          <div class="flex flex-wrap gap-2">
            <Button type="submit" :form="formId" :disabled="!canSubmit" :aria-describedby="submitDescribedBy">
              {{ pending ? '保存中…' : unknown ? '使用原请求重试' : mode === 'maintain' ? '维持原决定并完成复核' : '追加更正并完成复核' }}
            </Button>
            <Button type="button" variant="outline" :disabled="pending || refreshing" @click="emit('reload')">重新读取当前状态</Button>
          </div>
        </div>
      </Teleport>
      <div v-else class="bg-card flex flex-wrap gap-2">
        <Button type="submit" :disabled="!canSubmit" :aria-describedby="submitDescribedBy">
          {{ pending ? '保存中…' : unknown ? '使用原请求重试' : mode === 'maintain' ? '维持原决定并完成复核' : '追加更正并完成复核' }}
        </Button>
        <Button type="button" variant="outline" :disabled="pending || refreshing" @click="emit('reload')">重新读取当前状态</Button>
      </div>
    </div>
  </form>
</template>
