<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { PLATFORM_QUERY_STATUSES, PLATFORM_RDJBS, RELATION_DECLARE_KINDS } from '~~/lib/labels'
import { formatFetchTime } from '~~/lib/reconcile-time'
import PlatformQueryProvenance from './PlatformQueryProvenance.vue'
import PlatformRecordDetails from './PlatformRecordDetails.vue'
import { platformFailureForDisplay, recognizedField } from '~~/lib/roster/platform-records'
import type { PlatformRecord, PlatformRecordQuery } from '~~/lib/roster/platform-records'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const props = defineProps<{ queries: PlatformRecordQuery[]; relations: PlatformRecord[] }>()
const selectedTitle = ref('all')
const selectedSource = ref('all')
const collapsedGroups = ref(new Set<string>())
const groupKey = (source: string, title: string) => `${source}:${title}`
const toggleGroup = (source: string, title: string) => {
  const next = new Set(collapsedGroups.value)
  const key = groupKey(source, title)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedGroups.value = next
}
const time = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : formatFetchTime(value) ?? '未提供'
const queryById = computed(() => new Map(props.queries.map(query => [query.id, query])))
// 申报记录未带称号时，只通过相同平台编号的唯一关联归属分组；不按年份、名称猜测。
const rows = computed(() => props.relations.map(record => {
  const query = queryById.value.get(record.queryId)
  const titles = new Set(props.relations
    .filter(other => record.relationKey && other.relationKey === record.relationKey && queryById.value.get(other.queryId)?.interface === 'business_list')
    .map(other => queryById.value.get(other.queryId)?.rdjb).filter(Boolean))
  const title = query?.interface === 'recognized_list' ? record.sourceRdjb ?? (query.rdjb.split(',').length === 1 ? query.rdjb : '') : query?.rdjb || (titles.size === 1 ? [...titles][0]! : '')
  return { record, query, title }
}))
const titles = computed(() => {
  const values = new Set([...props.queries.flatMap(query => query.rdjb.split(',')).filter(Boolean), ...rows.value.map(row => row.title)])
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
const sources = [
  { source: 'business_list', label: '关联记录' },
  { source: 'apply_list', label: '申报记录' },
  { source: 'recognized_list', label: '已认定企业列表' },
]
const tables = computed(() => sources.filter(table => selectedSource.value === 'all' || selectedSource.value === table.source).map(table => {
  const tableRows = rows.value.filter(row => row.query?.interface === table.source && (activeTitle.value === 'all' || row.title === (activeTitle.value === 'unassigned' ? '' : activeTitle.value)))
  const groups = new Map<string, typeof tableRows>()
  for (const row of tableRows) {
    const group = groups.get(row.title) ?? []
    group.push(row)
    groups.set(row.title, group)
  }
  return {
    ...table,
    queries: props.queries.filter(query => query.interface === table.source && (activeTitle.value === 'all' || query.rdjb.split(',').includes(activeTitle.value === 'unassigned' ? '' : activeTitle.value) || tableRows.some(row => row.query?.id === query.id))),
    rows: tableRows,
    recognized: table.source === 'recognized_list',
    columns: tableRows.some(row => row.record.aliasNameRaw) ? 10 : 9,
    hasAliases: tableRows.some(row => row.record.aliasNameRaw),
    groups: [...groups].sort(([a], [b]) => (a || '9').localeCompare(b || '9')).map(([title, rows]) => ({
      title,
      label: PLATFORM_RDJBS[title] ?? '称号未标注',
      rows,
      collapsed: activeTitle.value === 'all' && collapsedGroups.value.has(groupKey(table.source, title)),
    })),
  }
}))
</script>

<template>
  <div class="min-w-0" data-testid="platform-records">
    <p v-if="!queries.length" class="text-muted-foreground text-[13px] leading-5">尚无平台查询记录</p>
    <Tabs :model-value="activeTitle" class="min-w-0 gap-3" @update:model-value="selectedTitle = String($event)">
      <label class="flex flex-wrap items-center gap-2 text-[13px]">记录来源
        <select v-model="selectedSource" aria-label="记录来源" class="bg-background h-9 min-w-0 rounded-md border px-3 focus-visible:outline-2 focus-visible:outline-ring">
          <option value="all">全部来源</option>
          <option v-for="source in sources" :key="source.source" :value="source.source">{{ source.label }}</option>
        </select>
      </label>
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
          <p v-if="table.recognized" class="text-muted-foreground mb-2 text-[13px] leading-5">按原查询时点保留的证据，含历史记录；不代表当前正式名单。维护年份与批次不作为正式认定事件。</p>
          <PlatformQueryProvenance :queries="table.queries" :source-label="table.label" />
          <p v-for="query in table.queries.filter(query => query.status === 'failed')" :key="query.id" class="text-destructive mb-2 text-[13px] leading-5" data-testid="platform-query-failure">查询 #{{ query.id }}：{{ platformFailureForDisplay(query.failureReason) ?? '本次查询未完成，不能据此判断平台有无记录。' }}</p>
          <div class="min-w-0 overflow-x-auto rounded-sm border" tabindex="0" :aria-label="`${table.label}表格，可横向滚动`">
            <table class="w-full text-left text-[13px] leading-5 whitespace-nowrap" :aria-label="table.label">
              <thead class="bg-muted/40 text-muted-foreground">
                <tr>
                  <th class="px-3 py-2 font-medium">序号</th>
                  <th class="min-w-52 px-3 py-2 font-medium">企业名称</th>
                  <th class="px-3 py-2 font-medium">信用代码</th>
                  <template v-if="table.recognized">
                  <th v-for="label in ['平台属地', '平台认定信息', '有效期（原值）', '维护年份', '维护批次']" :key="label" class="px-3 py-2 font-medium">{{ label }}</th>
                  </template>
                  <template v-else>
                  <th class="px-3 py-2 font-medium">省份</th>
                  <th class="px-3 py-2 font-medium">申报类型</th>
                  <th class="px-3 py-2 font-medium">办理状态</th>
                  <th class="px-3 py-2 font-medium">申报时间</th>
                  <th class="px-3 py-2 font-medium">维护批次</th>
                  </template>
                  <th v-if="table.hasAliases" class="px-3 py-2 font-medium">曾用名</th>
                <th class="px-3 py-2 font-medium">出处 / 原字段</th>
                </tr>
              </thead>
              <tbody v-for="group in table.groups" :key="group.title" :data-record-title="group.title">
                <tr v-if="activeTitle === 'all'" class="bg-accent/40 border-t" data-testid="platform-title-group">
                  <th :colspan="table.columns" class="p-0 text-left font-medium" scope="rowgroup">
                    <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" :aria-expanded="!group.collapsed" :aria-label="`${group.label}，${group.rows.length}条${table.label}`" @click="toggleGroup(table.source, group.title)">
                      <ChevronDown class="size-3.5 shrink-0" :class="{ '-rotate-90': group.collapsed }" />
                      <span>{{ group.label }}</span>
                      <span class="text-muted-foreground font-normal">{{ group.rows.length }} 条</span>
                    </button>
                  </th>
                </tr>
                <template v-if="!group.collapsed">
                  <tr v-for="({record}, index) in group.rows" :key="record.id" class="border-t" data-testid="platform-relation" :data-record-id="record.id">
                    <td class="px-3 py-1.5 tabular-nums" :class="{ 'pl-9': activeTitle === 'all' }">{{ index + 1 }}</td>
                    <td class="px-3 py-1.5">{{ record.nameRaw ?? '未提供' }}<span v-if="table.recognized && record.enterpriseId === null" class="text-muted-foreground block text-xs">未匹配主体</span></td>
                    <td class="px-3 py-1.5 tabular-nums">{{ record.usccRaw ?? '未提供' }}</td>
                    <template v-if="table.recognized">
                    <td v-for="field in ['szq', 'rdxx', 'rddqrq', 'whpcyear', 'whpc']" :key="field" class="px-3 py-1.5">{{ recognizedField(record.rawFields, field) }}</td>
                    </template>
                    <template v-else>
                    <td class="px-3 py-1.5">{{ record.province ?? '未提供' }}</td>
                    <td class="px-3 py-1.5">{{ record.declareKind ? RELATION_DECLARE_KINDS[record.declareKind] ?? '类型待核' : '未提供' }}</td>
                    <td class="px-3 py-1.5">{{ record.status ?? '未提供' }}</td>
                    <td class="px-3 py-1.5 tabular-nums">{{ record.appliedAt ?? '未提供' }}</td>
                    <td class="px-3 py-1.5">{{ record.batch ?? '未提供' }}</td>
                    </template>
                    <td v-if="table.hasAliases" class="px-3 py-1.5">{{ record.aliasNameRaw ?? '—' }}</td>
                    <td class="px-3 py-1.5"><PlatformRecordDetails :record="record" :query="queryById.get(record.queryId)" /></td>
                  </tr>
                </template>
              </tbody>
              <tbody v-if="!table.rows.length">
                <tr><td :colspan="table.columns" class="text-muted-foreground px-3 py-3">{{ !table.queries.length ? '尚未查询此来源 / 称号' : table.queries.some(query => query.status === 'partial') ? '仅有部分查询证据，不能判断完整有无记录' : table.queries.some(query => query.status === 'failed') ? '本次查询未完成' : table.queries.some(query => query.status === 'not_queried') ? '尚未查询' : table.queries.some(query => query.status === 'no_record') ? '平台未返回记录' : '暂无记录' }}</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </TabsContent>
    </Tabs>
  </div>
</template>
