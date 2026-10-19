<script setup lang="ts">
import { computed, nextTick, shallowRef } from 'vue'
import { useEvidenceReviewRefresh } from '~/composables/useEvidenceReviewRefresh'
import { useQuery } from '@pinia/colada'
import type { ImpactDetail } from '~~/lib/roster/evidence-review-ui'
import { impactClassificationLabels, lineageLabels } from '~~/lib/roster/evidence-review-ui'
import { impactDecisionRoleLabel, impactEffectiveLineage, reviewTimeLabel, titleLabel, directionLabel } from '~~/lib/roster/review-display'
import EvidenceImpactSources from './EvidenceImpactSources.vue'
import EvidenceReviewForm from './EvidenceReviewForm.vue'
import QueryCoverageDetails from './QueryCoverageDetails.vue'
import DecisionVersionDetails from './DecisionVersionDetails.vue'
import DecisionHistory from './DecisionHistory.vue'
import AssessmentStatusBadge from './AssessmentStatusBadge.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'

const emit = defineEmits<{ saved: [{ action?: string; versionId?: number }?] }>()
const refreshAffected = useEvidenceReviewRefresh()
const props = defineProps<{ impactId: number; enterpriseId?: number; formFooter?: boolean }>()
const { data, isLoading, error, refetch } = useQuery({ key: () => ['evidence-impact', props.impactId], query: () => $fetch<ImpactDetail>(`/api/roster/evidence-impacts/${props.impactId}`) })

const showHistory = computed(() => !!data.value?.oldDecision && !data.value.gaps.decisionUnavailable && data.value.lineage !== 'merged')

type SaveNotice = { tone: 'success' | 'warning'; title: string; lines: string[] }
const notice = shallowRef<SaveNotice | null>(null)
const noticeEl = shallowRef<HTMLElement | null>(null)

/**
 * 只陈述服务端读回的决定坐标和本次回执动作；回执缺失时不把“提交返回”
 * 说成“已登记”，也不凭 reviewedBaseline/valid 猜成“维持原决定”。
 */
function receiptLines(updated: ImpactDetail, action?: string): string[] {
  const lines: string[] = []
  const baseline = updated.reviewedBaseline
  if (baseline) {
    lines.push(`复核至修订 #${baseline.reviewedRevisionId} · ${baseline.actor.type === 'agent' ? '代理' : '人工'} · ${baseline.actor.id}`)
    lines.push(`复核依据：${baseline.basis}`)
  } else {
    lines.push('复核状态已更新为已复核；本次复核回执未返回，请以决定历史为准。')
  }
  const current = updated.currentDecision?.current
  if (!current) {
    lines.push('当前决定不可用；请重新读取确认。')
  } else if (action === 'maintain') {
    lines.push(`本次登记为维持原决定；当前决定 #${current.id} 未变。`)
  } else if (action === 'withdraw') {
    lines.push(`当前决定已撤回；历史版本 #${current.id} 仍保留。`)
  } else if (action === 'replace' || current.lifecycleAction === 'replace') {
    // previousId 只取服务端返回；缺失时只能说首次决定，不能拿 oldDecision 冒充源决定。
    lines.push(current.previousId != null
      ? `当前决定 #${current.id}（追加更正）；复核前决定 #${current.previousId} 保留。`
      : `当前决定 #${current.id}（首次决定）。`)
  } else {
    lines.push(`当前决定 #${current.id}。`)
  }
  return lines
}

const currentDecisionSummary = computed(() => {
  const current = data.value?.currentDecision?.current
  if (!current) return '无'
  if (current.lifecycleAction === 'replace') {
    return current.previousId != null
      ? `#${current.id}（追加更正）· 复核前决定 #${current.previousId} 保留`
      : `#${current.id}（首次决定）`
  }
  return `#${current.id}`
})

