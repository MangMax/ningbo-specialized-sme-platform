<script setup lang="ts">
import { PLATFORM_QUERY_STATUSES, PLATFORM_RDJBS } from '~~/lib/labels'
import { formatFetchTime } from '~~/lib/reconcile-time'
import { platformFailureForDisplay } from '~~/lib/roster/platform-records'
import type { PlatformRecordQuery } from '~~/lib/roster/platform-records'
defineProps<{ queries: PlatformRecordQuery[]; sourceLabel: string }>()
const time = (value: string) => formatFetchTime(value) ?? value
const title = (value: string | null) => PLATFORM_RDJBS[value ?? ''] ?? '称号未标注'
const conditions: Record<string, string> = { name: '企业名称条件', uscc: '信用代码条件', sqsj: '申报时间范围', rddqrq: '有效年份条件', whpcyear: '维护年份条件', whpc: '维护批次条件', szq: '属地筛选代码', orderField: '排序字段', orderDirection: '排序方向' }
const conditionValue = (key: string, value: string) => key === 'orderField' && value === 'qymc' ? '企业名称' : key === 'orderDirection' ? ({asc:'升序',desc:'降序'}[value] ?? value) : value
</script>
<template>
  <details v-if="queries.length" class="mb-2 rounded-sm border px-3 py-2 text-[13px] leading-5" data-testid="platform-query-history">
    <summary class="cursor-pointer text-primary focus-visible:outline-2 focus-visible:outline-ring">查询出处与历史 · {{ queries.length }} 次</summary>
    <p v-if="queries.some(query => query.interface === 'recognized_list')" class="text-muted-foreground mt-3">按原查询时点保留的证据，含历史记录；不代表当前正式名单。维护年份与批次不作为正式认定事件。</p>
    <article v-for="query in [...queries].sort((a,b) => b.queriedAt.localeCompare(a.queriedAt))" :key="query.id" class="mt-3 border-t pt-3 break-words [overflow-wrap:anywhere]" data-testid="platform-query-provenance">
      <p class="font-medium">查询 #{{ query.id }} · {{ sourceLabel }} · {{ PLATFORM_QUERY_STATUSES[query.status] ?? '状态待核' }} · {{ query.relationCount }} 条来源行</p>
      <p>原查询时点：{{ time(query.queriedAt) }}</p>
      <p>查询称号：{{ query.rdjb.split(',').map(title).join('、') }}</p>
      <template v-if="query.collectionEvidence">
        <p>完成时点：{{ time(query.collectionEvidence.completedAt) }}</p>
        <p>完整性：{{ { complete: '所请求范围完整', partial: '部分', not_queried: '未查询' }[query.collectionEvidence.completeness] }} · {{ query.collectionEvidence.fullRange ? '从首页查询' : '续页范围，非全范围' }}</p>
        <p>已采集 {{ query.collectionEvidence.fetchedCount }} 条 · 平台总数：{{ query.collectionEvidence.declaredTotal ?? '未知' }}</p>
        <p>称号范围：{{ query.collectionEvidence.titleScope.mode === 'selected' ? '指定称号' : '来源默认称号' }} · {{ query.collectionEvidence.titleScope.rdjb.map(title).join('、') }}</p>
        <dl class="my-2 grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
          <template v-for="(label,key) in conditions" :key="key">
            <template v-if="query.collectionEvidence.effectiveConditions[key as keyof typeof query.collectionEvidence.effectiveConditions] != null">
              <dt class="text-muted-foreground">{{ label }}</dt><dd>{{ conditionValue(key, query.collectionEvidence.effectiveConditions[key as keyof typeof query.collectionEvidence.effectiveConditions]!) }}</dd>
            </template>
          </template>
        </dl>
        <p>条件同时满足；未列出的条件未设置。</p>
        <ul class="mt-2 space-y-1" aria-label="原始查询页范围">
          <li v-for="(page,index) in query.collectionEvidence.pages" :key="index">{{ title(page.rdjb) }} · 第 {{ page.page }} 页 · {{ page.status === 'success' ? '成功' : '失败' }} · {{ page.fetchedCount }} 条 · 总数 {{ page.declaredTotal ?? '未知' }} · 末页 {{ page.maxPage ?? '未知' }}<span v-if="page.error"> · {{ platformFailureForDisplay(page.error.message) }}</span></li>
        </ul>
        <p v-for="(position,index) in query.collectionEvidence.unfinished" :key="index" class="mt-1">未完成：{{ title(position.rdjb) }} · 第 {{ position.page }} 页</p>
        <p v-if="query.collectionEvidence.error" class="text-destructive mt-1">{{ platformFailureForDisplay(query.collectionEvidence.error.message) }}</p>
      </template>
      <p v-else class="text-muted-foreground">历史记录未保留完整查询条件与页范围，完整性未知。查询键：{{ query.queryKey }}</p>
    </article>
  </details>
</template>
