<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { DecisionVersion, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import { createInitialDecisionState, useInitialDifferenceDecision, type InitialDecisionHead, type InitialDecisionReceipt } from '~/composables/useInitialDifferenceDecision'
import { REVIEW_DRAFTS_KEY } from '~/composables/useReviewDrafts'
import { useEvidenceReviewRefresh } from '~/composables/useEvidenceReviewRefresh'
import ReplacementDecisionFields from '@/components/evidence-review/ReplacementDecisionFields.vue'
import DecisionVersionDetails from '@/components/evidence-review/DecisionVersionDetails.vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'

const props = defineProps<{ scope: ReviewScope }>()
const emit = defineEmits<{ saved: []; dirty: [boolean]; current: [number | null] }>()
// The Sheet keys this component by exact scope; no requests or drafts follow a new scope.
const scope = { ...props.scope }
const refreshAffected = useEvidenceReviewRefresh()
const store = inject(REVIEW_DRAFTS_KEY, null)
const draftKey = `initial:${scope.enterpriseId}:${scope.titleCode}:${scope.direction}`
const retained = store?.drafts[draftKey]
const session = retained?.initialSubmission ?? createInitialDecisionState(scope)
if (retained && !retained.initialSubmission) { session.basis = retained.basis; session.draft = { ...retained.decision } }
const c = useInitialDifferenceDecision(scope, {
  context: () => $fetch<{ writeEnabled?: boolean }>('/api/roster/evidence-review/browser-context'),
  current: () => $fetch<InitialDecisionHead>('/api/roster/decision-lifecycle/current', { query: scope }),
  version: id => $fetch<DecisionVersion>(`/api/roster/decision-lifecycle/${id}`),
  post: body => $fetch<InitialDecisionReceipt>('/api/roster/evidence-review/browser-commands', { method: 'POST', body }),
}, session)
const { basis, draft, head, phase, writeState, message, correctionAccepted, dirty, locked, canSave, receipt, submittedVersion } = c
const formId = useId(), statusId = useId()
const editing = computed(() => writeState.value === 'ready' && phase.value === 'ready' && (!head.value?.current || correctionAccepted.value))
const entryOpen = ref(!!retained || !!session.request)
const started = computed(() => entryOpen.value || correctionAccepted.value)
watch(dirty, value => emit('dirty', value), { immediate: true })
watch([basis, draft, dirty, phase], () => {
  if (!store) return
  if (dirty.value || session.request) store.drafts[draftKey] = { basis: basis.value, mode: 'replace', decision: { ...draft.value }, initialSubmission: session }
  else delete store.drafts[draftKey]
}, { deep: true, immediate: true, flush: 'sync' })
const writeStatus = computed(() => writeState.value === 'loading' ? '正在确认页面提交是否已开启…'
  : writeState.value === 'readonly' ? '差异判断暂为只读：尚未开启页面提交。'
    : writeState.value === 'unavailable' ? '差异判断暂为只读：无法确认页面提交是否已开启。' : '')
function begin() { entryOpen.value = true; c.begin() }
watch(head, value => { if (value) emit('current', value.versionId) })
watch(phase, async value => {
  if (!['saved', 'superseded'].includes(value) || session.notified) return
  session.notified = true
  emit('saved')
  try { await refreshAffected() } catch { /* current readback is already displayed; other read surfaces own their failures */ }
})
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => { if (phase.value !== 'unknown' && phase.value !== 'saving') void c.load(); window.addEventListener('beforeunload', beforeUnload) })
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); emit('dirty', false) })
</script>

<template>
  <section class="mt-4 flex min-w-0 flex-col gap-3 border-t pt-4" aria-label="登记差异判断">
    <h3 class="text-sm font-semibold">{{ head?.current ? '当前差异判断' : '登记差异判断' }}</h3>
    <p v-if="phase === 'loading'" role="status" class="text-muted-foreground text-sm">正在读取当前决定…</p>
    <p v-if="writeStatus" role="status" class="text-muted-foreground text-sm">{{ writeStatus }}</p>
    <DecisionVersionDetails v-if="head?.current" :decision="head.current" label="当前决定" />
    <DecisionVersionDetails v-if="submittedVersion && submittedVersion.id !== head?.current?.id" :decision="submittedVersion" label="本次提交版本" />
    <p v-if="receipt" class="text-muted-foreground text-sm">本次提交回执 #{{ receipt.versionId }}；当前决定与本次提交分别核对。</p>
    <p v-if="head?.current && !correctionAccepted && phase === 'ready'" class="text-muted-foreground text-sm">
      已有决定 #{{ head.versionId }}。核对后可明确追加更正；不会覆盖原决定或自动完成证据复核。
    </p>
    <Button v-if="editing && !started" type="button" class="self-start" @click="begin">
      {{ head?.current ? '核对后追加更正' : '登记差异判断' }}
    </Button>
    <Button v-else-if="head?.current && !correctionAccepted && ['ready', 'saved', 'superseded'].includes(phase) && writeState === 'ready'" type="button" class="self-start" @click="begin">核对后追加更正</Button>
    <form v-if="started && phase !== 'saved' && phase !== 'superseded' && phase !== 'readback'" :id="formId" class="flex min-w-0 flex-col gap-3" @submit.prevent="c.save">
      <fieldset class="flex min-w-0 flex-col gap-3" :disabled="!editing || locked">
        <legend class="sr-only">差异判断业务字段</legend>
        <label class="flex flex-col gap-1 text-sm">
          判断依据（必填）
          <Textarea v-model="basis" aria-label="判断依据" :rows="3" maxlength="4000" required placeholder="说明核对材料及作出本次判断的依据" />
        </label>
        <p class="text-muted-foreground text-[13px] leading-5">请明确选择结论、原因和措施。查询覆盖完整不等于无差异；以下字段沿用追加更正的业务词表。</p>
        <ReplacementDecisionFields v-model="draft" class="[&_legend]:sr-only" />
      </fieldset>
      <p v-if="editing && !canSave" :id="statusId" class="text-muted-foreground text-[13px] leading-5">提交前需填写判断依据，明确选择结论及相应原因、措施；证据 ID 须为有效正整数。</p>
      <div class="flex flex-wrap gap-2">
        <Button type="submit" :disabled="!canSave && phase !== 'unknown'" :aria-describedby="statusId">
          {{ phase === 'saving' ? '正在提交…' : phase === 'unknown' ? '重试同一次提交' : head?.current ? '追加更正判断' : '保存差异判断' }}
        </Button>
      </div>
    </form>
    <Alert v-if="message" :variant="['unknown', 'conflict', 'error', 'readback', 'superseded'].includes(phase) ? 'destructive' : 'default'" role="status">
      <AlertDescription>{{ message }}</AlertDescription>
    </Alert>
    <Button v-if="phase !== 'unknown' && phase !== 'saving'" type="button" variant="outline" class="self-start" :disabled="phase === 'loading'" @click="c.load">
      {{ phase === 'readback' ? '重试读取当前决定' : '重新读取当前决定' }}
    </Button>
  </section>
</template>