async function onSaved(payload?: { action?: string }) {
  notice.value = {
    tone: 'warning',
    title: '复核已提交，正在读取当前状态',
    lines: ['读回完成前不视为已登记复核。'],
  }
  let readFailed = false
  try { await refreshAffected() } catch { /* 仍显式尝试读回当前详情 */ }
  try {
    await refetch()
  } catch {
    readFailed = true
  }
  const updated = data.value
  if (!readFailed && updated && !updated.pending) {
    notice.value = { tone: 'success', title: '复核已登记', lines: receiptLines(updated, payload?.action) }
  } else {
    notice.value = {
      tone: 'warning',
      title: '复核已提交，当前状态尚未确认',
      lines: [readFailed
        ? '重新读取当前状态失败；未确认前不视为已登记复核。请重新读取确认。'
        : '当前状态仍显示待复核；未确认前不视为已登记复核。请重新读取确认。'],
    }
  }
  await nextTick()
  await nextTick()
  noticeEl.value?.focus({ preventScroll: true })
  // Sheet 的成功/待确认提示在滚动区外的 footer；内联时留出 56px sticky header。
  if (!props.formFooter) noticeEl.value?.scrollIntoView?.({ block: 'start' })
  emit('saved', payload)
}

async function reloadCurrent() {
  notice.value = null
  await refreshAffected()
  await refetch()
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 border-t pt-3">
    <div v-if="isLoading && !data" class="flex flex-col gap-2" role="status" aria-label="正在读取复核详情">
      <span class="bg-muted h-5 w-56 animate-pulse rounded-sm" />
      <span class="bg-muted h-24 w-full animate-pulse rounded-sm" />
      <span class="bg-muted h-16 w-full animate-pulse rounded-sm" />
    </div>

    <TableFailureState
      v-if="error"
      title="复核详情读取失败"
      :description="`读取目标：复核项 #${impactId}。已加载的复核项仍保留；重试只读取当前目标。`"
      :pending="isLoading"
      @retry="refetch()"
    />

    <p v-if="data && enterpriseId != null && data.enterpriseId !== enterpriseId" role="alert" class="text-destructive text-[13px] leading-5">
      该复核项不属于当前企业。请从清单选择准确坐标。
    </p>

    <template v-else-if="data">
      <header class="flex min-w-0 flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-1.5">
          <h3 class="text-sm font-semibold">复核项 #{{ data.id }}</h3>
          <AssessmentStatusBadge kind="review" :value="data.pending ? 'pending' : 'reviewed'" />
          <AssessmentStatusBadge kind="impact" :value="data.classification" />
          <AssessmentStatusBadge v-if="impactEffectiveLineage(data) !== 'current'" kind="lineage" :value="impactEffectiveLineage(data)" />
          <span v-else class="text-muted-foreground text-[13px]">当前决定</span>
        </div>
        <p class="text-muted-foreground text-[13px] leading-5">
          {{ titleLabel(data.titleCode) }} · {{ directionLabel(data.direction) }} ·
          {{ impactClassificationLabels[data.classification] ?? '证据变化' }}
        </p>
      </header>

      <!--
        成功/待确认回执放在 Sheet footer，390 当前屏可见；内联展开时放在
        详情顶部。只有读回 pending=false 才使用“已登记”措辞。
      -->
      <Teleport v-if="formFooter && notice" to="#review-sheet-footer" defer>
        <div
          ref="noticeEl"
          tabindex="-1"
          :role="notice.tone === 'warning' ? 'alert' : 'status'"
          aria-live="polite"
          data-testid="review-save-notice"
          :class="[
            'scroll-mt-14 flex flex-col gap-0.5 rounded-md border px-3 py-2 text-[13px] leading-5 focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none',
            notice.tone === 'warning' ? 'border-warning/40 bg-warning/5' : 'border-primary/30 bg-primary/5',
          ]"
        >
          <p class="font-medium">{{ notice.title }}</p>
          <p v-for="line in notice.lines" :key="line" class="text-muted-foreground">{{ line }}</p>
        </div>
      </Teleport>
      <div
        v-else-if="notice"
        ref="noticeEl"
        tabindex="-1"
        :role="notice.tone === 'warning' ? 'alert' : 'status'"
        aria-live="polite"
        data-testid="review-save-notice"
        :class="[
          'scroll-mt-14 flex flex-col gap-0.5 rounded-md border px-3 py-2 text-[13px] leading-5 focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none',
          notice.tone === 'warning' ? 'border-warning/40 bg-warning/5' : 'border-primary/30 bg-primary/5',
        ]"
      >
        <p class="font-medium">{{ notice.title }}</p>
        <p v-for="line in notice.lines" :key="line" class="text-muted-foreground">{{ line }}</p>
      </div>

      <!--
        已复核：先给真实回执/无回执说明，再给决定历史与当前坐标；
        不再用整张禁用表单占首屏，也不提供再次提交的假入口。
      -->
      <template v-if="!data.pending">
        <section
          v-if="data.reviewedBaseline"
          data-testid="reviewed-baseline"
          class="bg-muted/20 flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2.5 text-[13px] leading-5"
        >
          <h4 class="text-sm font-medium">已登记的证据复核</h4>
          <p>复核至修订 #{{ data.reviewedBaseline.reviewedRevisionId }} · {{ data.reviewedBaseline.actor.type === 'agent' ? '代理' : '人工' }} · {{ data.reviewedBaseline.actor.id }}</p>
          <p>复核依据：{{ data.reviewedBaseline.basis }}</p>
          <p>
            规则：{{ data.reviewedBaseline.ruleVersion }} ·
            生效：{{ reviewTimeLabel(data.reviewedBaseline.effectiveAt) }} ·
            登记：{{ reviewTimeLabel(data.reviewedBaseline.recordedAt) }}
          </p>
          <DisclosurePanel compact keep-mounted content-class="pb-0" class="text-muted-foreground">
            <template #trigger><span>技术详情</span></template>
            <p class="mt-1 break-words">
              生效时间（原始）：{{ data.reviewedBaseline.effectiveAt }} ·
              登记时间（原始）：{{ data.reviewedBaseline.recordedAt }}
            </p>
          </DisclosurePanel>
        </section>
        <section
          v-else
          data-testid="reviewed-without-receipt"
          class="bg-muted/20 flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2.5 text-[13px] leading-5"
        >
          <h4 class="text-sm font-medium">已登记复核</h4>
          <p>本次复核回执未返回；不提供再次提交入口，决定历史与当前决定仍可读。</p>
        </section>

        <DecisionHistory
          v-if="showHistory"
          :scope="{ enterpriseId: data.enterpriseId, titleCode: data.titleCode, direction: data.direction }"
        />

        <div class="grid min-w-0 gap-3 sm:grid-cols-2">
          <section v-if="data.oldDecision" class="bg-card min-w-0 rounded-md border p-3">
            <DecisionVersionDetails :decision="data.oldDecision" :label="impactDecisionRoleLabel(data)" />
          </section>
          <section
            v-if="data.currentDecision?.current && data.oldDecision && data.currentDecision.current.id !== data.oldDecision.id"
            class="bg-card min-w-0 rounded-md border p-3"
          >
            <DecisionVersionDetails :decision="data.currentDecision.current" label="当前决定" />
          </section>
        </div>

        <div
          v-if="data.gaps.decisionUnavailable || !data.oldDecision"
          class="bg-destructive/5 border-destructive/30 rounded-md border px-3 py-2.5 text-[13px] leading-5"
          data-testid="decision-unavailable"
        >
          <p class="text-foreground font-medium">历史决定原文不可用</p>
          <p class="text-muted-foreground mt-0.5">
            {{ impactDecisionRoleLabel(data) }} #{{ data.decisionId }} ·
            {{ data.lineage === 'merged' ? `原企业 #${data.enterpriseId}（归并前坐标）` : `企业 #${data.enterpriseId}` }} ·
            {{ titleLabel(data.titleCode) }} · {{ directionLabel(data.direction) }}
            的历史坐标和来源仍保留；不替代为其他企业或幸存者的决定。
          </p>
        </div>

        <p v-if="data.gaps.subjectUnknown" class="text-warning text-[13px] leading-5">
          主体未确认，不能推断为零记录。
        </p>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-5">
          <span>
            当前决定
            <strong>{{ currentDecisionSummary }}</strong>
          </span>
        </div>

        <EvidenceImpactSources :impact-id="data.id" :enterprise-id="data.enterpriseId" />
        <QueryCoverageDetails v-if="data.queryCoverage" :coverage="data.queryCoverage" />

        <DisclosurePanel compact keep-mounted content-class="pb-0" class="text-muted-foreground">
          <template #trigger><span>技术详情</span></template>
          <p class="mt-1 break-words">
            复核项 #{{ data.id }} · 决定 #{{ data.decisionId }} · 当前版本 #{{ data.currentDecision?.versionId ?? '无' }} ·
            证据修订 #{{ data.latestRevisionId }} · 投影
            {{ data.evidenceToken.projectionReady ? '就绪' : '未就绪' }} · 来源
            {{ lineageLabels[data.lineage] ?? data.lineage }}
          </p>
        </DisclosurePanel>
      </template>

      <!--
        待复核：表单保留已填写草稿；历史/撤回/归并、原文缺失、影响检查
        未完成时在表单内明确只读并禁用提交，冲突后重新读取也不丢草稿。
      -->
      <template v-else>
        <div class="grid min-w-0 gap-3 sm:grid-cols-2">
          <section v-if="data.oldDecision" class="bg-card min-w-0 rounded-md border p-3">
            <DecisionVersionDetails :decision="data.oldDecision" :label="impactDecisionRoleLabel(data)" />
          </section>
          <section
            v-if="data.currentDecision?.current && data.oldDecision && data.currentDecision.current.id !== data.oldDecision.id"
            class="bg-card min-w-0 rounded-md border p-3"
          >
            <DecisionVersionDetails :decision="data.currentDecision.current" label="当前决定" />
          </section>
        </div>

        <div
          v-if="data.gaps.decisionUnavailable || !data.oldDecision"
          class="bg-destructive/5 border-destructive/30 rounded-md border px-3 py-2.5 text-[13px] leading-5"
          data-testid="decision-unavailable"
        >
          <p class="text-foreground font-medium">历史决定原文不可用</p>
          <p class="text-muted-foreground mt-0.5">
            {{ impactDecisionRoleLabel(data) }} #{{ data.decisionId }} ·
            {{ data.lineage === 'merged' ? `原企业 #${data.enterpriseId}（归并前坐标）` : `企业 #${data.enterpriseId}` }} ·
            {{ titleLabel(data.titleCode) }} · {{ directionLabel(data.direction) }}
            的历史坐标和来源仍保留；不替代为其他企业或幸存者的决定。
          </p>
        </div>

        <p v-if="data.gaps.subjectUnknown" class="text-warning text-[13px] leading-5">
          主体未确认，不能推断为零记录。
        </p>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-5">
          <span>
            当前决定
            <strong>{{ currentDecisionSummary }}</strong>
          </span>
        </div>

        <EvidenceReviewForm
          :detail="data"
          :refreshing="isLoading || !!error"
          :footer="formFooter"
          @reload="reloadCurrent"
          @saved="onSaved"
        />

        <section
          v-if="data.reviewedBaseline"
          data-testid="reviewed-baseline"
          class="bg-muted/20 flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2.5 text-[13px] leading-5"
        >
          <h4 class="text-sm font-medium">已登记的证据复核</h4>
          <p>复核至修订 #{{ data.reviewedBaseline.reviewedRevisionId }} · {{ data.reviewedBaseline.actor.type === 'agent' ? '代理' : '人工' }} · {{ data.reviewedBaseline.actor.id }}</p>
          <p>复核依据：{{ data.reviewedBaseline.basis }}</p>
          <p>
            规则：{{ data.reviewedBaseline.ruleVersion }} ·
            生效：{{ reviewTimeLabel(data.reviewedBaseline.effectiveAt) }} ·
            登记：{{ reviewTimeLabel(data.reviewedBaseline.recordedAt) }}
          </p>
        </section>

        <EvidenceImpactSources :impact-id="data.id" :enterprise-id="data.enterpriseId" />
        <QueryCoverageDetails v-if="data.queryCoverage" :coverage="data.queryCoverage" />
        <DecisionHistory
          v-if="showHistory"
          :scope="{ enterpriseId: data.enterpriseId, titleCode: data.titleCode, direction: data.direction }"
        />

        <DisclosurePanel compact keep-mounted content-class="pb-0" class="text-muted-foreground">
          <template #trigger><span>技术详情</span></template>
          <p class="mt-1 break-words">
            复核项 #{{ data.id }} · 决定 #{{ data.decisionId }} · 当前版本 #{{ data.currentDecision?.versionId ?? '无' }} ·
            证据修订 #{{ data.latestRevisionId }} · 投影
            {{ data.evidenceToken.projectionReady ? '就绪' : '未就绪' }} · 来源
            {{ lineageLabels[data.lineage] ?? data.lineage }}
          </p>
        </DisclosurePanel>
      </template>
    </template>

    <button v-else-if="!isLoading && !error" type="button" class="text-primary self-start text-[13px] hover:underline" @click="refetch()">
      读取复核项
    </button>
  </div>
</template>
