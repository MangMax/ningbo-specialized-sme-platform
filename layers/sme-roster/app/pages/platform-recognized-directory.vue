<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Search } from '@lucide/vue'
import { PLATFORM_RDJBS } from '#sme-roster/lib/labels'
import { watchDebounced } from '@vueuse/core'
import type { RecognizedDirectoryListResult } from '#sme-roster/lib/platform/recognized-directory'
import { Button } from '#core/app/components/ui/button'
import { Input } from '#core/app/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Skeleton } from '#core/app/components/ui/skeleton'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import ActiveFilterBar from '#core/app/components/ActiveFilterBar.vue'
import DataTableCard from '#core/app/components/DataTableCard.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import RosterPlatformFilterSelect from '#sme-roster/app/components/PlatformFilterSelect.vue'
import { useRosterPlatformFilterOptions } from '#sme-roster/app/composables/useRosterPlatformFilterOptions'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'
import TablePagination from '#core/app/components/TablePagination.vue'
import RosterPlatformRecognizedDirectoryTable from '#sme-roster/app/components/PlatformRecognizedDirectoryTable.vue'
import RosterPlatformRecognizedDirectoryDetailDialog from '#sme-roster/app/components/PlatformRecognizedDirectoryDetailDialog.vue'

useHead({ title: '平台认定目录 · 专精特新' })

const initialQuery = (() => {
  try { return useRoute().query } catch { return {} }
})()

const view = ref<'records' | 'isolated'>('records')
const { options: filterOptions, loading: optionsLoading, error: optionsError, reload: reloadOptions } = useRosterPlatformFilterOptions('recognized-directory', view)
const titleRaw = ref('')
const titleLabel = (value: string) => PLATFORM_RDJBS[value] ?? value
const enterpriseQuery = ref(typeof initialQuery.q === 'string' ? initialQuery.q : '')
const platformKey = ref(typeof initialQuery.platformKey === 'string' ? initialQuery.platformKey : '')
const validityDateInput = ref('')
const maintenanceBatch = ref('')
const district = ref('')
const page = ref(1)
const pageSize = ref(25)
const data = shallowRef<RecognizedDirectoryListResult>()
const loading = ref(false)
const error = ref('')
const selectedRecordId = ref<number | null>(null)
const detailOpen = ref(false)
let generation = 0
let lastRequestKey = ''
let disposed = false
let controller: AbortController | undefined


function requestParams() {
  return {
    view: view.value,
    ...(titleRaw.value ? { titleRaw: titleRaw.value } : {}),
    ...(enterpriseQuery.value.trim() ? { q: enterpriseQuery.value.trim() } : {}),
    ...(platformKey.value.trim() ? { platformKey: platformKey.value.trim() } : {}),
    ...(validityDateInput.value.trim() ? { rddqrq: validityDateInput.value.trim() } : {}),
    ...(maintenanceBatch.value.trim() ? { whpc: maintenanceBatch.value.trim() } : {}),
    ...(district.value.trim() ? { szq: district.value.trim() } : {}),
    page: page.value,
    pageSize: pageSize.value,
  }
}

async function load() {
  const query = requestParams()
  lastRequestKey = JSON.stringify(query)
  const request = ++generation
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const result = await $fetch<RecognizedDirectoryListResult>('/api/platform/recognized-directory', { query, signal: controller.signal, retry: 0 })
    if (request === generation) data.value = result
  } catch (cause) {
    if (request === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (request === generation) loading.value = false
  }
}

const filters = [
  { key: 'q', field: enterpriseQuery, label: (value: string) => `企业：${value.trim()}` },
  { key: 'title', field: titleRaw, label: (value: string) => `称号：${titleLabel(value)}` },
  { key: 'validity', field: validityDateInput, label: (value: string) => `有效期：${value}` },
  { key: 'batch', field: maintenanceBatch, label: (value: string) => `维护批次：${value}` },
  { key: 'district', field: district, label: (value: string) => `属地：${value}` },
  { key: 'platformKey', field: platformKey, label: () => '已定位记录' },
]
const activeFilters = computed(() => filters
  .filter(({ field }) => field.value.trim())
  .map(({ key, field, label }) => ({ key, label: label(field.value) })))

function loadIfChanged() {
  if (!disposed && JSON.stringify(requestParams()) !== lastRequestKey) void load()
}
function removeFilter(key: string) {
  const filter = filters.find(candidate => candidate.key === key)
  if (!filter) return
  filter.field.value = ''
  search()
}
function clearFilters() {
  for (const { field } of filters) field.value = ''
  lastRequestKey = ''
  search()
}
function search() {
  if (disposed) return
  if (page.value !== 1) page.value = 1
  else loadIfChanged()
}
function changeView(next: 'records' | 'isolated') {
  if (next === 'isolated') {
    validityDateInput.value = ''
    maintenanceBatch.value = ''
    district.value = ''
  }
  view.value = next
}
function changeSize(size: number) {
  const sizeChanged = size !== pageSize.value
  const pageChanged = page.value !== 1
  pageSize.value = size
  page.value = 1
  if (!sizeChanged && !pageChanged) void load()
}
function openRecord(recordId: number) {
  selectedRecordId.value = recordId
  detailOpen.value = true
}

