<script setup lang="ts">
import { computed, ref } from 'vue'
import { PLATFORM_QUERY_STATUSES, PLATFORM_RDJBS, RELATION_DECLARE_KINDS, RELATION_MATCH_BASES, VERIFICATION_STATUSES } from '~~/lib/labels'
import { formatFetchTime } from '~~/lib/reconcile-time'
import { platformFailureForDisplay } from '~~/lib/roster/platform-records'
import type { PlatformRecord, PlatformRecordQuery } from '~~/lib/roster/platform-records'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const props = defineProps<{ queries: PlatformRecordQuery[]; relations: PlatformRecord[] }>()
const selectedTitle = ref('all')
const time = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : formatFetchTime(value) ?? '未提供'
const queryById = computed(() => new Map(props.queries.map(query => [query.id, query])))
// 申报记录未带称号时，只通过相同平台编号的唯一关联归属分组；不按年份、名称猜测。
const rows = computed(() => props.relations.map(record => {
  const query = queryById.value.get(record.queryId)
  const titles = new Set(props.relations
    .filter(other => record.relationKey && other.relationKey === record.relationKey && queryById.value.get(other.queryId)?.interface === 'business_list')
    .map(other => queryById.value.get(other.queryId)?.rdjb).filter(Boolean))
  const title = query?.rdjb || (titles.size === 1 ? [...titles][0]! : '')
  return { record, query, title }
}))
const titles = computed(() => {
  const values = new Set([...props.queries.map(query => query.rdjb).filter(Boolean), ...rows.value.map(row => row.title)])
  return [
    { value: 'all', label: '全部' },
    ...Object.entries(PLATFORM_RDJBS).filter(([value]) => values.has(value)).map(([value, label]) => ({ value, label })),
    ...(values.has('') ? [{ value: 'unassigned', label: '称号未标注' }] : []),
  ]
})
const activeTitle = computed(() => titles.value.some(title => title.value === selectedTitle.value) ? selectedTitle.value : 'all')
const querySummary = (queries: PlatformRecordQuery[]) => {
  if (!queries.length) return ''
  const latest = [...queries].sort((a, b) => b.queriedAt.localeCompare(a.queriedAt))[0]!
  const statuses = [...new Set(queries.map(query => PLATFORM_QUERY_STATUSES[query.status] ?? '状态待核'))]
  return `${time(latest.queriedAt)} · ${statuses.join(' / ')}`
}
const tables = computed(() => [
  { source: 'business_list', label: '关联记录' },
  { source: 'apply_list', label: '申报记录' },
].map(table => ({
  ...table,
  queries: props.queries.filter(query => query.interface === table.source && (activeTitle.value === 'all' || query.rdjb === (activeTitle.value === 'unassigned' ? '' : activeTitle.value) || rows.value.some(row => row.query?.id === query.id && row.title === activeTitle.value))),
  rows: rows.value.filter(row => row.query?.interface === table.source && (activeTitle.value === 'all' || row.title === (activeTitle.value === 'unassigned' ? '' : activeTitle.value))),
})))
</script>

