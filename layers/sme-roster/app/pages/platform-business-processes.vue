<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Search } from '@lucide/vue'
import { PLATFORM_RDJBS, RELATION_DECLARE_KINDS } from '#sme-roster/lib/labels'
import { watchDebounced } from '@vueuse/core'
import type { BusinessProcessListResult } from '#sme-roster/lib/platform/business-processes'
import { Button } from '#core/app/components/ui/button'
import { Input } from '#core/app/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Skeleton } from '#core/app/components/ui/skeleton'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import ActiveFilterBar from '#core/app/components/ActiveFilterBar.vue'
import DataTableCard from '#core/app/components/DataTableCard.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import RosterPlatformFilterSelect from '#sme-roster/app/components/PlatformFilterSelect.vue'
import { useRosterPlatformFilterOptions } from '#sme-roster/app/composables/useRosterPlatformFilterOptions'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'
import TablePagination from '#core/app/components/TablePagination.vue'
import RosterPlatformBusinessProcessTable from '#sme-roster/app/components/PlatformBusinessProcessTable.vue'
import RosterPlatformBusinessProcessDetailDialog from '#sme-roster/app/components/PlatformBusinessProcessDetailDialog.vue'

useHead({ title: '关联办理 · 专精特新' })

const initialQuery = (() => {
  try { return useRoute().query } catch { return {} }
})()

const view = ref<'records' | 'isolated'>('records')
const { options: filterOptions, loading: optionsLoading, error: optionsError, reload: reloadOptions } = useRosterPlatformFilterOptions('business-processes', view)
const declareKindLabel = (value: string) => RELATION_DECLARE_KINDS[value] ?? value
const titleRaw = ref('')
const titleLabel = (value: string) => PLATFORM_RDJBS[value] ?? value
const enterpriseQuery = ref(typeof initialQuery.q === 'string' ? initialQuery.q : '')
const platformKey = ref(typeof initialQuery.platformKey === 'string' ? initialQuery.platformKey : '')
const declareKind = ref('')
const yearInput = ref('')
const status = ref('')
const batch = ref('')
const page = ref(1)
const pageSize = ref(25)
const data = shallowRef<BusinessProcessListResult>()
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
    ...(declareKind.value.trim() ? { declareKind: declareKind.value.trim() } : {}),
    ...(yearInput.value ? { year: Number(yearInput.value) } : {}),
    ...(status.value.trim() ? { status: status.value.trim() } : {}),
    ...(batch.value.trim() ? { batch: batch.value.trim() } : {}),
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
    const result = await $fetch<BusinessProcessListResult>('/api/platform/business-processes', { query, signal: controller.signal, retry: 0 })
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
  { key: 'declareKind', field: declareKind, label: (value: string) => `事项：${declareKindLabel(value)}` },
  { key: 'year', field: yearInput, label: (value: string) => `业务年：${value}` },
  { key: 'status', field: status, label: (value: string) => `办理状态：${value}` },
  { key: 'batch', field: batch, label: (value: string) => `维护批次：${value}` },
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
watch([titleRaw, view, platformKey, declareKind, yearInput, status, batch], search)
onBeforeUnmount(() => { disposed = true; ++generation; controller?.abort() })
void load()

const total = computed(() => data.value?.total ?? 0)
const rows = computed(() => data.value?.rows ?? [])
const resultView = computed(() => data.value?.view ?? 'records')
const resultUnit = computed(() => resultView.value === 'records' ? '条记录' : '条观察')
const emptyTitle = computed(() => resultView.value === 'records' ? '没有匹配的关联办理记录' : '没有隔离的办理观察')
const isolatedDescription = '缺编号、编号冲突或原文无法核实的办理观察会在此逐条保留，不并入任何业务记录。'
</script>

