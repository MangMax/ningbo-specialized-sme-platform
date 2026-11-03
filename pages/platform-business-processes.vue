<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Search, X } from '@lucide/vue'
import type { BusinessProcessListResult } from '~~/lib/platform/business-processes'
import { PLATFORM_RDJBS, PLATFORM_RDJB_ORDER } from '~~/lib/labels'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import PageHeader from '@/components/PageHeader.vue'
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
const enterpriseQuery = ref(typeof initialQuery.q === 'string' ? initialQuery.q : '')
const platformKey = ref(typeof initialQuery.platformKey === 'string' ? initialQuery.platformKey : '')
const rdjb = ref('all')
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
let controller: AbortController | undefined

const year = computed(() => yearInput.value.trim())
const yearError = computed(() => year.value && !/^\d+$/.test(year.value) ? '业务年必须是正整数' : '')
const titleOptions = computed(() => PLATFORM_RDJB_ORDER.map(value => ({ value, label: PLATFORM_RDJBS[value] ?? value })))

function requestParams() {
  return {
    view: view.value,
    ...(enterpriseQuery.value.trim() ? { q: enterpriseQuery.value.trim() } : {}),
    ...(platformKey.value.trim() ? { platformKey: platformKey.value.trim() } : {}),
    ...(rdjb.value !== 'all' ? { rdjb: rdjb.value } : {}),
    ...(declareKind.value.trim() ? { declareKind: declareKind.value.trim() } : {}),
    ...(year.value && !yearError.value ? { year: Number(year.value) } : {}),
    ...(status.value.trim() ? { status: status.value.trim() } : {}),
    ...(batch.value.trim() ? { batch: batch.value.trim() } : {}),
    page: page.value,
    pageSize: pageSize.value,
  }
}

async function load() {
  if (yearError.value) return
  const request = ++generation
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const result = await $fetch<BusinessProcessListResult>('/api/platform/business-processes', { query: requestParams(), signal: controller.signal, retry: 0 })
    if (request === generation) data.value = result
  } catch (cause) {
    if (request === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (request === generation) loading.value = false
  }
}

function search() {
  if (page.value !== 1) page.value = 1
  else void load()
}
function reset() {
  enterpriseQuery.value = ''
  platformKey.value = ''
  rdjb.value = 'all'
  declareKind.value = ''
  yearInput.value = ''
  status.value = ''
  batch.value = ''
  if (page.value !== 1) page.value = 1
  else void load()
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

watch([page, pageSize], () => { void load() })
watch([view, rdjb], () => {
  if (page.value !== 1) page.value = 1
  else void load()
})
onBeforeUnmount(() => { ++generation; controller?.abort() })
void load()

const total = computed(() => data.value?.total ?? 0)
const rows = computed(() => data.value?.rows ?? [])
const emptyTitle = computed(() => view.value === 'records' ? '没有匹配的关联办理记录' : '没有隔离的办理观察')
const emptyDescription = computed(() => view.value === 'records'
  ? '当前条件下没有已建立 typed 投影的关联办理记录；未知事项、业务年、状态或批次不会猜填。'
  : '缺编号、编号冲突或原文无法核实的办理观察会在此逐条保留，不并入任何业务记录。')
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2 sm:gap-3" :aria-busy="loading">
    <PageHeader title="关联办理" description="本地查询已归档的关联办理：按企业、办理编号、明确称号范围、事项、业务年、状态与维护批次筛选；称号范围来自原查询，不代表逐行称号事实。" />

    <form class="flex flex-col gap-2" @submit.prevent="search">
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative w-full min-w-52 flex-1 sm:max-w-[13rem]">
          <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
          <Input v-model="enterpriseQuery" class="bg-card h-8 pl-8" placeholder="搜索企业名称或信用代码" aria-label="企业名称或信用代码" />
        </div>
        <Input v-model="platformKey" class="bg-card h-8 w-full sm:w-32" placeholder="办理编号" aria-label="办理编号" />
        <Select :model-value="rdjb" @update:model-value="rdjb = String($event)">
          <SelectTrigger class="bg-card h-8 w-full sm:w-40" aria-label="称号范围"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部称号范围</SelectItem>
            <SelectItem v-for="option in titleOptions" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
          </SelectContent>
        </Select>
        <Input v-model="declareKind" class="bg-card h-8 w-full sm:w-24" placeholder="全部事项" aria-label="事项" />
        <Input v-model="yearInput" inputmode="numeric" class="bg-card h-8 w-full sm:w-24" placeholder="全部业务年" aria-label="明确业务年" :aria-invalid="Boolean(yearError)" />
        <Input v-model="status" class="bg-card h-8 w-full sm:w-28" placeholder="全部状态" aria-label="办理状态" />
        <Input v-model="batch" class="bg-card h-8 w-full sm:w-24" placeholder="全部批次" aria-label="维护批次" />
        <Select :model-value="view" @update:model-value="view = $event as 'records' | 'isolated'">
          <SelectTrigger class="bg-card h-8 w-full sm:w-28" aria-label="关联办理视图"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="records">业务记录</SelectItem>
            <SelectItem value="isolated">缺编号观察</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline" size="sm" :disabled="loading || Boolean(yearError)"><Search data-icon="inline-start" />查询</Button>
        <Button type="button" variant="ghost" size="sm" :disabled="loading" @click="reset"><X data-icon="inline-start" />重置</Button>
        <span class="text-muted-foreground text-[13px] tabular-nums" aria-live="polite">共 {{ total.toLocaleString('zh-CN') }} {{ view === 'records' ? '条记录' : '条观察' }}</span>
      </div>
      <p v-if="yearError" class="text-destructive text-[13px] leading-5">{{ yearError }}</p>
    </form>

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
