<script setup lang="ts">
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { createReusableTemplate, debounceFilter, useMediaQuery, watchWithFilter } from '@vueuse/core'
import { useQuery } from '@pinia/colada'
import { ChevronRight, Search } from '@lucide/vue'
import { CURRENT_STATUS_LABELS, type CurrentStatus } from '#sme-roster/lib/roster/current-status'
import { CURRENT_ENTERPRISES_TITLE, TITLES } from '#sme-roster/lib/labels'
import { CURRENT_TITLES, type CurrentTitle } from '#sme-roster/lib/roster/current-titles'
import type { CurrentQualifiedRow as CurrentRow, CurrentQualifiedResult } from '#sme-roster/lib/roster/current-qualified-page'
import { NINGBO_DISTRICTS, NINGBO_INDEPENDENT_ZONES } from '#sme-roster/lib/domain'
import { captureQueryRequest, useRetainedQuerySnapshot } from '#core/app/composables/useRetainedQuerySnapshot'
import ActiveFilterBar from '#core/app/components/ActiveFilterBar.vue'
import DataTableCard from '#core/app/components/DataTableCard.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import { Button } from '#core/app/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '#core/app/components/ui/empty'
import { Input } from '#core/app/components/ui/input'
import { Label } from '#core/app/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Skeleton } from '#core/app/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#core/app/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'
import RosterCurrentQualificationTimeline from '#sme-roster/app/components/CurrentQualificationTimeline.vue'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import RosterCurrentRosterExportEntry from '#sme-roster/app/components/CurrentRosterExportEntry.vue'
import DatePicker from '#core/app/components/DatePicker.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'
import TablePagination from '#core/app/components/TablePagination.vue'

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
const status = computed<CurrentStatus>(() => Object.hasOwn(CURRENT_STATUS_LABELS, one(route.query.status)) ? one(route.query.status) as CurrentStatus : 'effective')
const statusModel = computed({ get: () => status.value, set: (value: string) => update({ status: value, page: undefined }) })
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
// A queued search must not navigate after this page's scope has been disposed.
const searchDebounce = debounceFilter(300)
onScopeDispose(() => searchDebounce.cancel())
watchWithFilter(search, value => { if (value.trim() !== q.value) update({ q: value.trim() || undefined, page: undefined }) }, { eventFilter: searchDebounce })

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
const params = computed(() => ({ titleCode: title.value, status: status.value, q: q.value || undefined, district: district.value || undefined, recognitionFrom: recognitionFrom.value || undefined, recognitionTo: recognitionTo.value || undefined, validYear: validYear.value || undefined, maintenanceYear: maintenanceYear.value || undefined, maintenanceBatch: maintenanceBatch.value || undefined, sort: sort.value, page: page.value, pageSize: pageSize.value }))
const activeRequest = computed(() => captureQueryRequest('current-qualified', params.value))
// Older responses may lack the additive extension; absence is not a pending census.
type Result = Omit<CurrentQualifiedResult, 'responseVersion' | 'publishedPending'> & Partial<Pick<CurrentQualifiedResult, 'responseVersion' | 'publishedPending'>> & { request: typeof activeRequest.value }
const { data, isLoading, error, refetch } = useQuery<Result>({
  key: () => ['current-qualified', params.value],
  query: async ({ entry }) => {
    const request = captureQueryRequest('current-qualified', entry.key[1] as typeof params.value)
    const response = await $fetch<Omit<Result, 'request'>>('/api/roster/current-enterprises', { query: request.params })
    if (request.params.status !== 'effective' && response.responseVersion !== 'current-qualified-478-v2') throw new Error('当前服务未提供五类状态筛选，请刷新后重试')
    if ([...response.rows, ...(response.publishedPending?.rows ?? [])].some(row => row.publishedPresentation?.availability === 'unavailable')) throw new Error('Official published names unavailable')
    return { ...response, request }
  },
  placeholderData: previous => previous,
})
const { displayed, paginationDisabled } = useRetainedQuerySnapshot(data, isLoading, error, activeRequest)
const rows = computed(() => displayed.value?.rows ?? [])
const selectedAssessment = (row: CurrentRow) => row.qualificationAssessment?.titles.find(item => item.titleCode === displayed.value?.request.params.titleCode)
const timelineAssessment = (row: CurrentRow) => {
  const assessment = selectedAssessment(row)
  const supporting = assessment?.effectiveQualification?.supportingTitle
  return supporting ? row.qualificationAssessment?.titles.find(item => item.titleCode === supporting) : assessment
}
function updatePagination(changes: Record<string, string | undefined>) {
  if (!displayed.value || paginationDisabled.value) return
  const query: Record<string, string | undefined> = Object.fromEntries(Object.entries(displayed.value.request.params).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]))
  Object.assign(query, changes)
  for (const [key, value] of Object.entries(query)) if (value == null || value === '') delete query[key]
  void router.push({ path: route.path, query })
}
const options = computed(() => displayed.value?.request.params.titleCode === title.value && displayed.value.options ? displayed.value.options : { recognitionYears: [], validYears: [], maintenanceYears: [], maintenanceBatchesByYear: {} })
const yearOptions = (values: number[], selected: string) => [...new Set([...values, ...(selected ? [Number(selected)] : [])])].sort((a,b) => a-b)
const batchOptions = computed(() => [...new Set([...(options.value.maintenanceBatchesByYear[maintenanceYear.value] ?? []), ...(maintenanceBatch.value ? [Number(maintenanceBatch.value)] : [])])].sort((a,b) => a-b))
const dateError = computed(() => dateFrom.value && dateTo.value && dateFrom.value > dateTo.value ? '起始日期不能晚于结束日期' : '')
const canApplyDate = computed(() => Boolean(dateFrom.value && dateTo.value) && !dateError.value && (dateFrom.value !== recognitionFrom.value || dateTo.value !== recognitionTo.value))
function applyDate() { if (canApplyDate.value) update({ recognitionFrom: dateFrom.value, recognitionTo: dateTo.value, page: undefined }) }
function clearDate() { dateFrom.value=''; dateTo.value=''; update({ recognitionFrom: undefined, recognitionTo: undefined, page: undefined }) }
function describeRequestParts(request: typeof activeRequest.value) {
  const p = request.params
  const filters = [CURRENT_STATUS_LABELS[p.status], p.q && `搜索：${p.q}`, p.district && `区县：${p.district}`, p.recognitionFrom && p.recognitionTo && `认定时间：${p.recognitionFrom} 至 ${p.recognitionTo}`, p.validYear && `有效年份：${p.validYear}`, p.maintenanceYear && `维护年份：${p.maintenanceYear}${p.maintenanceBatch ? ` 第 ${p.maintenanceBatch} 批` : ''}`].filter(Boolean)
  return { scope: `${TITLES[p.titleCode]}；${filters.length ? filters.join('；') : '未设筛选'}`, order: `排序：${sortLabels[p.sort]}；第 ${p.page} 页，每页 ${p.pageSize} 家` }
}
function describeRequest(request: typeof activeRequest.value) {
  const { scope, order } = describeRequestParts(request)
  return `${scope}；${order}`
}
const failureDescription = computed(() => displayed.value
  ? `当前显示：${describeRequest(displayed.value.request)}。请求目标：${describeRequest(activeRequest.value)}未加载成功。`
  : undefined)
