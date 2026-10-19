<script setup lang="ts">
import { computed, inject, ref, type Ref } from 'vue'
import type { ImpactRow, ReviewAssessment } from '~~/lib/roster/evidence-review-ui'
import { directionLabel, titleLabel } from '~~/lib/roster/review-display'
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

const resolvedImpactId = computed(() => props.impact?.id ?? props.impactId)

/**
 * 面板内的提交草稿只存在内存里。关闭前先确认，避免一次误点丢掉复核人填写的依据。
 * `enterprise-review-draft` 由企业详情页提供；没有宿主时按无草稿处理。
 */
const draftState = inject<Ref<boolean> | null>('enterprise-review-draft', null)
const confirmClose = ref(false)
function requestOpen(next: boolean) {
  if (next) {
    open.value = true
    return
  }
  if (draftState?.value) {
    confirmClose.value = true
    return
  }
  open.value = false
}
function discardAndClose() {
  confirmClose.value = false
  if (draftState) draftState.value = false
  open.value = false
}
</script>

<template>
  <Sheet :open="open" @update:open="requestOpen">
    <SheetContent side="right" class="w-full gap-0 p-0 sm:max-w-[560px]">
      <SheetHeader class="border-b px-5 py-4 pr-12">
        <SheetTitle class="text-base">{{ titleLabel(titleCode) }} · {{ directionLabel(direction) }}</SheetTitle>
        <SheetDescription class="text-[13px] leading-5">
          核对依据、当前决定与证据复核。查询覆盖、业务决定和解释有效性分别保留。
        </SheetDescription>
      </SheetHeader>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <template v-if="resolvedImpactId">
          <EvidenceReviewDetail
            :key="resolvedImpactId"
            :impact-id="resolvedImpactId"
            :enterprise-id="enterpriseId"
            form-footer
            @saved="emit('saved')"
          />
        </template>

        <template v-else-if="assessment">
          <QueryAssessmentSummary :assessment="assessment" />
          <section class="mt-4 border-t pt-3">
            <DecisionHistory :scope="{ enterpriseId, titleCode, direction }" />
          </section>
          <p class="text-muted-foreground mt-4 border-t pt-3 text-[13px] leading-5">
            查询完成、覆盖完整或未发现差异，都不自动等于“一致 / 无需处理”。
            证据变化后原决定保留待复核；更正必须由人工明确追加。
          </p>
        </template>
      </div>

      <!-- 主操作固定在滚动区外，390 全宽 Sheet 也不会压住表单或键盘。 -->
      <div v-if="resolvedImpactId" id="review-sheet-footer" class="bg-card shrink-0 border-t px-5 py-3" />
    </SheetContent>
  </Sheet>

  <Dialog :open="confirmClose" @update:open="value => { if (!value) confirmClose = false }">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>关闭会丢弃未提交内容</DialogTitle>
        <DialogDescription>
          复核人填写的凭证、依据或更正内容尚未提交；关闭面板后这些内容会丢失。
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="confirmClose = false">继续填写</Button>
        <Button @click="discardAndClose">关闭并丢弃</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
