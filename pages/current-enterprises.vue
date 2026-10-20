<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { createReusableTemplate, useMediaQuery, watchDebounced } from '@vueuse/core'
import { useQuery } from '@pinia/colada'
import { Search } from '@lucide/vue'
import { TITLES } from '~~/lib/labels'
import { CURRENT_TITLES, type CurrentTitle } from '~~/lib/roster/current-titles'
import type { CurrentRow } from '~~/lib/roster/current-qualification'
import { NINGBO_DISTRICTS, NINGBO_INDEPENDENT_ZONES } from '~~/lib/domain'
import { captureQueryRequest, useRetainedQuerySnapshot } from '~/composables/useRetainedQuerySnapshot'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import PageHeader from '@/components/PageHeader.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import CurrentRosterExportEntry from '@/components/CurrentRosterExportEntry.vue'
import CurrentRecognitionDatePicker from '@/components/CurrentRecognitionDatePicker.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import TablePagination from '@/components/TablePagination.vue'

const route = useRoute(), router = useRouter()
const isNarrow = useMediaQuery('(max-width: 639px)')
const advancedOpen = shallowRef(false)
// Reuse the same controls in the desktop toolbar and mobile disclosure.
const [DefineFilters, ReuseFilters] = createReusableTemplate()
const [DefineDates, ReuseDates] = createReusableTemplate()
const sortLabels = { id_asc: '稳定企业标识', name_asc: '企业名称升序', name_desc: '企业名称降序' }
const one = (value: unknown) => typeof value === 'string' ? value : ''
const positive = (value: unknown, fallback: number) => /^\d+$/.test(one(value)) && Number(one(value)) >= 1 ? Number(one(value)) : fallback
const title = computed<CurrentTitle>(() => CURRENT_TITLES.find(code => code === route.query.titleCode) ?? 'little_giant')
const q = computed(() => one(route.query.q))
const district = computed(() => one(route.query.district))
const recognitionFrom = computed(() => one(route.query.recognitionFrom))
const recognitionTo = computed(() => one(route.query.recognitionTo))
const validYear = computed(() => one(route.query.validYear))
const maintenanceYear = computed(() => one(route.query.maintenanceYear))
const maintenanceBatch = computed(() => one(route.query.maintenanceBatch))
const sort = computed(() => ['id_asc', 'name_asc', 'name_desc'].includes(one(route.query.sort)) ? one(route.query.sort) as 'id_asc' | 'name_asc' | 'name_desc' : 'id_asc')
const page = computed(() => positive(route.query.page, 1))
const pageSize = computed(() => Math.min(200, positive(route.query.pageSize, 25)))
const search = shallowRef(q.value)
const dateFrom = shallowRef(recognitionFrom.value), dateTo = shallowRef(recognitionTo.value)
watch(q, value => { search.value = value })
watch([recognitionFrom, recognitionTo], ([from,to]) => { dateFrom.value=from; dateTo.value=to })
watchDebounced(search, value => { if (value.trim() !== q.value) update({ q: value.trim() || undefined, page: undefined }) }, { debounce: 300 })

