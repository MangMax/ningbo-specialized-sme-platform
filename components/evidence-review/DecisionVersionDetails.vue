<script setup lang="ts">
import type { DecisionVersion } from '~~/lib/roster/evidence-review-ui'
import {
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  TITLES,
} from '~~/lib/labels'
import { decisionOriginLabel, decisionVersionActionLabel, reviewTimeLabel } from '~~/lib/roster/review-display'
import { Badge } from '@/components/ui/badge'
import DisclosurePanel from '@/components/DisclosurePanel.vue'

defineProps<{ decision: DecisionVersion; label?: string }>()
</script>

<template>
  <article class="flex min-w-0 flex-col gap-2 text-[13px] leading-5" data-testid="decision-version">
    <header class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h4 class="text-sm font-semibold">{{ label ?? '决定' }} #{{ decision.id }}</h4>
      <Badge variant="outline" class="font-normal">
        {{ DIFFERENCE_STATUSES[decision.status] ?? '状态待核' }}
      </Badge>
    </header>

    <dl class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
      <dt class="text-muted-foreground">原因</dt>
      <dd>
        {{ DIFFERENCE_REASONS[decision.reasonCode ?? ''] ?? decision.reasonCode ?? '未填写' }}
        <template v-if="decision.reasonNote"> · {{ decision.reasonNote }}</template>
      </dd>
      <dt class="text-muted-foreground">措施</dt>
      <dd>
        {{ DIFFERENCE_MEASURES[decision.measureCode ?? ''] ?? decision.measureCode ?? '未填写' }}
        <template v-if="decision.measureNote"> · {{ decision.measureNote }}</template>
      </dd>
      <template v-if="decision.movedInCity || decision.movedInTitleCode || decision.movedInYear || decision.movedInBatch">
        <dt class="text-muted-foreground">迁入来源</dt>
        <dd>
          {{ decision.movedInCity ?? '城市待补证' }} ·
          {{ TITLES[decision.movedInTitleCode ?? ''] ?? '称号待补证' }} ·
          {{ decision.movedInYear ?? '年份待补证' }} ·
          {{ decision.movedInBatch ?? '批次待补证' }}
        </dd>
      </template>
      <template v-if="decision.evidenceQueryId || decision.evidenceRelationId">
        <dt class="text-muted-foreground">原证据</dt>
        <dd>查询 #{{ decision.evidenceQueryId ?? '未指定' }} · 原行 #{{ decision.evidenceRelationId ?? '未指定' }}</dd>
      </template>
      <template v-if="decision.actor">
        <dt class="text-muted-foreground">记录人</dt>
        <dd>{{ decision.actor.type === 'agent' ? '代理' : '人工' }} · {{ decision.actor.id }}</dd>
      </template>
      <template v-if="decision.basis">
        <dt class="text-muted-foreground">决定依据</dt>
        <dd>{{ decision.basis }}</dd>
      </template>
      <dt class="text-muted-foreground">规则版本</dt>
      <dd>{{ decision.ruleVersion ?? '未记录' }}</dd>
      <dt class="text-muted-foreground">生效 / 登记</dt>
      <dd>{{ reviewTimeLabel(decision.effectiveAt) }} / {{ reviewTimeLabel(decision.recordedAt) }}</dd>
    </dl>

    <DisclosurePanel compact keep-mounted content-class="pb-0" class="text-muted-foreground">
      <template #trigger><span>技术详情</span></template>
      <dl class="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 break-words">
        <dt>生效时间（原始）</dt><dd>{{ decision.effectiveAt ?? '未记录' }}</dd>
        <dt>登记时间（原始）</dt><dd>{{ decision.recordedAt }}</dd>
        <dt>生命周期动作</dt><dd>{{ decisionVersionActionLabel(decision) }}</dd>
        <dt>前一版本</dt><dd>{{ decision.previousId == null ? '无' : `#${decision.previousId}` }}</dd>
        <dt>来源</dt><dd>{{ decisionOriginLabel(decision.origin) }}</dd>
      </dl>
    </DisclosurePanel>
  </article>
</template>