<template>
  <div class="min-w-0" data-testid="platform-records">
    <p v-if="!queries.length" class="text-muted-foreground text-[13px] leading-5">尚无平台查询记录</p>
    <Tabs v-else :model-value="activeTitle" class="min-w-0 gap-3" @update:model-value="selectedTitle = String($event)">
      <div class="min-w-0 overflow-x-auto">
        <TabsList class="h-9" aria-label="平台记录称号">
          <TabsTrigger v-for="title in titles" :key="title.value" :value="title.value" :data-title-value="title.value" class="text-[13px]">{{ title.label }}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent :value="activeTitle" class="min-w-0 space-y-5">
        <section v-for="table in tables" :key="table.source" class="min-w-0" :data-record-kind="table.source">
          <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h4 class="text-sm font-medium">{{ table.label }} <span class="text-muted-foreground font-normal">{{ table.rows.length }} 条</span></h4>
            <span v-if="table.queries.length" class="text-muted-foreground text-[13px]" data-testid="platform-query-summary">{{ querySummary(table.queries) }}</span>
          </div>
          <p v-for="query in table.queries.filter(query => query.status === 'failed')" :key="query.id" class="text-destructive mb-2 text-[13px] leading-5" data-testid="platform-query-failure">{{ platformFailureForDisplay(query.failureReason) ?? '本次查询未完成，不能据此判断平台有无记录。' }}</p>
          <div class="min-w-0 overflow-x-auto rounded-sm border" tabindex="0" :aria-label="`${table.label}表格，可横向滚动`">
            <table class="w-full text-left text-[13px] leading-5 whitespace-nowrap" :aria-label="table.label">
              <thead class="bg-muted/40 text-muted-foreground">
                <tr>
                  <th class="px-3 py-2 font-medium">序号</th><th class="min-w-52 px-3 py-2 font-medium">企业名称</th><th class="px-3 py-2 font-medium">信用代码</th><th class="px-3 py-2 font-medium">区域</th><th v-if="activeTitle === 'all'" class="px-3 py-2 font-medium">称号</th><th class="px-3 py-2 font-medium">申报类型</th><th class="px-3 py-2 font-medium">办理状态</th><th class="px-3 py-2 font-medium">申报时间</th><th class="px-3 py-2 font-medium">平台编号</th><th class="px-3 py-2 font-medium">维护批次</th><th class="px-3 py-2 font-medium">认定批次</th><th class="px-3 py-2 font-medium">年份</th><th class="px-3 py-2 font-medium">核实状态</th><th class="px-3 py-2 font-medium">匹配依据</th><th v-if="table.rows.some(row => row.record.aliasNameRaw)" class="px-3 py-2 font-medium">曾用名</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="{record, title} in table.rows" :key="record.id" class="border-t" data-testid="platform-relation" :data-record-id="record.id">
                  <td class="px-3 py-1.5 tabular-nums">{{ record.sequenceNo }}</td><td class="px-3 py-1.5">{{ record.nameRaw ?? '未提供' }}</td><td class="px-3 py-1.5 tabular-nums">{{ record.usccRaw ?? '未提供' }}</td><td class="px-3 py-1.5">{{ record.province ?? '未提供' }}</td><td v-if="activeTitle === 'all'" class="px-3 py-1.5">{{ PLATFORM_RDJBS[title] ?? '未标注' }}</td><td class="px-3 py-1.5">{{ record.declareKind ? RELATION_DECLARE_KINDS[record.declareKind] ?? '类型待核' : '未提供' }}</td><td class="px-3 py-1.5">{{ record.status ?? '未提供' }}</td><td class="px-3 py-1.5 tabular-nums">{{ record.appliedAt ?? '未提供' }}</td><td class="px-3 py-1.5 tabular-nums">{{ record.relationKey ?? '未提供' }}</td><td class="px-3 py-1.5">{{ record.batch ?? '未提供' }}</td><td class="px-3 py-1.5">{{ record.awardBatchLabel ?? '未提供' }}</td><td class="px-3 py-1.5 tabular-nums">{{ record.year ?? '未提供' }}</td><td class="px-3 py-1.5">{{ VERIFICATION_STATUSES[record.verificationStatus] ?? '待核实' }}</td><td class="px-3 py-1.5">{{ RELATION_MATCH_BASES[record.matchBasis] ?? '匹配待核' }}</td><td v-if="table.rows.some(row => row.record.aliasNameRaw)" class="px-3 py-1.5">{{ record.aliasNameRaw ?? '—' }}</td>
                </tr>
                <tr v-if="!table.rows.length"><td :colspan="activeTitle === 'all' ? 14 : 13" class="text-muted-foreground px-3 py-3">{{ table.queries.some(query => query.status === 'failed') ? '本次查询未完成' : table.queries.some(query => query.status === 'not_queried') ? '尚未查询' : table.queries.some(query => query.status === 'no_record') ? '平台未返回记录' : '暂无记录' }}</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </TabsContent>
    </Tabs>
  </div>
</template>
