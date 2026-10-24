<script setup lang="ts">
import { computed, inject, provide, ref, shallowRef, watch, type Ref } from 'vue'
import type { ImpactRow, ReviewAssessment } from '~~/lib/roster/evidence-review-ui'
import { directionLabel, titleLabel } from '~~/lib/roster/review-display'
import InitialDifferenceDecisionForm from './InitialDifferenceDecisionForm.vue'
import QueryCoverageDetails from '@/components/evidence-review/QueryCoverageDetails.vue'
import QueryAssessmentSummary from '@/components/evidence-review/QueryAssessmentSummary.vue'
import DecisionHistory from '@/components/evidence-review/DecisionHistory.vue'
import EvidenceReviewDetail from '@/components/evidence-review/EvidenceReviewDetail.vue'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { REVIEW_DRAFTS_KEY, useReviewDrafts, type ReviewDraftStore } from '~/composables/useReviewDrafts'

const open = defineModel<boolean>('open', { required: true })

const props = defineProps<{
  enterpriseId: number
  titleCode: string
  direction: string
  assessment?: ReviewAssessment
  impact?: ImpactRow | null
  impactId?: number
}>()

const emit = defineEmits<{ saved: [] }>()

const displayed = shallowRef({ ...props })
const scopeKey = (value: typeof displayed.value) => `${value.enterpriseId}:${value.titleCode}:${value.direction}:${value.impact?.id ?? value.impactId ?? 'initial'}`
const resolvedImpactId = computed(() => displayed.value.impact?.id ?? displayed.value.impactId)
const initialDirty = ref(false)
const initialHeadChanged = ref(false)
const initialKey = computed(() => `initial:${displayed.value.enterpriseId}:${displayed.value.titleCode}:${displayed.value.direction}`)
const queuedScope = shallowRef<typeof displayed.value | null>(null)

/**
 * 面板内的提交草稿只存在内存里。关闭前先确认，避免一次误点丢掉复核依据或更正内容。
 * `enterprise-review-draft` 由企业详情页提供；没有宿主时按无草稿处理。
 */
const draftState = inject<Ref<boolean> | null>('enterprise-review-draft', null)
const draftStore = inject<ReviewDraftStore | null>(REVIEW_DRAFTS_KEY, null) ?? useReviewDrafts()
provide(REVIEW_DRAFTS_KEY, draftStore)
const protectedSubmission = computed(() => resolvedImpactId.value == null && !!draftStore.drafts[initialKey.value]?.initialSubmission?.request)
const hasDirtyDraft = computed(() => resolvedImpactId.value == null
  ? initialDirty.value
  : draftStore ? draftStore.hasDraft(resolvedImpactId.value) : !!draftState?.value)
const confirmClose = ref(false)
watch(() => ({ ...props }), next => {
  if (scopeKey(next) !== scopeKey(displayed.value) && hasDirtyDraft.value) {
    queuedScope.value = next
    confirmClose.value = true
  } else {
    if (scopeKey(next) !== scopeKey(displayed.value)) initialHeadChanged.value = false
    displayed.value = next
  }
})
function continueEditing() { queuedScope.value = null; confirmClose.value = false }
function requestOpen(next: boolean) {
  if (next) {
    open.value = true
    return
  }
  if (hasDirtyDraft.value || draftState?.value) {
    confirmClose.value = true
    return
  }
  open.value = false
}
function discardAndClose() {
  confirmClose.value = false
  if (resolvedImpactId.value != null) draftStore?.discard(resolvedImpactId.value)
  if (resolvedImpactId.value == null && !protectedSubmission.value) draftStore.discard(initialKey.value)
  initialDirty.value = false
  if (draftState && !draftStore) draftState.value = false
  if (queuedScope.value) { initialHeadChanged.value = false; displayed.value = queuedScope.value; queuedScope.value = null }
  else open.value = false
}
</script>

<template>
  <Sheet :open="open" @update:open="requestOpen">
    <SheetContent side="right" class="w-full gap-0 p-0 sm:max-w-[560px]">
      <SheetHeader class="border-b px-5 py-4 pr-12">
        <SheetTitle class="text-base">{{ titleLabel(displayed.titleCode) }} · {{ directionLabel(displayed.direction) }}</SheetTitle>
        <SheetDescription class="text-[13px] leading-5">
          核对依据、当前决定与证据复核。查询覆盖、业务决定和解释有效性分别保留。
        </SheetDescription>
      </SheetHeader>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <template v-if="resolvedImpactId">
          <EvidenceReviewDetail
            :key="resolvedImpactId"
            :impact-id="resolvedImpactId"
            :enterprise-id="displayed.enterpriseId"
            form-footer
            @saved="emit('saved')"
          />
        </template>

        <template v-else-if="displayed.assessment">
          <QueryAssessmentSummary v-if="!initialHeadChanged" :assessment="displayed.assessment" />
          <QueryCoverageDetails v-else :coverage="displayed.assessment.queryCoverage" />
          <InitialDifferenceDecisionForm
            v-if="open"
            :key="initialKey"
            :scope="{ enterpriseId: displayed.enterpriseId, titleCode: displayed.titleCode, direction: displayed.direction }"
            @dirty="initialDirty = $event"
            @current="initialHeadChanged = $event !== displayed.assessment?.currentDecision.versionId"
            @saved="emit('saved')"
          />
          <section class="mt-4 border-t pt-3">
            <DecisionHistory :scope="{ enterpriseId: displayed.enterpriseId, titleCode: displayed.titleCode, direction: displayed.direction }" />
          </section>
          <p class="text-muted-foreground mt-4 border-t pt-3 text-[13px] leading-5">
            查询完成、覆盖完整或未发现差异，都不自动等于“一致 / 无需处理”。
            证据变化后原决定保留待复核；更正必须由人工明确追加。
          </p>
        </template>
      </div>

      <!-- 主操作固定在滚动区外，390 全宽 Sheet 也不会压住表单或键盘。已复核/只读详情没有表单时，空 footer 不占位。 -->
      <div v-if="resolvedImpactId" id="review-sheet-footer" class="bg-card shrink-0 border-t px-5 py-3 [&:empty]:hidden" />
    </SheetContent>
  </Sheet>

  <Dialog :open="confirmClose" @update:open="value => { if (!value) continueEditing() }">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ protectedSubmission ? '提交记录将保留' : queuedScope ? '切换会丢弃未提交内容' : '关闭会丢弃未提交内容' }}</DialogTitle>
        <DialogDescription>
          {{ protectedSubmission ? '本次请求或回执已登记在此页面的内存中。收起或切换会保留完整提交，返回后继续核实；不会因关闭生成新请求。离开或刷新整个页面会结束这份内存记录。' : '复核依据或更正内容还没提交；收起后会丢失。' }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="continueEditing">继续填写</Button>
        <Button @click="discardAndClose">{{ protectedSubmission ? (queuedScope ? '保留提交并切换' : '保留提交并关闭') : queuedScope ? '丢弃并切换' : '关闭并丢弃' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
