<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { ArrowDown, ArrowDownUp, ArrowUp, Search } from '@lucide/vue'
import EnterpriseLibraryFiltersPanel from '#core/app/components/enterprise-library/EnterpriseLibraryFilters.vue'
import { computed, ref, shallowRef, watch } from 'vue'
import EnterpriseSourceSheet from '#core/app/components/enterprise-library/EnterpriseSourceSheet.vue'
import ActiveFilterBar from '#core/app/components/ActiveFilterBar.vue'
import DataTableCard from '#core/app/components/DataTableCard.vue'
import FilterChip from '#core/app/components/FilterChip.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'
import TablePagination from '#core/app/components/TablePagination.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import { Button } from '#core/app/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '#core/app/components/ui/empty'
import { Input } from '#core/app/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#core/app/components/ui/table'
import { captureQueryRequest, useRetainedQuerySnapshot } from '#core/app/composables/useRetainedQuerySnapshot'
import { normalizeReviewedUscc } from '#core/lib/enterprise-uscc'
import type { DictionaryEntry } from '#core/lib/dictionaries'
import {
  enterpriseLibraryColumnLabels, enterpriseLibrarySortFields,
  type EnterpriseLibraryDetails, type EnterpriseLibraryFilters, type EnterpriseLibraryResult,
  type EnterpriseLibraryRow, type EnterpriseLibrarySort, type EnterpriseLibrarySortField,
} from '#core/lib/core/enterprise-library'

useHead({ title: '企业基础库' })

const apiGet = $fetch as unknown as <T>(path: string, options?: { query: Record<string, unknown> }) => Promise<T>
const endpoint = '/api/core/enterprises'
const draft = ref('')
const filters = ref<EnterpriseLibraryFilters>({})
const sorts = ref<EnterpriseLibrarySort[]>([])
const pageSize = ref(25)
const page = ref(1)
const scroller = useTemplateRef('enterprise-table')
const selected = shallowRef<EnterpriseLibraryRow | null>(null)
let sourceTrigger: HTMLElement | null = null

const { data: regions, error: regionsError, refetch: retryRegions } = useQuery({
  key: ['enterprise-library', 'districts'],
  query: () => apiGet<DictionaryEntry[]>('/api/core/dictionaries/regions'),
})
const { data: industries, error: industriesError, refetch: retryIndustries } = useQuery({
  key: ['enterprise-library', 'industries'],
  query: () => apiGet<DictionaryEntry[]>('/api/core/dictionaries/industries'),
})
const params = computed(() => ({
  ...Object.fromEntries(Object.entries(filters.value).filter(([, value]) => value !== undefined)) as EnterpriseLibraryFilters,
  sorts: sorts.value,
  page: page.value,
  pageSize: pageSize.value,
}))
type Params = typeof params.value
const active = computed(() => captureQueryRequest(endpoint, params.value))
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['enterprise-library', 'results', params.value],
  query: async ({ entry }) => {
    const request = captureQueryRequest(endpoint, entry.key[2] as Params)
    const { pageSize: limit, sorts, ...filters } = request.params
    const order = sorts.length ? { sort: sorts.map(rule => rule.field), direction: sorts.map(rule => rule.direction) } : {}
    const result = await apiGet<EnterpriseLibraryResult>(endpoint, { query: { ...filters, ...order, limit } })
    return { ...result, request }
  },
  placeholderData: previous => previous,
})
const { displayed, hasCurrentSnapshot, isShowingPrevious, paginationDisabled } = useRetainedQuerySnapshot(data, isLoading, error, active)
const rows = computed(() => displayed.value?.rows ?? [])
const regionLabels = computed(() => new Map((regions.value ?? []).map(item => [item.code, item.name])))
const industryLabels = computed(() => new Map((industries.value ?? []).map(item => [item.code, item.name])))
const filterLabels = {
  name: enterpriseLibraryColumnLabels.name,
  uscc: '信用代码',
  districtCode: '区划',
  industryDivisionCode: '行业',
  registeredAddress: enterpriseLibraryColumnLabels.registeredAddress,
  operatingAddress: enterpriseLibraryColumnLabels.operatingAddress,
} satisfies Partial<Record<keyof EnterpriseLibraryFilters, string>>
const filterChips = computed(() => (Object.keys(filterLabels) as (keyof typeof filterLabels)[]).flatMap(key => {
  const selection = key === 'districtCode'
    ? [filters.value.districtCode, filters.value.townshipCode].map(code => code && (regionLabels.value.get(code) ?? code))
    : key === 'industryDivisionCode'
      ? [filters.value.industryDivisionCode, filters.value.industryCode].map(code => code && (industryLabels.value.get(code) ?? code))
      : [filters.value[key]]
  const value = selection.filter(Boolean).join(' / ')
  return value ? [{ key, label: `${filterLabels[key]}：${value}` }] : []
}))
const columnWidths = {
  name: 'w-48', uscc: 'w-40', district: 'w-20', township: 'w-28',
  industry: 'w-32', registeredAddress: 'w-34', operatingAddress: 'w-34',
} satisfies Record<EnterpriseLibrarySortField, string>
const displayedSorts = computed<readonly EnterpriseLibrarySort[]>(() => displayed.value?.request.params.sorts ?? [])
const primarySort = computed(() => displayedSorts.value[0])
const directionsByField = computed(() => new Map(displayedSorts.value.map(({ field, direction }) => [field, direction])))
const sortLabel = (rule: EnterpriseLibrarySort) =>
  `${enterpriseLibraryColumnLabels[rule.field]}${rule.direction === 'asc' ? '升序' : '降序'}`