<template>
  <WorkspacePage title="关联办理" :busy="loading">
    <DataTableCard toolbar-label="关联办理筛选与操作" :body-busy="loading">
      <template #toolbar>
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative w-full min-w-0 sm:w-52">
            <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
            <Input v-model="enterpriseQuery" size="sm" class="bg-card pl-8 pointer-coarse:min-h-11" placeholder="搜索企业名称或信用代码" aria-label="企业名称或信用代码" />
          </div>
          <Select :model-value="view" @update:model-value="view = $event as 'records' | 'isolated'">
            <SelectTrigger size="sm" class="bg-card w-32 pointer-coarse:min-h-11" aria-label="关联办理视图"><SelectValue>{{ view === 'records' ? '业务记录' : '隔离观察' }}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="records">业务记录</SelectItem>
              <SelectItem value="isolated">隔离观察</SelectItem>
            </SelectContent>
          </Select>
          <div class="grid w-full grid-cols-2 gap-2 empty:hidden sm:contents">
            <RosterPlatformFilterSelect v-if="filterOptions.titles.length || titleRaw" v-model="titleRaw" :options="filterOptions.titles" label="称号" placeholder="全部称号" :disabled="optionsLoading || optionsError" :format-label="titleLabel" class="w-full pointer-coarse:min-h-11 sm:w-48" />
            <RosterPlatformFilterSelect v-if="filterOptions.declareKinds.length || declareKind" v-model="declareKind" :options="filterOptions.declareKinds" label="事项" placeholder="全部事项" :disabled="optionsLoading || optionsError" :format-label="declareKindLabel" class="w-full pointer-coarse:min-h-11 sm:w-28" />
            <RosterPlatformFilterSelect v-if="filterOptions.years.length || yearInput" v-model="yearInput" :options="filterOptions.years" label="业务年" placeholder="全部业务年" :disabled="optionsLoading || optionsError" class="w-full pointer-coarse:min-h-11 sm:w-32" />
            <RosterPlatformFilterSelect v-if="filterOptions.statuses.length || status" v-model="status" :options="filterOptions.statuses" label="办理状态" placeholder="全部状态" :disabled="optionsLoading || optionsError" class="w-full pointer-coarse:min-h-11 sm:w-32" />
            <RosterPlatformFilterSelect v-if="filterOptions.batches.length || batch" v-model="batch" :options="filterOptions.batches" label="维护批次" placeholder="全部批次" :disabled="optionsLoading || optionsError" class="w-full pointer-coarse:min-h-11 sm:w-32" />
          </div>
          <span v-if="data && !rows.length" class="text-muted-foreground text-table tabular-nums" aria-live="polite">共 {{ total.toLocaleString('zh-CN') }} {{ resultUnit }}</span>
        </div>
        <ActiveFilterBar :items="activeFilters" @remove="removeFilter" @clear="clearFilters" />
        <p v-if="optionsError" role="alert" class="text-destructive flex items-center gap-2 text-sm">筛选选项加载失败<Button variant="ghost" size="sm" :disabled="optionsLoading" @click="reloadOptions">重试</Button></p>
      </template>

      <TableLoadingStatus kind="ledger" :loading="loading" label="正在加载关联办理…" />
      <TableFailureState v-if="error" :compact="Boolean(data)" :title="`关联办理第 ${page} 页加载失败`" :description="`${error}${data ? `；保留第 ${data.page} 页结果（${resultView === 'records' ? '记录' : '隔离观察'}）。` : ''}`" :pending="loading" @retry="load" />
      <div v-if="loading && !data" class="flex flex-col gap-3 p-3 pt-8" aria-hidden="true">
        <Skeleton class="h-5 w-2/3" />
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-3/4" />
      </div>
      <Empty v-else-if="data && !rows.length" class="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Search aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>{{ emptyTitle }}</EmptyTitle>
          <EmptyDescription v-if="resultView === 'isolated'">{{ isolatedDescription }}</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <RosterPlatformBusinessProcessTable class="flex min-h-0 flex-col" v-if="rows.length" :view="resultView" :rows="rows" :loading="loading" @open-record="openRecord" />

      <template #footer>
        <TablePagination in-card v-if="rows.length" :page="data?.page ?? page" :page-size="data?.pageSize ?? pageSize" :total="total" :loading="loading || resultView !== view" :unit="resultUnit" @update:page="page = $event" @update:page-size="changeSize" />
      </template>
    </DataTableCard>

    <RosterPlatformBusinessProcessDetailDialog v-model:open="detailOpen" :record-id="selectedRecordId" />
  </WorkspacePage>
</template>
