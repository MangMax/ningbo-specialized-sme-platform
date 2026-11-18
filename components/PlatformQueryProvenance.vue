<script setup lang="ts">
import { computed } from 'vue'
import { PLATFORM_QUERY_STATUSES, PLATFORM_RDJBS } from '~~/lib/labels'
import { formatFetchTime } from '~~/lib/reconcile-time'
import { platformFailureForDisplay } from '~~/lib/roster/platform-records'
import type { PlatformRecordQuery } from '~~/lib/roster/platform-records'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
const props = defineProps<{ queries: PlatformRecordQuery[]; sourceLabel: string }>()
const time = (value: string) => formatFetchTime(value) ?? value
const title = (value: string | null) => PLATFORM_RDJBS[value ?? ''] ?? '称号未标注'
const conditions: Record<string, string> = { name: '企业名称条件', uscc: '信用代码条件', sqsj: '申报时间范围', rddqrq: '有效年份条件', whpcyear: '维护年份条件', whpc: '维护批次条件', szq: '属地筛选代码（原值）', orderField: '排序字段', orderDirection: '排序方向' }
const conditionValue = (key: string, value: string) => key === 'orderField' && value === 'qymc' ? '企业名称' : key === 'orderDirection' ? ({asc:'升序',desc:'降序'}[value] ?? value) : value
const history = computed(() => [...props.queries].sort((a,b) => b.queriedAt.localeCompare(a.queriedAt) || b.id - a.id).map(query => {
  const evidence = query.collectionEvidence ?? query.legacyProvenance?.collection
  const failures = [...new Set([...(evidence?.pages.map(page => page.error?.message) ?? []), evidence?.error?.message, query.failureReason]
    .map(platformFailureForDisplay).filter((message): message is string => !!message))]
  const samePosition = (a: {rdjb: string | null; page: number}, b: {rdjb: string | null; page: number}) => a.rdjb === b.rdjb && a.page === b.page
  return {
    query,
    evidence,
    failures,
    queryTitlesDiffer: evidence && [...query.rdjb.split(',')].sort().join(',') !== [...evidence.titleScope.rdjb].sort().join(','),
    pages: evidence?.pages.map(page => ({ ...page,
      unfinished: evidence.unfinished.some(position => samePosition(page, position)),
      failureIndex: failures.indexOf(platformFailureForDisplay(page.error?.message) ?? '') + 1,
    })) ?? [],
    unfinished: evidence?.unfinished.filter(position => !evidence.pages.some(page => samePosition(page, position))) ?? [],
  }
}))
</script>
<template>
  <DisclosurePanel v-if="queries.length" compact padded content-class="px-3 pb-2" class="mb-2 min-w-0 rounded-sm border text-table leading-5" data-testid="platform-query-history" :title="`查询出处与历史 · ${queries.length} 次`">
      <p v-if="queries.some(query => query.interface === 'recognized_list')" class="text-muted-foreground mt-3">原查询时点的历史证据，不代表当前正式名单。维护年份与批次不作为正式认定事件。</p>
      <article v-for="item in history" :key="item.query.id" class="mt-3 min-w-0 border-t pt-3 break-words [overflow-wrap:anywhere]" data-testid="platform-query-provenance">
        <p class="font-medium">查询 #{{ item.query.id }} · {{ sourceLabel }} · {{ PLATFORM_QUERY_STATUSES[item.query.status] ?? '状态待核' }} · {{ item.query.relationCount }} 条来源行</p>
        <p>原查询时点：{{ time(item.query.queriedAt) }}</p>
        <p v-if="item.query.legacyProvenance" class="text-muted-foreground">旧采集分页来源已补证；原始字段类型仍未记录。</p>
        <template v-if="item.evidence">
          <p>完成时点：{{ time(item.evidence.completedAt) }}</p>
          <p>完整性：{{ { complete: '所请求范围完整', partial: '部分', not_queried: '未查询' }[item.evidence.completeness] }} · {{ item.evidence.fullRange ? '从首页查询' : '续页范围，非全范围' }}</p>
          <p>已采集 {{ item.evidence.fetchedCount }} 条 · 平台总数：{{ item.evidence.declaredTotal ?? '未知' }}</p>
          <p>称号范围：{{ item.evidence.titleScope.mode === 'selected' ? '指定称号' : '来源默认称号' }} · {{ item.evidence.titleScope.rdjb.map(value => `${title(value)}（${value}）`).join('、') }}</p>
          <p v-if="item.queryTitlesDiffer">查询标注称号：{{ item.query.rdjb.split(',').map(title).join('、') }}</p>
          <dl class="my-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
            <template v-for="(label,key) in conditions" :key="key">
              <template v-if="item.evidence.effectiveConditions[key as keyof typeof item.evidence.effectiveConditions] != null">
                <dt class="text-muted-foreground">{{ label }}</dt><dd>{{ conditionValue(key, item.evidence.effectiveConditions[key as keyof typeof item.evidence.effectiveConditions]!) }}</dd>
              </template>
            </template>
          </dl>
          <ul class="mt-2 flex flex-col gap-1" aria-label="原始查询页范围">
            <li v-for="(page,index) in item.pages" :key="index">称号 {{ page.rdjb ?? '未标注' }} · 第 {{ page.page }} 页 · {{ page.status === 'success' ? '成功' : '失败' }}<span v-if="page.unfinished"> · 未完成</span> · {{ page.fetchedCount }} 条 · 总数 {{ page.declaredTotal ?? '未知' }} · 末页 {{ page.maxPage ?? '未知' }}<span v-if="item.failures.length > 1 && page.failureIndex"> · 原因 {{ page.failureIndex }}</span></li>
          </ul>
          <p v-for="(position,index) in item.unfinished" :key="index" class="mt-1">未完成：称号 {{ position.rdjb ?? '未标注' }} · 第 {{ position.page }} 页</p>
        </template>
        <template v-else>
          <p>查询称号：{{ item.query.rdjb.split(',').map(title).join('、') }}</p>
          <p class="text-muted-foreground">历史记录未保留完整查询条件与页范围，完整性未知。查询键：{{ item.query.queryKey }}</p>
        </template>
        <p v-for="(failure,index) in item.failures" :key="failure" class="text-destructive mt-1"><span v-if="item.failures.length > 1">原因 {{ index + 1 }}：</span>{{ failure }}</p>
      </article>
  </DisclosurePanel>
</template>