watch([page, pageSize], loadIfChanged)
watchDebounced(enterpriseQuery, search, { debounce: 300 })
watch([titleRaw, view, platformKey, validityDateInput, maintenanceBatch, district], search)
onBeforeUnmount(() => { disposed = true; ++generation; controller?.abort() })
void load()

const total = computed(() => data.value?.total ?? 0)
const rows = computed(() => data.value?.rows ?? [])
const resultView = computed(() => data.value?.view ?? 'records')
const resultUnit = computed(() => resultView.value === 'records' ? '条记录' : '条观察')
const emptyTitle = computed(() => resultView.value === 'records' ? '没有匹配的目录记录' : '没有隔离的目录观察')
</script>

<template>
  <WorkspacePage title="平台认定目录" :busy="loading">
    <template #actions><NuxtLink to="/current-enterprises" class="text-muted-foreground inline-flex items-center gap-1 text-xs hover:underline">当前有效企业查询</NuxtLink></template>
    <DataTableCard toolbar-label="平台认定目录筛选与操作" :body-busy="loading">
      <template #toolbar>
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative w-full min-w-0 sm:w-52">
            <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
            <Input v-model="enterpriseQuery" size="sm" class="bg-card pl-8 pointer-coarse:min-h-11" placeholder="搜索企业名称或信用代码" aria-label="企业名称或信用代码" />
          </div>
          <Select :model-value="view" @update:model-value="changeView($event as 'records' | 'isolated')">
            <SelectTrigger size="sm" class="bg-card w-32 pointer-coarse:min-h-11" aria-label="目录视图"><SelectValue>{{ view === 'records' ? '目录记录' : '隔离观察' }}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="records">目录记录</SelectItem>
              <SelectItem value="isolated">隔离观察</SelectItem>
            </SelectContent>
          </Select>
          <div class="grid w-full grid-cols-2 gap-2 empty:hidden sm:contents">
            <RosterPlatformFilterSelect v-if="filterOptions.titles.length || titleRaw" v-model="titleRaw" :options="filterOptions.titles" label="称号" placeholder="全部称号" :disabled="optionsLoading || optionsError" :format-label="titleLabel" class="w-full pointer-coarse:min-h-11 sm:w-48" />
            <RosterPlatformFilterSelect v-if="filterOptions.validityDates.length || validityDateInput" v-model="validityDateInput" :options="filterOptions.validityDates" label="有效期" placeholder="全部有效期" :disabled="optionsLoading || optionsError" class="w-full pointer-coarse:min-h-11 sm:w-48" />
            <RosterPlatformFilterSelect v-if="filterOptions.batches.length || maintenanceBatch" v-model="maintenanceBatch" :options="filterOptions.batches" label="维护批次" placeholder="全部批次" :disabled="optionsLoading || optionsError" class="w-full pointer-coarse:min-h-11 sm:w-32" />
            <RosterPlatformFilterSelect v-if="filterOptions.districts.length || district" v-model="district" :options="filterOptions.districts" label="属地" placeholder="全部属地" :disabled="optionsLoading || optionsError" class="w-full pointer-coarse:min-h-11 sm:w-36" />
          </div>
          <span v-if="data && !rows.length" class="text-muted-foreground text-table tabular-nums" aria-live="polite">共 {{ total.toLocaleString('zh-CN') }} {{ resultUnit }}</span>
        </div>
        <ActiveFilterBar :items="activeFilters" @remove="removeFilter" @clear="clearFilters" />
        <p v-if="optionsError" role="alert" class="text-destructive flex items-center gap-2 text-sm">筛选选项加载失败<Button variant="ghost" size="sm" :disabled="optionsLoading" @click="reloadOptions">重试</Button></p>
      </template>

      <TableLoadingStatus kind="ledger" :loading="loading" label="正在加载平台认定目录…" />
      <TableFailureState v-if="error" :compact="Boolean(data)" :title="`平台认定目录第 ${page} 页加载失败`" :description="`${error}${data ? `；保留第 ${data.page} 页结果（${resultView === 'records' ? '记录' : '隔离观察'}）。` : ''}`" :pending="loading" @retry="load" />
      <div v-if="loading && !data" class="flex flex-col gap-3 p-3 pt-8" aria-hidden="true">
        <Skeleton class="h-5 w-2/3" />
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-3/4" />
      </div>
      <Empty v-else-if="data && !rows.length" class="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Search aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>{{ emptyTitle }}</EmptyTitle>
        </EmptyHeader>
      </Empty>
      <RosterPlatformRecognizedDirectoryTable class="flex min-h-0 flex-col" v-if="rows.length" :view="resultView" :rows="rows" :loading="loading" @open-record="openRecord" />

      <template #footer>
        <TablePagination in-card v-if="rows.length" :page="data?.page ?? page" :page-size="data?.pageSize ?? pageSize" :total="total" :loading="loading || resultView !== view" :unit="resultUnit" @update:page="page = $event" @update:page-size="changeSize" />
      </template>
    </DataTableCard>

    <RosterPlatformRecognizedDirectoryDetailDialog v-model:open="detailOpen" :record-id="selectedRecordId" />
  </WorkspacePage>
</template>
