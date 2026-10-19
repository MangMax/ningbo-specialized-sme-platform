<script setup lang="ts">
import type { ReviewAssessment } from '~~/lib/roster/evidence-review-ui'
import { coverageLabels } from '~~/lib/roster/evidence-review-ui'
import { PLATFORM_INTERFACES } from '~~/lib/labels'
defineProps<{ coverage: ReviewAssessment['queryCoverage'] }>()
const outcomes: Record<string, string> = { records: '已归属平台记录', no_record: '完整查询无记录', unknown: '结果未知' }
const subjectLabels: Record<string, string> = { exact_uscc: '精确统代', matched_relation: '已归属原行', name_only: '仅名称关键词，主体待核', unknown: '主体未知' }
</script>
<template>
  <details class="min-w-0 text-[13px] leading-5">
    <summary class="cursor-pointer text-primary">接口与分页缺口 · {{ coverage.sources.length }} 次查询</summary>
    <p v-if="coverage.truncated">仅展示最近50次相关查询，不能据此声明全部覆盖完整。</p>
    <p v-if="!coverage.sources.length">没有可核验的查询来源。</p>
    <ul class="mt-2 flex flex-col gap-2">
      <li v-for="source in coverage.sources" :key="source.queryId" class="min-w-0 break-words border-l pl-2">
        <p>#{{ source.queryId }} · {{ PLATFORM_INTERFACES[source.interface] ?? source.interface }} · {{ coverageLabels[source.status] }} · {{ source.queriedAt }}</p>
        <p>{{ outcomes[source.outcome] }} · {{ subjectLabels[source.subjectMatch] }} · {{ source.fullRange ? '全范围请求' : '局部或范围未知' }}</p>
        <p>条件：{{ source.conditions ? JSON.stringify(source.conditions) : '未记录' }}</p>
        <p v-for="page in source.pages" :key="`${page.rdjb}-${page.page}`">第 {{ page.page }} 页 · {{ page.status }} · 返回 {{ page.fetchedCount }} 条</p>
        <p v-for="gap in source.unfinished" :key="`${gap.rdjb}-${gap.page}`">未完成：{{ gap.source }} · 称号 {{ gap.rdjb ?? '未知' }} · 下一页 {{ gap.page }}</p>
      </li>
    </ul>
  </details>
</template>