const resultLabel = computed(() => {
  if (!hasCurrentSnapshot.value || !displayed.value) return ''
  const order = displayedSorts.value.map(sortLabel).join('，然后按')
  return `${order ? '按' + order + '，' : ''}共 ${displayed.value.total} 家企业`
})

watch(() => displayed.value?.request.key, () => { scroller.value?.scrollTo({ top: 0 }) }, { flush: 'post' })

/**
 * 在企业库按企业名称或完整的统一社会信用代码查询，并在当前页面显示结果。
 * @tool readonly
 */
function applySearch() {
  const text = draft.value.trim()
  const code = normalizeReviewedUscc(text)
  const isCreditCode = /^[A-Z0-9]{18}$/.test(code)
  filters.value = { ...filters.value, name: isCreditCode ? undefined : text || undefined, uscc: isCreditCode ? code : undefined }
  page.value = 1
}

function removeFilter(key: keyof EnterpriseLibraryFilters) {
  const next = { ...filters.value, [key]: undefined }
  if (key === 'districtCode') next.townshipCode = undefined
  if (key === 'industryDivisionCode') next.industryCode = undefined
  applyFilters(next, sorts.value)
}

function applyFilters(next: EnterpriseLibraryFilters, nextSorts: EnterpriseLibrarySort[]) {
  filters.value = next
  sorts.value = nextSorts
  draft.value = next.name ?? next.uscc ?? ''
  page.value = 1
}

function reset() {
  applyFilters({}, sorts.value)
}

function sortColumn(field: EnterpriseLibrarySortField) {
  const current = sorts.value.find(rule => rule.field === field)
  sorts.value = current
    ? sorts.value.map(rule => rule.field === field ? { ...rule, direction: rule.direction === 'asc' ? 'desc' : 'asc' } : rule)
    : [...sorts.value, { field, direction: 'asc' }]
  page.value = 1
}

function removeSort(field: EnterpriseLibrarySortField) {
  sorts.value = sorts.value.filter(rule => rule.field !== field)
  page.value = 1
}

function clearSort() {
  sorts.value = []
  page.value = 1
}

function resize(size: number) {
  pageSize.value = size
  page.value = 1
}
function openSource(row: EnterpriseLibraryRow, event: MouseEvent) {
  sourceTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  selected.value = row
}
function updateDetails(details: EnterpriseLibraryDetails) {
  if (selected.value?.id === details.id) selected.value = details
  void refetch()
}

function restoreSourceFocus() {
  if (sourceTrigger?.isConnected) sourceTrigger.focus()
  else document.getElementById('enterprise-library-search')?.focus()
  sourceTrigger = null
}
</script>

