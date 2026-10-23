<script setup lang="ts">
import { computed, ref } from 'vue'
import { PLATFORM_QUERY_STATUS_ORDER, PLATFORM_RDJBS, RELATION_DECLARE_KINDS } from '~~/lib/labels'
import { formatFetchTime } from '~~/lib/reconcile-time'
import AssessmentStatusBadge from '@/components/evidence-review/AssessmentStatusBadge.vue'
import PlatformQueryProvenance from './PlatformQueryProvenance.vue'
import PlatformRecordDetails from './PlatformRecordDetails.vue'
import RecordSourceReader from './record-correspondence/SourceReader.vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { platformFailureForDisplay, recognizedField } from '~~/lib/roster/platform-records'
import type { PlatformRecord, PlatformRecordQuery } from '~~/lib/roster/platform-records'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

const props = defineProps<{ queries: PlatformRecordQuery[]; relations: PlatformRecord[]; returnTo?: string | null }>()
const emit = defineEmits<{ 'event-navigate': [eventId: number] }>()
const navigatingEventId = ref<number | null>(null)
function closeForEvent(eventId: number) {
  navigatingEventId.value = eventId
  selectedRelationId.value = null
}
function onSourceCloseAutoFocus(event: Event) {
  if (navigatingEventId.value === null) return
  // Finish arrival after the modal releases focus, without returning to its table button.
  event.preventDefault()
  emit('event-navigate', navigatingEventId.value)
  navigatingEventId.value = null
}
const selectedRelationId = ref<number | null>(null)
const selectedTitle = ref('all')
const selectedSource = ref('all')
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
  const latest = [...queries].sort((a, b) => b.queriedAt.localeCompare(a.queriedAt))[0]
  const statuses = new Set(queries.map(query => query.status))
  return {
    time: latest ? time(latest.queriedAt) : '',
    statuses: [...PLATFORM_QUERY_STATUS_ORDER, ...statuses].filter((status, index, all) => all.indexOf(status) === index && statuses.has(status)),
  }
}
const emptyMessage = (queries: PlatformRecordQuery[]) => !queries.length ? '尚未查询此来源 / 称号'
  : queries.some(query => query.status === 'partial') ? '仅有部分查询证据，不能判断完整有无记录'
  : queries.some(query => query.status === 'failed') ? '本次查询未完成'
  : queries.some(query => query.status === 'not_queried') ? '尚未查询'
  : queries.some(query => query.status === 'no_record') ? '平台未返回记录' : '暂无记录'
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
    })),
  }
}))
</script>

