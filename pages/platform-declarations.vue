<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Search, X } from '@lucide/vue'
import type { DeclarationListResult } from '~~/lib/platform/declarations'
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
import PlatformDeclarationTable from '@/components/PlatformDeclarationTable.vue'
import PlatformDeclarationDetailDialog from '@/components/PlatformDeclarationDetailDialog.vue'

useHead({ title: '申报记录 · 专精特新' })

const view = ref<'records' | 'isolated'>('records')
const enterpriseQuery = ref('')
const platformKey = ref('')
const declareKind = ref('')
const yearInput = ref('')
const status = ref('')
const page = ref(1)
const pageSize = ref(25)
const data = shallowRef<DeclarationListResult>()
const loading = ref(false)
const error = ref('')
const selectedRecordId = ref<number | null>(null)
const detailOpen = ref(false)
let generation = 0
let controller: AbortController | undefined

const year = computed(() => yearInput.value.trim())
const yearError = computed(() => year.value && !/^\d+$/.test(year.value) ? '年度必须是正整数' : '')

function requestParams() {
  return {
    view: view.value,
    ...(enterpriseQuery.value.trim() ? { q: enterpriseQuery.value.trim() } : {}),
    ...(platformKey.value.trim() ? { platformKey: platformKey.value.trim() } : {}),
    ...(declareKind.value.trim() ? { declareKind: declareKind.value.trim() } : {}),
    ...(year.value && !yearError.value ? { year: Number(year.value) } : {}),
    ...(status.value.trim() ? { status: status.value.trim() } : {}),
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
    const result = await $fetch<DeclarationListResult>('/api/platform/declarations', { query: requestParams(), signal: controller.signal, retry: 0 })
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
  declareKind.value = ''
  yearInput.value = ''
  status.value = ''
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
watch(view, () => {
  if (page.value !== 1) page.value = 1
  else void load()
})
onBeforeUnmount(() => { ++generation; controller?.abort() })
void load()

const total = computed(() => data.value?.total ?? 0)
const rows = computed(() => data.value?.rows ?? [])
const emptyTitle = computed(() => view.value === 'records' ? '没有匹配的申报记录' : '没有隔离的申报观察')
const emptyDescription = computed(() => view.value === 'records'
  ? '当前条件下没有已建立 typed 投影的申报记录；未知事项或年度不会猜填。'
  : '缺编号、编号冲突或原文无法核实的申报观察会在此逐条保留，不并入任何业务记录。')
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4" :aria-busy="loading">
    <PageHeader title="申报记录" description="本地查询已归档的申报业务：按企业、申报编号、事项、明确年度与状态筛选；未知值保持空，不猜填称号或年度。">
      <template #breadcrumb><NuxtLink to="/" class="hover:underline">企业列表</NuxtLink><span> / 申报记录</span></template>
      <template #actions>
        <span class="text-muted-foreground text-xs">只读 · 不再访问外部平台</span>
      </template>
    </PageHeader>

    <Card class="gap-0 py-0">
      <CardContent class="p-4">
        <form class="flex min-w-0 flex-col gap-3" @submit.prevent="search">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <label class="flex min-w-0 flex-col gap-1 text-[13px]">
              <span class="text-muted-foreground">企业名称或信用代码</span>
              <Input v-model="enterpriseQuery" placeholder="关键词" class="bg-card" aria-label="企业名称或信用代码" />
            </label>
            <label class="flex min-w-0 flex-col gap-1 text-[13px]">
              <span class="text-muted-foreground">申报编号</span>
              <Input v-model="platformKey" placeholder="精确编号" class="bg-card" aria-label="申报编号" />
            </label>
            <label class="flex min-w-0 flex-col gap-1 text-[13px]">
              <span class="text-muted-foreground">事项（原 sblx）</span>
              <Input v-model="declareKind" placeholder="如 申请 / 复核" class="bg-card" aria-label="事项" />
            </label>
            <label class="flex min-w-0 flex-col gap-1 text-[13px]">
              <span class="text-muted-foreground">明确年度</span>
              <Input v-model="yearInput" inputmode="numeric" placeholder="如 2024" class="bg-card" aria-label="明确年度" :aria-invalid="Boolean(yearError)" />
              <span v-if="yearError" class="text-destructive text-xs">{{ yearError }}</span>
            </label>
            <label class="flex min-w-0 flex-col gap-1 text-[13px]">
              <span class="text-muted-foreground">状态（原 cszt）</span>
              <Input v-model="status" placeholder="如 终审通过" class="bg-card" aria-label="状态" />
            </label>
            <div class="flex min-w-0 flex-col gap-1 text-[13px]">
              <span class="text-muted-foreground">视图</span>
              <Select :model-value="view" @update:model-value="view = $event as 'records' | 'isolated'">
                <SelectTrigger class="bg-card" aria-label="申报记录视图"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="records">业务记录</SelectItem>
                  <SelectItem value="isolated">缺编号观察</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Button type="submit" :disabled="loading || Boolean(yearError)"><Search data-icon="inline-start" />查询</Button>
            <Button type="button" variant="outline" :disabled="loading" @click="reset"><X data-icon="inline-start" />重置</Button>
            <span class="text-muted-foreground text-xs" aria-live="polite">共 {{ total.toLocaleString('zh-CN') }} {{ view === 'records' ? '条申报记录' : '条隔离观察' }}</span>
          </div>
        </form>
      </CardContent>
    </Card>

    <div class="relative h-6"><TableLoadingStatus kind="platform" :loading="loading" label="正在加载申报记录…" /></div>
    <TableFailureState v-if="error" :title="`申报记录第 ${page} 页加载失败`" :description="`${error}${data ? `；保留第 ${data.page} 页结果。` : ''}`" :pending="loading" @retry="load" />
    <template v-if="loading && !rows.length"><Skeleton v-for="i in 3" :key="i" class="h-24 w-full" /></template>
    <Empty v-else-if="!error && !rows.length">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Search /></EmptyMedia>
        <EmptyTitle>{{ emptyTitle }}</EmptyTitle>
        <EmptyDescription>{{ emptyDescription }}</EmptyDescription>
      </EmptyHeader>
    </Empty>
    <template v-else-if="rows.length">
      <PlatformDeclarationTable :view="view" :rows="rows" :loading="loading" @open-record="openRecord" />
      <TablePagination :page="data?.page ?? page" :page-size="data?.pageSize ?? pageSize" :total="total" :loading="loading" :unit="view === 'records' ? '条记录' : '条观察'" @update:page="page = $event" @update:page-size="changeSize" />
    </template>

    <PlatformDeclarationDetailDialog v-model:open="detailOpen" :record-id="selectedRecordId" />
  </div>
</template>
