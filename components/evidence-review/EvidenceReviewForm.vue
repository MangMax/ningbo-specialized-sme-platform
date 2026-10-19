<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import type { ImpactDetail } from '~~/lib/roster/evidence-review-ui'
import { useEvidenceReviewRefresh } from '~/composables/useEvidenceReviewRefresh'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import ReplacementDecisionFields from './ReplacementDecisionFields.vue'
const props = defineProps<{ detail: ImpactDetail; refreshing?: boolean }>()
const emit = defineEmits<{ saved: []; reload: [] }>()
const refreshAffected = useEvidenceReviewRefresh()
const token = shallowRef('')
const actor = shallowRef('')
const basis = shallowRef('')
const ruleVersion = shallowRef('')
const pending = shallowRef(false)
const failure = shallowRef('')
const mode = shallowRef('maintain')
const choiceId = useId()
const conflict = shallowRef(false)
watch(() => props.detail, () => { if (conflict.value) failure.value = ''; conflict.value = false })
const draft = ref({ status: 'confirmed_reason', reasonCode: '', reasonNote: '', measureCode: '', measureNote: '', evidenceQueryId: '', evidenceRelationId: '' })
const validId = (id: string) => !id || (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)))
const replacementReady = computed(() => !!draft.value.measureCode && (draft.value.status === 'confirmed_no_diff' ? draft.value.measureCode === 'none' : !!draft.value.reasonCode && (draft.value.reasonCode !== 'pending_review' || draft.value.measureCode === 'follow_review')) && validId(draft.value.evidenceQueryId) && validId(draft.value.evidenceRelationId))
const eligible = computed(() => props.detail.pending && props.detail.oldDecision != null && !props.detail.gaps.decisionUnavailable && props.detail.lineage === 'current' && props.detail.currentDecision?.current != null && props.detail.currentDecision.versionId === props.detail.decisionId && props.detail.evidenceToken.decisionId === props.detail.decisionId && props.detail.evidenceToken.projectionReady)
const canSubmit = computed(() => eligible.value && !conflict.value && (mode.value === 'maintain' || replacementReady.value) && !pending.value && !props.refreshing && !!token.value.trim() && !!actor.value.trim() && !!basis.value.trim() && !!ruleVersion.value.trim())
let retry: { signature: string; body: Record<string, unknown> } | null = null
function clearToken() { token.value = '' }
onMounted(() => window.addEventListener('pagehide', clearToken))
onBeforeUnmount(() => { window.removeEventListener('pagehide', clearToken); clearToken(); retry = null })
async function save() {
  if (!canSubmit.value) return
  pending.value = true; failure.value = ''
  const content = { action: mode.value, enterpriseId: props.detail.enterpriseId, titleCode: props.detail.titleCode, direction: props.detail.direction,
    expectedCurrentId: props.detail.currentDecision!.versionId,
    reviewedEvidence: { latestRevisionId: props.detail.evidenceToken.latestRevisionId, projectionReady: true },
    actor: { type: 'user', id: actor.value.trim() }, basis: basis.value.trim(), ruleVersion: ruleVersion.value.trim(),
    ...(mode.value === 'replace' ? { decision: { status: draft.value.status, reasonCode: draft.value.status === 'confirmed_no_diff' ? null : draft.value.reasonCode,
      reasonNote: draft.value.reasonNote.trim() || null, measureCode: draft.value.measureCode, measureNote: draft.value.measureNote.trim() || null,
      verificationStatus: 'confirmed', evidenceQueryId: draft.value.evidenceQueryId ? Number(draft.value.evidenceQueryId) : null,
      evidenceRelationId: draft.value.evidenceRelationId ? Number(draft.value.evidenceRelationId) : null } } : {}) }
  const signature = JSON.stringify(content)
  const body = retry?.signature === signature ? retry.body : { ...content, effectiveAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID() }
  retry = { signature, body }
  try {
    await $fetch('/api/roster/decision-lifecycle/commands', { method: 'POST', headers: { authorization: `Bearer ${token.value.trim()}` }, body })
    retry = null
    await refreshAffected()
    emit('saved')
  } catch (error) {
    const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
    // Only translate known codes. Raw responses can contain credentials and are never rendered.
    failure.value = code === 'stale_version' ? '决定版本冲突。请重新读取当前决定，核对后再提交。'
      : code === 'stale_evidence' ? '证据版本冲突或影响检查尚未完成。请重新读取后复核。'
      : code === 'unauthorized' ? '没有改判权限或写入凭证已失效。仍可只读查看。'
      : code === 'idempotency_conflict' ? '提交标识冲突。请重新读取并核对当前决定。'
      : '复核保存失败，待复核状态保留。请重试；同一请求会复用提交标识。'
    if (['stale_version', 'stale_evidence', 'idempotency_conflict'].includes(code ?? '')) conflict.value = true
    if (code === 'unauthorized') token.value = ''
  } finally { pending.value = false }
}
</script>
<template>
  <form class="flex min-w-0 flex-col gap-3 [&_[data-slot=native-select-wrapper]]:max-w-full" @submit.prevent="save">
    <p v-if="!eligible" class="text-muted-foreground text-[13px]">{{ !detail.pending ? '该项已登记复核；若有后续证据变化，请重新读取。' : '该项当前不可完成复核：历史、撤回、归并或尚未完成影响检查。请重新读取当前状态。' }}</p>
    <p class="text-muted-foreground text-[13px]">{{ token ? '写入凭证仅在本面板内存中使用，权限由服务端验证。' : '只读：可查看旧决定和缺口；提交需要配置的写入凭证。' }}</p>
    <fieldset class="flex flex-col gap-3" :disabled="pending || refreshing || !eligible">
      <legend class="mb-2 text-sm font-medium">复核原决定 #{{ detail.decisionId }}</legend>
      <label class="flex flex-col gap-1 text-[13px]">写入凭证<Input v-model="token" aria-label="写入凭证" type="password" autocomplete="off" /></label>
      <label class="flex flex-col gap-1 text-[13px]">复核人<Input v-model="actor" aria-label="复核人" maxlength="200" autocomplete="off" /></label>
      <label class="flex flex-col gap-1 text-[13px]">复核依据<Textarea v-model="basis" aria-label="复核依据" maxlength="4000" :rows="3" /></label>
      <label class="flex flex-col gap-1 text-[13px]">规则版本<Input v-model="ruleVersion" aria-label="规则版本" maxlength="200" /></label>
      <fieldset class="flex flex-col gap-2">
        <legend class="text-[13px]">处理方式</legend>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="mode" type="radio" :name="choiceId" value="maintain" />维持原决定</label>
        <label class="flex items-center gap-2 text-[13px]"><input v-model="mode" type="radio" :name="choiceId" value="replace" />追加更正</label>
      </fieldset>
      <ReplacementDecisionFields v-if="mode === 'replace'" v-model="draft" />
      <p v-else class="text-[13px]">明确维持原决定：保留原原因、措施和历史，仅登记本次证据复核。</p>
    </fieldset>
    <Alert v-if="failure" variant="destructive" role="alert"><AlertDescription>{{ failure }}</AlertDescription></Alert>
    <div class="flex flex-wrap gap-2">
      <Button type="submit" :disabled="!canSubmit">{{ pending ? '保存中…' : mode === 'maintain' ? '维持原决定并完成复核' : '追加更正并完成复核' }}</Button>
      <Button type="button" variant="outline" :disabled="pending || refreshing" @click="emit('reload')">重新读取当前状态</Button>
    </div>
  </form>
</template>