<template>
  <div class="min-w-0" data-testid="platform-records">
    <p v-if="!queries.length" class="text-muted-foreground text-[13px] leading-5">尚无平台查询记录</p>
    <Tabs v-else :model-value="activeTitle" class="min-w-0 gap-3" @update:model-value="selectedTitle = String($event)">
      <div class="flex flex-wrap items-center gap-2 text-[13px]">
        <span>记录来源</span>
        <Select v-model="selectedSource">
          <SelectTrigger aria-label="记录来源" class="w-52 max-w-full"><SelectValue /></SelectTrigger>
          <SelectContent @escape-key-down.stop>
            <SelectGroup>
              <SelectItem value="all">全部来源</SelectItem>
              <SelectItem v-for="source in sources" :key="source.source" :value="source.source">{{ source.label }}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <TabsList class="h-auto w-full flex-wrap justify-start gap-1" aria-label="平台记录称号">
        <TabsTrigger v-for="title in titles" :key="title.value" :value="title.value" :data-title-value="title.value" class="h-8 flex-none text-[13px]">{{ title.label }}</TabsTrigger>
      </TabsList>
      <TabsContent :value="activeTitle" class="flex min-w-0 flex-col gap-5">
        <section v-for="table in tables" :key="table.source" class="min-w-0" :data-record-kind="table.source">
          <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h4 class="text-sm font-medium">{{ table.label }} <span class="text-muted-foreground font-normal">{{ table.rows.length }} 条</span></h4>
            <div v-if="table.queries.length" class="flex flex-wrap items-center gap-1.5 text-[13px]" data-testid="platform-query-summary">
              <span class="text-muted-foreground whitespace-nowrap">{{ querySummary(table.queries).time }}</span>
              <AssessmentStatusBadge v-for="status in querySummary(table.queries).statuses" :key="status" kind="query" :value="status" />
            </div>
          </div>
          <PlatformQueryProvenance :queries="table.queries" :source-label="table.label" />
          <p v-for="query in table.queries.filter(query => query.status === 'failed')" :key="query.id" class="text-destructive mb-2 text-[13px] leading-5" data-testid="platform-query-failure">查询 #{{ query.id }}：{{ platformFailureForDisplay(query.failureReason) ?? '本次查询未完成，不能据此判断平台有无记录。' }}</p>
          <p v-if="!table.rows.length && emptyMessage(table.queries) !== '本次查询未完成'" class="text-muted-foreground text-[13px] leading-5" data-testid="platform-source-empty">{{ emptyMessage(table.queries) }}</p>
          <div v-if="table.rows.length" class="mb-1 sm:hidden">
            <p class="text-muted-foreground text-[13px] leading-5" data-testid="platform-table-scroll-hint">
              左右滑动查看全部字段（共 {{ table.columns }} 列）；企业名称在起始侧，不会被末列遮挡。
            </p>
          </div>
          <div v-if="table.rows.length" class="min-w-0 overflow-x-auto rounded-sm border" tabindex="0" :aria-label="`${table.label}表格，可横向滚动`">
            <table class="w-full min-w-[960px] text-left text-[13px] leading-5" :aria-label="table.label">
              <thead class="bg-muted/40 text-muted-foreground">
                <tr>
                  <th class="px-3 py-2 font-medium">序号</th>
                  <th class="min-w-52 px-3 py-2 font-medium">企业名称</th>
                  <th class="px-3 py-2 font-medium">信用代码</th>
                  <template v-if="table.recognized">
                  <th v-for="label in ['平台属地（原值/代码）', '平台认定信息', '有效期（原值）', '维护年份', '维护批次']" :key="label" class="px-3 py-2 font-medium" :class="{ 'min-w-[4.5rem] whitespace-nowrap': label === '维护年份' || label === '维护批次' }">{{ label }}</th>
                  </template>
                  <template v-else>
                  <th class="px-3 py-2 font-medium">省份</th>
                  <th class="px-3 py-2 font-medium">申报类型</th>
                  <th class="px-3 py-2 font-medium">办理状态</th>
                  <th class="px-3 py-2 font-medium">申报时间</th>
                  <th class="min-w-[4.5rem] px-3 py-2 font-medium whitespace-nowrap">维护批次</th>
                  </template>
                  <th v-if="table.hasAliases" class="px-3 py-2 font-medium">曾用名</th>
                <th class="bg-muted border-l px-3 py-2 font-medium">出处 / 原字段</th>
                </tr>
              </thead>
              <tbody v-for="group in table.groups" :key="group.title" :data-record-title="group.title">
                <tr v-if="activeTitle === 'all'" class="bg-muted/30 border-t" data-testid="platform-title-group">
                  <th :colspan="table.columns" class="px-3 py-2 text-left font-medium" scope="rowgroup">
                    {{ group.label }}
                    <span class="text-muted-foreground font-normal">{{ group.rows.length }} 条</span>
                  </th>
                </tr>
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
                  <td class="px-3 py-1.5">{{ record.status ?? '未提供' }}<span v-if="record.normalizationConflicts?.length" class="text-muted-foreground block text-xs">字段冲突，待核</span></td>
                  <td class="px-3 py-1.5 tabular-nums">{{ record.appliedAt ?? '未提供' }}</td>
                  <td class="px-3 py-1.5">{{ record.batch ?? '未提供' }}</td>
                  </template>
                  <td v-if="table.hasAliases" class="px-3 py-1.5">{{ record.aliasNameRaw ?? '—' }}</td>
                  <td class="bg-card border-l px-3 py-1.5"><div class="flex flex-col items-start gap-1"><PlatformRecordDetails :record="record" :query="queryById.get(record.queryId)" /><Button variant="ghost" size="sm" @click="selectedRelationId = record.id">对应事件/出处</Button></div></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </TabsContent>
    </Tabs>
    <Dialog :open="selectedRelationId !== null" @update:open="!$event && (selectedRelationId = null)">
      <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl" data-testid="platform-correspondence-dialog" @close-auto-focus="onSourceCloseAutoFocus">
        <DialogHeader><DialogTitle>平台原行对应事件/出处</DialogTitle><DialogDescription>按具体原行核对对应状态与正式事件；查询成功不等于对应已确认。</DialogDescription></DialogHeader>
        <RecordSourceReader v-if="selectedRelationId !== null" kind="relation" :id="selectedRelationId" :return-to="returnTo" @event-navigate="closeForEvent" />
      </DialogContent>
    </Dialog>
  </div>
</template>