const allDistricts = [...new Set([...NINGBO_DISTRICTS, ...NINGBO_INDEPENDENT_ZONES])]
const detailUrl = (id: number) => ({ path: `/enterprises/${id}`, query: { currentBack: new URLSearchParams(Object.entries(displayed.value!.request.params).filter((pair) => pair[1] != null).map(([key, value]) => [key, String(value)])).toString() } })
const activeFilters = computed(() => {
  const filters: { key: string; label: string; clear: () => void }[] = []
  if (status.value !== 'effective') filters.push({ key: 'status', label: `状态：${CURRENT_STATUS_LABELS[status.value]}`, clear: () => update({ status: undefined, page: undefined }) })
  if (q.value) filters.push({ key: 'q', label: `搜索：${q.value}`, clear: () => { search.value = ''; update({ q: undefined, page: undefined }) } })
  if (district.value) filters.push({ key: 'district', label: `区县：${district.value}`, clear: () => update({ district: undefined, page: undefined }) })
  if (recognitionFrom.value || recognitionTo.value) {
    const range = [recognitionFrom.value, recognitionTo.value].filter(Boolean).join(' 至 ')
    filters.push({ key: 'recognition', label: `认定时间：${range}`, clear: clearDate })
  }
  if (validYear.value) filters.push({ key: 'validYear', label: `有效年份：${validYear.value}`, clear: () => update({ validYear: undefined, page: undefined }) })
  if (maintenanceYear.value) filters.push({ key: 'maintenanceYear', label: `维护年份：${maintenanceYear.value}`, clear: () => update({ maintenanceYear: undefined, maintenanceBatch: undefined, page: undefined }) })
  if (maintenanceBatch.value) filters.push({ key: 'maintenanceBatch', label: `维护批次：第 ${maintenanceBatch.value} 批`, clear: () => update({ maintenanceBatch: undefined, page: undefined }) })
  return filters
})
/** `ActiveFilterBar` 只认「键：值」文案，撤掉某一项时回到这里按 key 找动作。 */
const filterItems = computed(() => activeFilters.value.map(({ key, label }) => ({ key, label })))
function removeFilter(key: string) {
  activeFilters.value.find((filter) => filter.key === key)?.clear()
}
const advancedFilterCount = computed(() => activeFilters.value.filter(filter => filter.key !== 'q' && filter.key !== 'status').length)
function clearFilters() {
  search.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  update({ status: undefined, q: undefined, district: undefined, recognitionFrom: undefined, recognitionTo: undefined, validYear: undefined, maintenanceYear: undefined, maintenanceBatch: undefined, page: undefined })
}
useHead({ title: CURRENT_ENTERPRISES_TITLE })
</script>

