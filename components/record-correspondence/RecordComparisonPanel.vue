<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { GitCompareArrows } from '@lucide/vue'
import { COMPARISON_CLASSES, comparisonRequest, comparisonSelectionFromQuery, comparisonSelectionQuery, type ComparisonSelection, type RecordComparisonResult } from '~~/lib/roster/record-comparison-view'
import type { RecordComparisonInput } from '~~/lib/roster/record-comparison'
import ComparisonSourcePicker from './ComparisonSourcePicker.vue'
import ComparisonProofPicker from './ComparisonProofPicker.vue'
import ComparisonEventRow from './ComparisonEventRow.vue'
import ComparisonEvidence from './ComparisonEvidence.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

const route = useRoute()
const router = useRouter()
const initial = comparisonSelectionFromQuery(route.query)
const selection = ref<ComparisonSelection>(initial)
const submitted = ref<ComparisonSelection | null>(initial.queryIds.length && initial.officialSourceDocumentIds.length ? initial : null)
const page = ref(typeof route.query.page === 'string' && /^\d+$/.test(route.query.page) ? Math.max(1, Number(route.query.page)) : 1)
const pageSize = ref(25)
const classification = ref(typeof route.query.classification === 'string' && route.query.classification in COMPARISON_CLASSES ? route.query.classification : 'all')
const asOfLocal = ref(typeof route.query.asOf === 'string' && Number.isFinite(Date.parse(route.query.asOf)) ? new Date(route.query.asOf).toISOString().slice(0, 16) : '')
const submittedAsOf = ref(typeof route.query.asOf === 'string' && Number.isFinite(Date.parse(route.query.asOf)) ? new Date(route.query.asOf).toISOString() : '')
const displayed = ref<RecordComparisonResult | null>(null)
const displayedSourceKey = ref('')
const displayedSelection = ref<ComparisonSelection | null>(null)
const displayedClassification = ref('all')
const displayedAsOf = ref('')
const loading = ref(false)
const error = ref(false)
let requestId = 0
const asOfValid = computed(() => !asOfLocal.value || Number.isFinite(Date.parse(asOfLocal.value)))
const canCompare = computed(() => selection.value.queryIds.length > 0 && selection.value.officialSourceDocumentIds.length > 0 && asOfValid.value)
const sourceKey = (value: ComparisonSelection) => JSON.stringify([value.queryIds, value.exportBatchIds, value.officialSourceDocumentIds, value.proofIds])
const asOfIso = computed(() => asOfLocal.value && Number.isFinite(Date.parse(asOfLocal.value)) ? new Date(asOfLocal.value).toISOString() : '')
const selectionChanged = computed(() => submitted.value && (sourceKey(selection.value) !== sourceKey(submitted.value) || asOfIso.value !== submittedAsOf.value))
const returnTo = computed(() => {
  const params = new URLSearchParams({ mode: 'record', ...comparisonSelectionQuery(displayedSelection.value ?? submitted.value ?? selection.value), page: String(displayed.value?.page ?? page.value) })
  const showingClass = displayed.value ? displayedClassification.value : classification.value
  if (showingClass !== 'all') params.set('classification', showingClass)
  const showingAsOf = displayed.value ? displayedAsOf.value : submittedAsOf.value
  if (showingAsOf) params.set('asOf', showingAsOf)
  return `/comparison?${params}`
})
async function load() {
  if (!submitted.value) return
  const current = ++requestId
  const request = comparisonRequest(submitted.value, page.value, pageSize.value, classification.value === 'all' ? undefined : classification.value as RecordComparisonInput['classification'])
  const key = sourceKey(submitted.value)
  loading.value = true
  error.value = false
  try {
    const result = await $fetch<RecordComparisonResult>('/api/roster/record-comparison', { query: { ...comparisonSelectionQuery(submitted.value), page: request.page, pageSize: request.pageSize, ...(request.classification ? { classification: request.classification } : {}), ...(submittedAsOf.value ? { asOf: submittedAsOf.value } : {}) } })
    if (current !== requestId) return
    displayed.value = result
    displayedSourceKey.value = key
    displayedSelection.value = { ...submitted.value!, queryIds: [...submitted.value!.queryIds], exportBatchIds: [...submitted.value!.exportBatchIds], officialSourceDocumentIds: [...submitted.value!.officialSourceDocumentIds], proofIds: [...submitted.value!.proofIds] }
    displayedClassification.value = classification.value
    displayedAsOf.value = submittedAsOf.value
  } catch {
    if (current === requestId) error.value = true
  } finally {
    if (current === requestId) loading.value = false
  }
}
watch([submitted, page, pageSize, classification, submittedAsOf], () => { void load() }, { immediate: true, deep: true })
function setSelection(value: ComparisonSelection) { selection.value = value }
function setProofIds(value: number[]) { selection.value = { ...selection.value, proofIds: value } }
async function run() {
  if (!canCompare.value) return
  page.value = 1
  submittedAsOf.value = asOfIso.value
  submitted.value = { ...selection.value, queryIds: [...selection.value.queryIds], exportBatchIds: [...selection.value.exportBatchIds], officialSourceDocumentIds: [...selection.value.officialSourceDocumentIds], proofIds: [...selection.value.proofIds] }
  const query = { mode: 'record', ...comparisonSelectionQuery(submitted.value), page: '1', ...(classification.value === 'all' ? {} : { classification: classification.value }), ...(submittedAsOf.value ? { asOf: submittedAsOf.value } : {}) }
  await router.replace({ path: '/comparison', query })
}
function setPage(value: number) { page.value = value; void router.replace({ path: '/comparison', query: { ...route.query, page: String(value) } }) }
function setPageSize(value: number) { pageSize.value = value; page.value = 1 }
const total = computed(() => displayed.value?.total ?? 0)
const shownPage = computed(() => displayed.value?.page ?? page.value)
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" data-testid="record-comparison-panel">
    <Card class="min-w-0 gap-0 py-0"><CardHeader class="border-b px-5 py-4"><h2 class="text-sm font-medium">选择记录级对比来源</h2></CardHeader><CardContent class="flex min-w-0 flex-col gap-3 p-5">
      <ComparisonSourcePicker :selection="selection" @change="setSelection" />
      <ComparisonProofPicker :selection="selection" :as-of="asOfIso" @change="setProofIds" />
      <div class="flex flex-wrap items-end gap-3"><div class="flex flex-col gap-1"><Label for="record-as-of">截止时点（可选）</Label><Input id="record-as-of" v-model="asOfLocal" type="datetime-local" class="w-56 max-w-full" :aria-invalid="!asOfValid" /></div><Button :disabled="!canCompare || loading" @click="run">按所选来源对比</Button><span v-if="!asOfValid" class="text-destructive text-[13px]">请填写有效的截止时点。</span><span v-else-if="!canCompare" class="text-muted-foreground text-[13px]">至少选一份正式文件和一次归档查询；导出版本可不选。</span><span v-else-if="selectionChanged" class="text-muted-foreground text-[13px]">来源选择已改，点击按钮重新对比；下方仍是上次结果。</span></div>
    </CardContent></Card>
    <template v-if="submitted">
      <ComparisonEvidence v-if="displayed" :result="displayed" :return-to="returnTo" />
      <div class="flex min-w-0 flex-col gap-2"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="text-sm font-medium">正式事件逐条对照 · {{ total }} 条可见事件</h2><Select v-model="classification" @update:model-value="page = 1"><SelectTrigger size="sm" class="w-56 max-w-full" aria-label="按事件分类筛选"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部分类</SelectItem><SelectItem v-for="(label, code) in COMPARISON_CLASSES" :key="code" :value="code">{{ label }}</SelectItem></SelectGroup></SelectContent></Select></div>
        <TableLoadingStatus kind="comparison" :loading="loading" label="正在读取记录级结果…" />
        <TableFailureState v-if="error" title="记录级对比读取失败" :compact="!!displayed" :pending="loading" :description="displayed ? '本次目标未加载，继续显示上次成功的事件结果与来源范围。' : '请核对所选来源是否仍可用，然后重试。'" @retry="load" />
        <p v-if="displayed && (displayedSourceKey !== sourceKey(submitted) || displayed.page !== page)" class="text-muted-foreground text-[13px]">下方仍显示上次成功的来源范围与第 {{ displayed.page }} 页。</p>
        <div v-if="displayed?.rows.length" class="flex min-w-0 flex-col gap-2"><ComparisonEventRow v-for="row in displayed.rows" :key="row.event.id" :row="row" :return-to="returnTo" /></div>
        <Empty v-else-if="!loading && !error"><EmptyHeader><EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia><EmptyTitle>所选范围内没有可见正式事件</EmptyTitle><EmptyDescription>这只说明当前选择和筛选没有返回事件；查看上方来源覆盖与接口原行计数。</EmptyDescription></EmptyHeader></Empty>
        <TablePagination v-if="displayed" :page="shownPage" :page-size="displayed.pageSize" :total="displayed.total" unit="条事件" :loading="loading || error" @update:page="setPage" @update:page-size="setPageSize" />
      </div>
    </template>
  </div>
</template>