<template>
  <WorkspacePage title="企业基础库">
    <DataTableCard
      toolbar-label="企业列表筛选与操作"
      toolbar-class="@container/enterprise-filters flex flex-col gap-3"
      :body-busy="isLoading"
    >
      <template #toolbar>
        <EnterpriseLibraryFiltersPanel
          :filters="filters" :sorts="sorts" :regions="regions" :industries="industries"
          :regions-error="Boolean(regionsError)" :industries-error="Boolean(industriesError)"
          @apply="applyFilters" @retry-regions="retryRegions()" @retry-industries="retryIndustries()"
        >
          <template #quick-search>
            <form aria-label="快速查询企业" class="flex min-w-0 flex-1 grow basis-60 items-center gap-2 @min-[36rem]/enterprise-filters:max-w-96" @submit.prevent="applySearch">
              <Input id="enterprise-library-search" v-model="draft" size="sm" maxlength="500" class="min-w-0" aria-label="企业名称或统一社会信用代码" placeholder="企业名称或完整信用代码" />
              <Button type="submit" size="sm"><Search class="size-4" aria-hidden="true" />查询</Button>
            </form>
          </template>
        </EnterpriseLibraryFiltersPanel>
        <ActiveFilterBar :items="filterChips" :show-clear-min="2" @remove="key => removeFilter(key as keyof EnterpriseLibraryFilters)" @clear="reset" />
        <div v-if="sorts.length" role="group" aria-label="已应用的排序" class="flex min-w-0 flex-wrap items-center gap-2">
          <FilterChip v-for="(rule, index) in sorts" :key="rule.field" :label="`${index + 1}. ${sortLabel(rule)}`"
            :remove-label="`移除排序：${sortLabel(rule)}`" @remove="removeSort(rule.field)" />
          <Button v-if="sorts.length > 1" type="button" size="sm" variant="ghost" @click="clearSort">清除排序</Button>
        </div>
      </template>

      <template #status>
        <TableLoadingStatus kind="ledger" :loading="isLoading" :label="isShowingPrevious ? '正在更新企业列表…' : '正在加载企业…'" />
      </template>

      <p role="status" class="sr-only">{{ resultLabel }}</p>
      <TableFailureState
        v-if="error" title="企业列表暂时无法加载"
        :compact="Boolean(rows.length)" :pending="isLoading" :description="rows.length ? '已保留上次查询结果。' : undefined" @retry="refetch()"
      />
      <div
        v-if="rows.length" ref="enterprise-table" role="region" aria-label="企业列表" tabindex="0"
        class="data-table-scroll @container focus-visible:outline-ring focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <Table class="data-table min-w-[66rem] table-fixed">
          <caption class="sr-only">企业基础库列表</caption>
          <TableHeader>
            <TableRow>
              <TableHead
                v-for="field in enterpriseLibrarySortFields" :key="field"
                scope="col" class="px-0!" :class="columnWidths[field]"
                :aria-sort="primarySort?.field === field ? primarySort.direction === 'desc' ? 'descending' : 'ascending' : undefined"
              >
                <Button type="button" variant="ghost" class="h-9 w-full justify-start gap-1 rounded-none px-3 text-table"
                  @click="sortColumn(field)">
                  {{ enterpriseLibraryColumnLabels[field] }}
                  <component
                    :is="directionsByField.has(field) ? directionsByField.get(field) === 'desc' ? ArrowDown : ArrowUp : ArrowDownUp"
                    aria-hidden="true" class="size-3.5 shrink-0" :class="!directionsByField.has(field) && 'text-muted-foreground'"
                  />
                </Button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="row in rows" :key="row.id">
              <th scope="row" class="px-3 py-2.5 text-left align-middle font-medium whitespace-normal">
                <button
                  type="button"
                  class="hover:text-primary cursor-pointer text-left font-medium wrap-anywhere hover:underline focus-visible:underline focus-visible:outline-none"
                  :aria-label="`查看资料：${row.name}`"
                  @click="openSource(row, $event)"
                >
                  {{ row.name }}
                </button>
                <span v-if="row.uscc || row.districtName" class="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 text-table font-normal @min-[48rem]:hidden">
                  <span v-if="row.uscc" class="tabular-nums">{{ row.uscc }}</span>
                  <span v-if="row.districtName">{{ row.districtName }}</span>
                </span>
              </th>
              <TableCell class="tabular-nums">{{ row.uscc ?? '—' }}</TableCell>
              <TableCell class="whitespace-normal">{{ row.districtName ?? '—' }}</TableCell>
              <TableCell class="whitespace-normal">{{ row.townshipName ?? '—' }}</TableCell>
              <TableCell class="whitespace-normal">{{ row.industryName ?? '—' }}</TableCell>
              <TableCell class="wrap-anywhere whitespace-pre-line">{{ row.registeredAddress ?? '—' }}</TableCell>
              <TableCell class="wrap-anywhere whitespace-pre-line">{{ row.operatingAddress ?? '—' }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <Empty v-else-if="hasCurrentSnapshot && !isLoading && !error" class="min-h-44 gap-4 border-0">
        <EmptyHeader><EmptyTitle>{{ filterChips.length ? '未找到符合条件的企业' : '基础库暂无企业' }}</EmptyTitle></EmptyHeader>
        <EmptyContent v-if="filterChips.length">
          <Button variant="outline" @click="reset">清除筛选</Button>
        </EmptyContent>
      </Empty>
      <div v-else-if="isLoading && !error" class="h-36" />

      <template #footer>
        <TablePagination
          v-if="displayed && displayed.total > 0" in-card
          :page="displayed.page" :page-size="displayed.request.pageSize" :total="displayed.total"
          :loading="paginationDisabled" :max-page-size="100" unit="家"
          @update:page="page = $event" @update:page-size="resize"
        />
      </template>
    </DataTableCard>
    <EnterpriseSourceSheet :enterprise="selected" :regions="regions" @saved="updateDetails" @close="selected = null" @restore-focus="restoreSourceFocus" />
  </WorkspacePage>
</template>