function update(changes: Record<string, string | undefined>) {
  const next: Record<string, string | undefined> = Object.fromEntries(Object.entries(route.query).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
  Object.assign(next, { titleCode: title.value }, changes)
  for (const [key, value] of Object.entries(next)) if (value == null || value === '') delete next[key]
  void router.push({ path: route.path, query: next })
}
const titleModel = computed({ get: () => title.value, set: (value: string) => update({ titleCode: value, page: undefined }) })
const districtModel = computed({ get: () => district.value || 'all', set: (value: string) => update({ district: value === 'all' ? undefined : value, page: undefined }) })
const sortModel = computed({ get: () => sort.value, set: (value: string) => update({ sort: value === 'id_asc' ? undefined : value, page: undefined }) })
const validYearModel = computed({ get: () => validYear.value || 'all', set: (value: string) => update({ validYear: value === 'all' ? undefined : value, page: undefined }) })
const maintenanceYearModel = computed({ get: () => maintenanceYear.value || 'all', set: (value: string) => update({ maintenanceYear: value === 'all' ? undefined : value, maintenanceBatch: undefined, page: undefined }) })
const maintenanceBatchModel = computed({ get: () => maintenanceBatch.value || 'all', set: (value: string) => update({ maintenanceBatch: value === 'all' ? undefined : value, page: undefined }) })
const params = computed(() => ({ titleCode: title.value, q: q.value || undefined, district: district.value || undefined, recognitionFrom: recognitionFrom.value || undefined, recognitionTo: recognitionTo.value || undefined, validYear: validYear.value || undefined, maintenanceYear: maintenanceYear.value || undefined, maintenanceBatch: maintenanceBatch.value || undefined, sort: sort.value, page: page.value, pageSize: pageSize.value }))
const activeRequest = computed(() => captureQueryRequest('current-qualified', params.value))
type Result = { rows: CurrentRow[]; total: number; uncertainTotal: number; options: { recognitionYears: number[]; validYears: number[]; maintenanceYears: number[]; maintenanceBatchesByYear: Record<string, number[]> }; page: number; pageSize: number; request: typeof activeRequest.value }
const { data, isLoading, error, refetch } = useQuery<Result>({
  key: () => ['current-qualified', params.value],
  query: async ({ entry }) => {
    const request = captureQueryRequest('current-qualified', entry.key[1] as typeof params.value)
    const response = await $fetch<Omit<Result, 'request'>>('/api/roster/current-enterprises', { query: request.params })
    return { ...response, request }
  },
  placeholderData: previous => previous,
})
const { displayed, isShowingPrevious, paginationDisabled } = useRetainedQuerySnapshot(data, isLoading, error, activeRequest)
const rows = computed(() => displayed.value?.rows ?? [])
const options = computed(() => displayed.value?.request.params.titleCode === title.value && displayed.value.options ? displayed.value.options : { recognitionYears: [], validYears: [], maintenanceYears: [], maintenanceBatchesByYear: {} })
const yearOptions = (values: number[], selected: string) => [...new Set([...values, ...(selected ? [Number(selected)] : [])])].sort((a,b) => a-b)
const batchOptions = computed(() => [...new Set([...(options.value.maintenanceBatchesByYear[maintenanceYear.value] ?? []), ...(maintenanceBatch.value ? [Number(maintenanceBatch.value)] : [])])].sort((a,b) => a-b))
const dateError = computed(() => dateFrom.value && dateTo.value && dateFrom.value > dateTo.value ? '起始日期不能晚于结束日期' : '')
const canApplyDate = computed(() => Boolean(dateFrom.value && dateTo.value) && !dateError.value && (dateFrom.value !== recognitionFrom.value || dateTo.value !== recognitionTo.value))
function applyDate() { if (canApplyDate.value) update({ recognitionFrom: dateFrom.value, recognitionTo: dateTo.value, page: undefined }) }
function clearDate() { dateFrom.value=''; dateTo.value=''; update({ recognitionFrom: undefined, recognitionTo: undefined, page: undefined }) }
function describeRequestParts(request: typeof activeRequest.value) {
  const p = request.params
  const filters = [p.q && `搜索：${p.q}`, p.district && `区县：${p.district}`, p.recognitionFrom && p.recognitionTo && `认定时间：${p.recognitionFrom} 至 ${p.recognitionTo}`, p.validYear && `有效年份：${p.validYear}`, p.maintenanceYear && `维护年份：${p.maintenanceYear}${p.maintenanceBatch ? ` 第 ${p.maintenanceBatch} 批` : ''}`].filter(Boolean)
  return { scope: `${TITLES[p.titleCode]}；${filters.length ? filters.join('；') : '未设筛选'}`, order: `排序：${sortLabels[p.sort]}；第 ${p.page} 页，每页 ${p.pageSize} 家` }
}
function describeRequest(request: typeof activeRequest.value) {
  const { scope, order } = describeRequestParts(request)
  return `${scope}；${order}`
}
const displayedDescription = computed(() => displayed.value ? describeRequestParts(displayed.value.request) : undefined)
const failureDescription = computed(() => displayed.value
  ? `当前显示：${describeRequest(displayed.value.request)}。请求目标：${describeRequest(activeRequest.value)}未加载成功。`
  : undefined)
const allDistricts = [...new Set([...NINGBO_DISTRICTS, ...NINGBO_INDEPENDENT_ZONES])]
const detailUrl = (id: number) => ({ path: `/enterprises/${id}`, query: { currentBack: new URLSearchParams(Object.entries(displayed.value!.request.params).filter((pair) => pair[1] != null).map(([key, value]) => [key, String(value)])).toString() } })
const activeFilterCount = computed(() => [q.value, district.value, recognitionFrom.value || recognitionTo.value, validYear.value, maintenanceYear.value, maintenanceBatch.value].filter(Boolean).length)
const hasFilters = computed(() => activeFilterCount.value > 0)
function clearFilters() { search.value = ''; dateFrom.value=''; dateTo.value=''; update({ q: undefined, district: undefined, recognitionFrom: undefined, recognitionTo: undefined, validYear: undefined, maintenanceYear: undefined, maintenanceBatch: undefined, page: undefined }) }
const recognitionSummary = (row: CurrentRow) => row.recognition ? `认定记录 ${row.recognition.year} 年（仅年份）` : '认定年份未记录'
const sourceSummary = (row: CurrentRow) => row.publication === '已见本称号宁波公布记录' ? '已见宁波公布记录' : row.publication
const conditionSummary = (row: CurrentRow) => {
  const valid = row.matchedValidYears?.length ? `有效年份 ${row.matchedValidYears.join('、')} 年` : '有效年份未核实'
  const maintenance = row.matchedMaintenance?.length ? `维护记录 ${row.matchedMaintenance.map(fact => `${fact.year} 年${fact.batch == null ? '' : `第 ${fact.batch} 批`}`).join('、')}` : '维护信息未核实'
  return `${valid} · ${maintenance}`
}
const distinctPublishedNames = (row: CurrentRow) => row.publishedNames.filter(name => name.trim() !== row.name.trim())
const movedInSummary = (row: CurrentRow) => row.notes.find(note => note.startsWith('已确认迁入宁波'))
useHead({ title: '优质中小企业查询' })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <DefineFilters>
      <Select v-model="districtModel">
        <SelectTrigger size="sm" class="bg-card w-32 shadow-none" aria-label="按区县筛选"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="all">全部区县</SelectItem><SelectItem v-for="place in allDistricts" :key="place" :value="place">{{ place }}</SelectItem></SelectGroup></SelectContent>
      </Select>
      <Select v-model="validYearModel">
        <SelectTrigger size="sm" class="bg-card w-36 shadow-none" aria-label="按有效年份筛选"><SelectValue placeholder="全部有效年份" /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="all">全部有效年份</SelectItem><SelectItem v-for="yearOption in yearOptions(options.validYears, validYear)" :key="yearOption" :value="String(yearOption)">{{ yearOption }} 年</SelectItem></SelectGroup></SelectContent>
      </Select>
      <Select v-model="maintenanceYearModel">
        <SelectTrigger size="sm" class="bg-card w-36 shadow-none" aria-label="按维护年份筛选"><SelectValue placeholder="全部维护年份" /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="all">全部维护年份</SelectItem><SelectItem v-for="yearOption in yearOptions(options.maintenanceYears, maintenanceYear)" :key="yearOption" :value="String(yearOption)">{{ yearOption }} 年</SelectItem></SelectGroup></SelectContent>
      </Select>
      <Select v-model="maintenanceBatchModel" :disabled="!maintenanceYear">
        <SelectTrigger size="sm" class="bg-card w-36 shadow-none" aria-label="按维护批次筛选"><SelectValue placeholder="全部维护批次" /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="all">全部维护批次</SelectItem><SelectItem v-for="batch in batchOptions" :key="batch" :value="String(batch)">第 {{ batch }} 批</SelectItem></SelectGroup></SelectContent>
      </Select>
      <Select v-model="sortModel">
        <SelectTrigger size="sm" class="bg-card w-48 shadow-none" aria-label="排序方式"><SelectValue>排序：{{ sortLabels[sort] }}</SelectValue></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="id_asc">稳定企业标识</SelectItem><SelectItem value="name_asc">企业名称升序</SelectItem><SelectItem value="name_desc">企业名称降序</SelectItem></SelectGroup></SelectContent>
      </Select>
    </DefineFilters>
    <DefineDates>
      <div class="flex flex-wrap items-end gap-2">
        <div class="flex flex-col gap-1"><Label for="recognition-from">认定时间起</Label><CurrentRecognitionDatePicker id="recognition-from" v-model="dateFrom" label="认定时间起" /></div>
        <div class="flex flex-col gap-1"><Label for="recognition-to">认定时间止</Label><CurrentRecognitionDatePicker id="recognition-to" v-model="dateTo" label="认定时间止" /></div>
        <Button variant="outline" size="sm" :disabled="!canApplyDate" @click="applyDate">应用时间</Button>
        <Button v-if="recognitionFrom || recognitionTo" variant="ghost" size="sm" @click="clearDate">清除时间</Button>
        <span v-if="dateError" class="text-destructive text-sm" role="alert">{{ dateError }}</span>
        <span v-else class="text-muted-foreground text-[13px] leading-5">正式认定仅有年份时，时间范围须完整覆盖该年。</span>
      </div>
    </DefineDates>
    <PageHeader title="优质中小企业查询" description="按本库资格判定查询当前有效企业。">
      <template #actions><CurrentRosterExportEntry :title-code="title" /></template>
    </PageHeader>
    <Tabs v-model="titleModel">
      <TabsList class="h-auto max-w-full flex-wrap">
        <TabsTrigger v-for="code in CURRENT_TITLES" :key="code" :value="code">{{ TITLES[code] }}</TabsTrigger>
      </TabsList>
    </Tabs>
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative w-full sm:w-72">
        <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
        <Input v-model="search" class="bg-card h-8 pl-8 shadow-none" placeholder="名称、曾用名或信用代码" aria-label="搜索企业名称、已确认曾用名或统一社会信用代码" />
      </div>
      <ReuseFilters v-if="!isNarrow" />
      <Button v-if="hasFilters" variant="ghost" size="sm" @click="clearFilters">清除筛选</Button>
    </div>
    <ReuseDates v-if="!isNarrow" />
    <DisclosurePanel v-else v-model:open="advancedOpen" compact :heading-level="2" :title="`高级筛选与排序（已选 ${activeFilterCount} 项）`">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2"><ReuseFilters /></div>
        <ReuseDates />
      </div>
    </DisclosurePanel>
    <div v-if="hasFilters" class="flex flex-wrap items-center gap-1.5" aria-label="已选筛选条件">
      <span class="text-muted-foreground text-xs">已选条件：</span>
      <Button v-if="q" variant="outline" size="sm" @click="search=''; update({q:undefined,page:undefined})">搜索：{{ q }} ×</Button>
      <Button v-if="district" variant="outline" size="sm" @click="update({district:undefined,page:undefined})">区县：{{ district }} ×</Button>
      <Button v-if="recognitionFrom && recognitionTo" variant="outline" size="sm" @click="clearDate">认定时间：{{ recognitionFrom }} 至 {{ recognitionTo }} ×</Button>
      <Button v-if="validYear" variant="outline" size="sm" @click="update({validYear:undefined,page:undefined})">有效年份：{{ validYear }} ×</Button>
      <Button v-if="maintenanceYear" variant="outline" size="sm" @click="update({maintenanceYear:undefined,maintenanceBatch:undefined,page:undefined})">维护年份：{{ maintenanceYear }} ×</Button>
      <Button v-if="maintenanceBatch" variant="outline" size="sm" @click="update({maintenanceBatch:undefined,page:undefined})">维护批次：第 {{ maintenanceBatch }} 批 ×</Button>
    </div>
    <p v-if="displayed" class="text-muted-foreground text-[13px] leading-5" aria-live="polite">当前显示：{{ displayedDescription?.scope }}<span class="block sm:inline"><span class="hidden sm:inline">；</span>{{ displayedDescription?.order }}<span :class="{ invisible: !isShowingPrevious }">（上次成功结果）</span></span></p>
    <p v-if="displayed?.uncertainTotal && displayed.request.params.recognitionFrom" class="text-muted-foreground text-sm">另有 {{ displayed.uncertainTotal }} 家仅有年份精度，与所选时间部分重叠或缺少日期事实，未计入确定结果。</p>
    <Card class="gap-0 overflow-hidden py-0 shadow-none">
      <CardContent class="relative p-0">
        <TableLoadingStatus kind="ledger" :loading="isLoading" label="正在查询当前有效企业…" />
        <TableFailureState v-if="error" title="当前有效企业查询失败" :compact="Boolean(displayed)" :pending="isLoading" :description="failureDescription" @retry="refetch()" />
        <div v-if="!error || displayed" class="data-table-scroll hidden sm:block [&_[data-slot=table-container]]:overflow-visible">
          <Table class="data-table min-w-[850px] table-fixed">
            <TableHeader><TableRow class="hover:bg-transparent">
              <TableHead class="bg-muted w-[24%]">企业名称</TableHead><TableHead class="bg-muted w-[19%]">统一社会信用代码</TableHead><TableHead class="bg-muted w-[12%]">区县</TableHead><TableHead class="bg-muted w-[31%]">认定与资格依据</TableHead><TableHead class="bg-muted w-[14%]">详情与出处</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="row in rows" :key="row.enterpriseId">
                <TableCell class="align-top break-words"><span class="font-medium">{{ row.name }}</span><span v-if="row.aliases.length" class="text-muted-foreground mt-1 block text-xs">曾用名：{{ row.aliases.join('、') }}</span></TableCell>
                <TableCell class="align-top break-all font-mono text-xs">{{ row.uscc ?? '未记录' }}</TableCell>
                <TableCell class="align-top">{{ row.district ?? '未记录' }}</TableCell>
                <TableCell class="align-top break-words text-sm leading-5">
                  <p><span class="text-muted-foreground">{{ recognitionSummary(row) }}</span><span class="mx-1 text-muted-foreground">·</span>{{ sourceSummary(row) }}</p>
                  <p class="text-muted-foreground">{{ conditionSummary(row) }}</p>
                  <p v-if="distinctPublishedNames(row).length" class="text-muted-foreground">更名 · 公布名：{{ distinctPublishedNames(row).join('、') }}</p>
                  <p v-if="movedInSummary(row)" class="text-muted-foreground">{{ movedInSummary(row) }}</p>
                </TableCell>
                <TableCell class="align-top"><Button as-child variant="outline" size="sm"><NuxtLink :to="detailUrl(row.enterpriseId)">查看详情与出处</NuxtLink></Button></TableCell>
              </TableRow>
              <TableRow v-if="isLoading && !displayed"><TableCell v-for="n in 5" :key="n"><Skeleton class="h-3 w-full" /></TableCell></TableRow>
              <TableRow v-if="displayed && !rows.length"><TableCell colspan="5" class="p-0"><Empty class="border-0"><EmptyHeader><EmptyTitle>没有符合条件的当前有效企业</EmptyTitle></EmptyHeader></Empty></TableCell></TableRow>
            </TableBody>
          </Table>
        </div>
        <div v-if="isLoading && !displayed" class="flex flex-col gap-3 p-3 pt-8 sm:hidden" data-testid="current-mobile-loading" aria-hidden="true">
          <Skeleton class="h-5 w-2/3" />
          <Skeleton class="h-3 w-1/2" />
          <Skeleton class="h-4 w-full" />
          <Skeleton class="h-4 w-3/4" />
        </div>
        <ul v-if="rows.length" class="flex flex-col divide-y sm:hidden" aria-label="当前有效企业列表">
          <li v-for="row in rows" :key="row.enterpriseId" class="flex min-w-0 flex-col gap-1.5 p-3" data-testid="current-enterprise-card">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0"><p class="font-medium break-words">{{ row.name }}</p><p class="text-muted-foreground break-all font-mono text-xs">{{ row.uscc ?? '信用代码未记录' }}</p></div>
              <Button as-child variant="outline" size="sm" class="min-h-11 shrink-0"><NuxtLink :to="detailUrl(row.enterpriseId)" :aria-label="`查看 ${row.name} 详情与出处`">详情与出处</NuxtLink></Button>
            </div>
            <p class="text-sm leading-5">{{ recognitionSummary(row) }} · {{ sourceSummary(row) }}</p>
            <p class="text-muted-foreground text-sm leading-5">{{ conditionSummary(row) }}</p>
            <p v-if="distinctPublishedNames(row).length" class="text-muted-foreground text-sm leading-5">更名 · 公布名：{{ distinctPublishedNames(row).join('、') }}</p>
            <p v-if="movedInSummary(row)" class="text-muted-foreground text-sm leading-5">{{ movedInSummary(row) }}</p>
          </li>
        </ul>
        <Empty v-if="displayed && !rows.length" class="sm:hidden border-0"><EmptyHeader><EmptyTitle>没有符合条件的当前有效企业</EmptyTitle></EmptyHeader></Empty>
      </CardContent>
    </Card>
    <TablePagination v-if="displayed" :page="displayed.request.page" :page-size="displayed.request.pageSize" :total="displayed.total" :loading="paginationDisabled" unit="家企业" @update:page="update({ page: $event === 1 ? undefined : String($event) })" @update:page-size="update({ pageSize: String($event), page: undefined })" />
  </div>
</template>