<template>
  <WorkspacePage :title="CURRENT_ENTERPRISES_TITLE">
    <DefineFilters>
      <Select v-model="districtModel">
        <SelectTrigger size="sm" class="bg-card w-32 shadow-none" aria-label="按区县筛选"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="all">全部区县</SelectItem><SelectItem v-for="place in allDistricts" :key="place" :value="place">{{ place }}</SelectItem></SelectGroup></SelectContent>
      </Select>
      <Select v-if="options.validYears.length || validYear" v-model="validYearModel">
        <SelectTrigger size="sm" class="bg-card w-36 shadow-none" aria-label="按有效年份筛选"><SelectValue placeholder="全部有效年份" /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="all">全部有效年份</SelectItem><SelectItem v-for="yearOption in yearOptions(options.validYears, validYear)" :key="yearOption" :value="String(yearOption)">{{ yearOption }} 年</SelectItem></SelectGroup></SelectContent>
      </Select>
      <Select v-if="options.maintenanceYears.length || maintenanceYear" v-model="maintenanceYearModel">
        <SelectTrigger size="sm" class="bg-card w-36 shadow-none" aria-label="按维护年份筛选"><SelectValue placeholder="全部维护年份" /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="all">全部维护年份</SelectItem><SelectItem v-for="yearOption in yearOptions(options.maintenanceYears, maintenanceYear)" :key="yearOption" :value="String(yearOption)">{{ yearOption }} 年</SelectItem></SelectGroup></SelectContent>
      </Select>
      <Select v-if="maintenanceYear && batchOptions.length" v-model="maintenanceBatchModel">
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
        <div class="flex flex-col gap-1"><Label for="recognition-from">认定时间起</Label><DatePicker id="recognition-from" v-model="dateFrom" label="认定时间起" /></div>
        <div class="flex flex-col gap-1"><Label for="recognition-to">认定时间止</Label><DatePicker id="recognition-to" v-model="dateTo" label="认定时间止" /></div>
        <Button variant="outline" size="sm" :disabled="!canApplyDate" @click="applyDate">应用时间</Button>
        <Button v-if="recognitionFrom || recognitionTo" variant="ghost" size="sm" @click="clearDate">清除时间</Button>
        <span v-if="dateError" class="text-destructive text-sm" role="alert">{{ dateError }}</span>
      </div>
    </DefineDates>

    <DataTableCard filter-scroll toolbar-label="名单查询条件">
      <template #toolbar>
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <Tabs v-model="titleModel" class="min-w-0">
            <TabsList class="h-auto max-w-full flex-wrap">
              <TabsTrigger v-for="code in CURRENT_TITLES" :key="code" :value="code" class="h-auto min-h-8">{{ TITLES[code] }}</TabsTrigger>
            </TabsList>
          </Tabs>
          <RosterCurrentRosterExportEntry :title-code="title" class="ml-auto justify-end" />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative w-full sm:w-72">
            <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
            <Input v-model="search" size="sm" class="bg-card pl-8 shadow-none" placeholder="名称、曾用名或信用代码" aria-label="搜索企业名称、已确认曾用名或统一社会信用代码" />
          </div>
          <Select v-model="statusModel">
            <SelectTrigger size="sm" class="bg-card w-36 shadow-none" aria-label="按有效状态筛选"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem v-for="(label, code) in CURRENT_STATUS_LABELS" :key="code" :value="code">{{ code === 'effective' ? '有效' : label }}</SelectItem></SelectGroup></SelectContent>
          </Select>
          <ReuseFilters v-if="!isNarrow" />
        </div>
        <ReuseDates v-if="!isNarrow" />
        <DisclosurePanel v-else v-model:open="advancedOpen" compact :heading-level="2" :title="`高级筛选与排序（已选 ${advancedFilterCount} 项）`">
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2"><ReuseFilters /></div>
            <ReuseDates />
          </div>
        </DisclosurePanel>
        <ActiveFilterBar aria-label="已选筛选条件" :items="filterItems" @remove="removeFilter" @clear="clearFilters" />
      </template>

      <p v-if="displayed?.uncertainTotal && displayed.request.params.recognitionFrom" class="text-muted-foreground border-b px-3 py-2 text-sm sm:px-4">另有 {{ displayed.uncertainTotal }} 家仅有年份精度，与所选时间部分重叠或缺少日期事实，未计入确定结果。</p>
      <TableLoadingStatus kind="ledger" :loading="isLoading" label="正在查询企业资格…" />
      <TableFailureState v-if="error" class="[overflow-wrap:anywhere]" title="企业资格查询失败" :compact="Boolean(displayed)" :pending="isLoading" :description="failureDescription" @retry="refetch()" />
      <div v-if="!error || displayed" class="data-table-scroll hidden sm:block">
        <Table class="data-table min-w-[850px] table-fixed" aria-label="企业资格查询结果">
          <TableHeader><TableRow class="hover:bg-transparent">
            <TableHead class="w-[26%]">企业名称</TableHead><TableHead class="w-[20%]">统一社会信用代码</TableHead><TableHead class="w-[12%]">区县</TableHead><TableHead class="w-[36%]">认定与复核</TableHead><TableHead class="w-[6%] text-right"><span class="sr-only">详情与出处</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            <TableRow v-for="row in rows" :key="row.enterpriseId">
              <TableCell class="align-top whitespace-normal break-words [overflow-wrap:anywhere]"><NuxtLink :to="detailUrl(row.enterpriseId)" class="hover:text-primary font-medium hover:underline">{{ row.name }}</NuxtLink><span v-if="row.aliases.length" class="text-muted-foreground mt-1 block text-xs">已确认曾用名：{{ row.aliases.join('、') }}</span></TableCell>
              <TableCell class="align-top break-all font-mono text-xs">{{ row.uscc ?? '未记录' }}</TableCell>
              <TableCell class="align-top">{{ row.district ?? '未记录' }}</TableCell>
              <TableCell class="align-top"><RosterCurrentQualificationTimeline :source="timelineAssessment(row)?.effectiveQualification?.source" :events="timelineAssessment(row)?.evidence" :inherited-from="selectedAssessment(row)?.effectiveQualification?.supportingTitle" :enterprise-id="row.enterpriseId" /></TableCell>
              <TableCell class="align-top text-right"><Button as-child variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-foreground size-7"><NuxtLink :to="detailUrl(row.enterpriseId)" :aria-label="`查看 ${row.name} 详情与出处`" title="查看详情与出处"><ChevronRight class="size-4" aria-hidden="true" /><span class="sr-only">查看详情与出处</span></NuxtLink></Button></TableCell>
            </TableRow>
            <TableRow v-if="isLoading && !displayed" aria-hidden="true"><TableCell v-for="n in 5" :key="n"><Skeleton class="h-3 w-full" /></TableCell></TableRow>
            <TableRow v-if="displayed && !rows.length"><TableCell colspan="5" class="p-0"><Empty class="border-0"><EmptyHeader><EmptyTitle>没有符合条件的企业</EmptyTitle></EmptyHeader></Empty></TableCell></TableRow>
          </TableBody>
        </Table>
      </div>
      <div v-if="isLoading && !displayed" class="flex flex-col gap-3 p-3 pt-8 sm:hidden" data-testid="current-mobile-loading" aria-hidden="true">
        <Skeleton class="h-5 w-2/3" />
        <Skeleton class="h-3 w-1/2" />
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-3/4" />
      </div>
      <ul v-if="rows.length" class="data-table-scroll flex flex-col divide-y sm:hidden" aria-label="企业资格查询结果">
        <li v-for="row in rows" :key="row.enterpriseId" class="flex min-w-0 flex-col gap-1.5 p-3" data-testid="current-enterprise-card">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0"><p class="font-medium break-words">{{ row.name }}</p><p class="text-muted-foreground break-all font-mono text-xs">{{ row.uscc ?? '信用代码未记录' }}</p></div>
            <Button as-child variant="outline" size="sm" class="min-h-11 shrink-0"><NuxtLink :to="detailUrl(row.enterpriseId)" :aria-label="`查看 ${row.name} 详情与出处`">详情与出处</NuxtLink></Button>
          </div>
          <p v-if="row.aliases.length" class="text-muted-foreground break-words text-sm leading-5">已确认曾用名：{{ row.aliases.join('、') }}</p>
          <RosterCurrentQualificationTimeline :source="timelineAssessment(row)?.effectiveQualification?.source" :events="timelineAssessment(row)?.evidence" :inherited-from="selectedAssessment(row)?.effectiveQualification?.supportingTitle" :enterprise-id="row.enterpriseId" />
        </li>
      </ul>
      <Empty v-if="displayed && !rows.length" class="sm:hidden border-0"><EmptyHeader><EmptyTitle>没有符合条件的企业</EmptyTitle></EmptyHeader></Empty>

      <template #footer>
        <TablePagination in-card v-if="displayed" :page="displayed.request.page" :page-size="displayed.request.pageSize" :total="displayed.total" :loading="paginationDisabled" unit="家" @update:page="updatePagination({ page: $event === 1 ? undefined : String($event) })" @update:page-size="updatePagination({ pageSize: String($event), page: undefined })" />
      </template>
    </DataTableCard>
    <p v-if="displayed && displayed.responseVersion !== 'current-qualified-478-v2'" class="text-muted-foreground text-sm" role="status">旧版响应未提供五类有效状态；请刷新后核对，不能据此将资料缺口认作待核。</p>
  </WorkspacePage>
</template>
