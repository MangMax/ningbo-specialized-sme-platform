<script setup lang="ts">
import type { ReviewAssessment } from '#sme-roster/lib/roster/evidence-review-ui'
import { coverageLabels } from '#sme-roster/lib/roster/evidence-review-ui'
import { PLATFORM_QUERY_STATUSES } from '#sme-roster/lib/labels'
import {
  conditionSummary,
  interfaceLabel,
  reviewTimeLabel,
} from '#sme-roster/lib/roster/review-display'
import RosterAssessmentStatusBadge from './AssessmentStatusBadge.vue'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'

defineProps<{ coverage: ReviewAssessment['queryCoverage'] }>()

const outcomes: Record<string, string> = {
  records: '已归属平台记录',
  no_record: '完整查询无记录',
  unknown: '结果未知',
}
const subjectLabels: Record<string, string> = {
  exact_uscc: '精确定位到该企业',
  matched_relation: '已归属原行',
  name_only: '仅名称关键词，主体待核',
  unknown: '主体待核',
}
const pageStatus = (value: string) => PLATFORM_QUERY_STATUSES[value] ?? '状态待核'
</script>

<template>
  <DisclosurePanel compact content-class="pb-0" class="min-w-0 text-table leading-5" data-testid="coverage-details">
    <template #trigger>
      <span class="font-medium">核对范围与查询缺口 · {{ coverage.sources.length }} 次查询</span>
    </template>
    <p v-if="coverage.truncated" class="text-warning mt-2">
      仅展示最近50次相关查询，不能据此声明全部覆盖完整。
    </p>
    <p v-if="!coverage.sources.length" class="text-muted-foreground mt-2">
      没有可核验的查询来源；“没有来源”不等于“平台无记录”。
    </p>
    <ul class="mt-2 flex flex-col gap-3">
      <li
        v-for="source in coverage.sources"
        :key="source.queryId"
        class="flex min-w-0 flex-col gap-1.5 border-t pt-3 first:border-t-0 first:pt-0"
      >
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-foreground font-medium">{{ interfaceLabel(source.interface) }}</span>
          <RosterAssessmentStatusBadge kind="coverage" :value="source.status" :label="coverageLabels[source.status]" />
          <span class="text-muted-foreground tabular-nums">{{ reviewTimeLabel(source.queriedAt) }}</span>
        </div>
        <p class="text-foreground">{{ outcomes[source.outcome] ?? '结果未知' }}</p>
        <p class="text-muted-foreground">
          {{ subjectLabels[source.subjectMatch] ?? '主体待核' }} ·
          {{ source.fullRange ? '全范围请求' : '局部或范围未知' }}
        </p>
        <p class="break-words">查询条件：{{ conditionSummary(source.conditions) }}</p>
        <ul v-if="source.pages.length" class="flex flex-col gap-0.5">
          <li v-for="page in source.pages" :key="`${page.rdjb}-${page.page}`" class="text-muted-foreground">
            第 {{ page.page }} 页 · {{ pageStatus(page.status) }} · 返回 {{ page.fetchedCount }} 条
          </li>
        </ul>
        <ul v-if="source.unfinished.length" class="flex flex-col gap-0.5">
          <li v-for="gap in source.unfinished" :key="`${gap.rdjb}-${gap.page}`" class="text-warning">
            未完成：{{ interfaceLabel(gap.source) }} · 称号 {{ gap.rdjb ?? '未知' }} · 下一页 {{ gap.page }}
          </li>
        </ul>
        <DisclosurePanel compact keep-mounted content-class="pb-0" class="text-muted-foreground">
          <template #trigger><span>技术详情</span></template>
          <dl class="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 break-words">
            <dt>查询 ID</dt><dd>#{{ source.queryId }}</dd>
            <dt>接口键</dt><dd>{{ source.interface }}</dd>
            <dt>原始状态</dt><dd>{{ source.queryStatus }}</dd>
            <dt>查询条件（原始）</dt><dd>{{ source.conditions ? JSON.stringify(source.conditions) : '未记录' }}</dd>
            <dt>完整性</dt><dd>{{ source.completeness ?? '未记录' }}</dd>
            <template v-for="gap in source.unfinished" :key="`tech-${gap.rdjb}-${gap.page}`">
              <dt>未完成来源键</dt><dd>{{ gap.source }}</dd>
            </template>
          </dl>
        </DisclosurePanel>
      </li>
    </ul>
  </DisclosurePanel>
</template>
