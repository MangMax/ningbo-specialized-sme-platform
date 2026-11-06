<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Search } from '@lucide/vue'
import { PLATFORM_RDJBS, RELATION_DECLARE_KINDS } from '~~/lib/labels'
import { watchDebounced } from '@vueuse/core'
import type { BusinessProcessListResult } from '~~/lib/platform/business-processes'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import PageHeader from '@/components/PageHeader.vue'
import PlatformFilterSelect from '@/components/PlatformFilterSelect.vue'
import { usePlatformFilterOptions } from '@/composables/usePlatformFilterOptions'
import FilterChip from '@/components/FilterChip.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import TablePagination from '@/components/TablePagination.vue'
import PlatformBusinessProcessTable from '@/components/PlatformBusinessProcessTable.vue'
import PlatformBusinessProcessDetailDialog from '@/components/PlatformBusinessProcessDetailDialog.vue'

useHead({ title: '关联办理 · 专精特新' })

const initialQuery = (() => {
  try { return useRoute().query } catch { return {} }
})()

const view = ref<'records' | 'isolated'>('records')
const { options: filterOptions, loading: optionsLoading, error: optionsError, reload: reloadOptions } = usePlatformFilterOptions('business-processes', view)
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

const hasFilters = computed(() => [titleRaw.value, enterpriseQuery.value, declareKind.value, yearInput.value, status.value, batch.value, platformKey.value].some(value => value.trim() !== ''))

function loadIfChanged() {
  if (!disposed && JSON.stringify(requestParams()) !== lastRequestKey) void load()
}
function clearFilters() {
  for (const field of [titleRaw, enterpriseQuery, declareKind, yearInput, status, batch, platformKey]) field.value = ''
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
const emptyTitle = computed(() => view.value === 'records' ? '没有匹配的关联办理记录' : '没有隔离的办理观察')
const emptyDescription = computed(() => view.value === 'records'
  ? '未找到符合筛选条件的关联办理记录。'
  : '缺编号、编号冲突或原文无法核实的办理观察会在此逐条保留，不并入任何业务记录。')
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2 sm:gap-3" :aria-busy="loading">
    <PageHeader title="关联办理" description="查询企业关联办理记录。" />

    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative w-full min-w-52 flex-1 sm:max-w-[13rem]">
          <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
          <Input v-model="enterpriseQuery" class="bg-card h-8 pl-8" placeholder="搜索企业名称或信用代码" aria-label="企业名称或信用代码" />
        </div>
        <PlatformFilterSelect v-model="titleRaw" :options="filterOptions.titles" label="称号" placeholder="全部称号" :disabled="optionsLoading || optionsError" :format-label="titleLabel" class="w-full sm:w-48" />
        <PlatformFilterSelect v-model="declareKind" :options="filterOptions.declareKinds" label="事项" placeholder="全部事项" :disabled="optionsLoading || optionsError" :format-label="declareKindLabel" class="w-full sm:w-28" />
        <PlatformFilterSelect v-model="yearInput" :options="filterOptions.years" label="业务年" placeholder="全部业务年" :disabled="optionsLoading || optionsError" class="w-full sm:w-32" />
        <PlatformFilterSelect v-model="status" :options="filterOptions.statuses" label="办理状态" placeholder="全部状态" :disabled="optionsLoading || optionsError" class="w-full sm:w-32" />
        <PlatformFilterSelect v-model="batch" :options="filterOptions.batches" label="维护批次" placeholder="全部批次" :disabled="optionsLoading || optionsError" class="w-full sm:w-32" />
        <Select :model-value="view" @update:model-value="view = $event as 'records' | 'isolated'">
          <SelectTrigger size="sm" class="bg-card w-full sm:w-28" aria-label="关联办理视图"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="records">业务记录</SelectItem>
            <SelectItem value="isolated">缺编号观察</SelectItem>
          </SelectContent>
        </Select>
        <FilterChip v-if="platformKey" label="已定位记录" @remove="platformKey = ''" />
        <Button v-if="hasFilters" variant="ghost" size="sm" @click="clearFilters">清除筛选</Button>
        <span class="text-muted-foreground text-[13px] tabular-nums" aria-live="polite">共 {{ total.toLocaleString('zh-CN') }} {{ view === 'records' ? '条记录' : '条观察' }}</span>
      </div>
    </div>

    <p v-if="optionsError" role="alert" class="text-destructive flex items-center gap-2 text-sm">筛选选项加载失败<Button variant="ghost" size="sm" :disabled="optionsLoading" @click="reloadOptions">重试</Button></p>

    <Card class="gap-0 overflow-hidden py-0 shadow-none">
      <CardContent class="relative p-0">
        <TableLoadingStatus kind="ledger" :loading="loading" label="正在加载关联办理…" />
        <TableFailureState v-if="error" :compact="rows.length > 0" :title="`关联办理第 ${page} 页加载失败`" :description="`${error}${data ? `；保留第 ${data.page} 页结果。` : ''}`" :pending="loading" @retry="load" />
        <div v-if="loading && !rows.length" class="flex flex-col gap-3 p-3 pt-8" aria-hidden="true">
          <Skeleton class="h-5 w-2/3" />
          <Skeleton class="h-4 w-full" />
          <Skeleton class="h-4 w-3/4" />
        </div>
        <Empty v-else-if="!error && !rows.length" class="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Search /></EmptyMedia>
            <EmptyTitle>{{ emptyTitle }}</EmptyTitle>
            <EmptyDescription>{{ emptyDescription }}</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <PlatformBusinessProcessTable v-if="rows.length" :view="view" :rows="rows" :loading="loading" @open-record="openRecord" />
      </CardContent>
    </Card>

    <TablePagination v-if="rows.length" :page="data?.page ?? page" :page-size="data?.pageSize ?? pageSize" :total="total" :loading="loading" :unit="view === 'records' ? '条记录' : '条观察'" @update:page="page = $event" @update:page-size="changeSize" />

    <PlatformBusinessProcessDetailDialog v-model:open="detailOpen" :record-id="selectedRecordId" />
  </div>
</template>
