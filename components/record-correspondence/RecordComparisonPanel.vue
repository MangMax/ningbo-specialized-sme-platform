<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { GitCompareArrows } from '@lucide/vue'
import { COMPARISON_CLASSES, comparisonRequest, comparisonRouteFromQuery, comparisonRouteKey, comparisonRouteQuery, comparisonSelectionQuery, instantFromLocalDateTime, localDateTimeForInstant, type ComparisonRouteState, type ComparisonSelection, type RecordComparisonResult } from '~~/lib/roster/record-comparison-view'
import { useEvidencePreviewScrollRestore } from '~~/lib/roster/evidence-preview-return'
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
const committed = ref<ComparisonRouteState>(comparisonRouteFromQuery(route.query))
const copySelection = (value: ComparisonSelection): ComparisonSelection => ({ queryIds: [...value.queryIds], exportBatchIds: [...value.exportBatchIds], officialSourceDocumentIds: [...value.officialSourceDocumentIds], proofIds: [...value.proofIds] })
const selection = ref<ComparisonSelection>(copySelection(committed.value.selection))
const asOfLocal = ref(localDateTimeForInstant(committed.value.asOf))
const displayed = ref<RecordComparisonResult | null>(null)
const displayedScope = ref<ComparisonRouteState | null>(null)
const loading = ref(false)
const error = ref(false)
let requestId = 0
let localNavigationKey: string | null = null

watch(() => route.query, (query) => {
  const next = comparisonRouteFromQuery(query)
  const key = comparisonRouteKey(next)
  const preserveDraft = localNavigationKey === key
  localNavigationKey = null
  if (key !== comparisonRouteKey(committed.value)) committed.value = next
  if (!preserveDraft) {
    selection.value = copySelection(next.selection)
    asOfLocal.value = localDateTimeForInstant(next.asOf)
  }
}, { deep: true })

const submitted = computed(() => committed.value.selection.queryIds.length && committed.value.selection.officialSourceDocumentIds.length ? committed.value.selection : null)
const asOfIso = computed(() => instantFromLocalDateTime(asOfLocal.value, committed.value.asOf))
const asOfValid = computed(() => !asOfLocal.value || !!asOfIso.value)
const canCompare = computed(() => selection.value.queryIds.length > 0 && selection.value.officialSourceDocumentIds.length > 0 && asOfValid.value)
const sourceKey = (value: ComparisonSelection) => JSON.stringify([value.queryIds, value.exportBatchIds, value.officialSourceDocumentIds, value.proofIds])
const selectionChanged = computed(() => sourceKey(selection.value) !== sourceKey(committed.value.selection) || asOfIso.value !== committed.value.asOf)
const displayedIsTarget = computed(() => !!displayed.value && !!displayedScope.value && comparisonRouteKey(displayedScope.value) === comparisonRouteKey(committed.value))
const returnTo = computed(() => {
  const scope = displayedScope.value
  const result = displayed.value
  if (!scope || !result) return '/comparison?mode=record'
  return `/comparison?${new URLSearchParams(comparisonRouteQuery({ ...scope, page: result.page, pageSize: result.pageSize }))}`
})
const scopeText = (scope: ComparisonRouteState) => `${scope.selection.officialSourceDocumentIds.length} 份正式文件 · ${scope.selection.queryIds.length} 次归档查询 · ${scope.selection.exportBatchIds.length} 个导出版本 · ${scope.selection.proofIds.length} 项范围依据 · ${scope.classification === 'all' ? '全部分类' : COMPARISON_CLASSES[scope.classification]} · 截止 ${scope.asOf || '未设置'} · 第 ${scope.page} 页 · 每页 ${scope.pageSize} 条`
const displayedScopeText = computed(() => displayedScope.value && displayed.value ? scopeText({ ...displayedScope.value, page: displayed.value.page, pageSize: displayed.value.pageSize }) : '')
const targetScopeText = computed(() => scopeText(committed.value))
// Each picker reports the input it has settled, so an older report cannot release a new scope.
const sourceReadyKey = ref<string | null>(null)
const proofReadyKey = ref<string | null>(null)
const sourceLayoutKey = computed(() => JSON.stringify(selection.value))
const proofLayoutKey = computed(() => JSON.stringify([selection.value, asOfIso.value]))
const restoreScopeKey = comparisonRouteKey(committed.value)
const panel = useTemplateRef<HTMLElement>('panel')
const restoreReady = computed(() => displayedIsTarget.value && !loading.value && !error.value
  && comparisonRouteKey(committed.value) === restoreScopeKey
  && sourceReadyKey.value === sourceLayoutKey.value && proofReadyKey.value === proofLayoutKey.value)
useEvidencePreviewScrollRestore(restoreReady, (anchor) => {
  const event = [...(panel.value?.querySelectorAll<HTMLElement>('[data-event-id]') ?? [])].find(element => element.dataset.eventId === anchor.eventId)
  return event ? window.scrollY + event.getBoundingClientRect().top - anchor.viewportTop : undefined
})

async function load() {
  const current = ++requestId
  const target = committed.value
  if (!target.selection.queryIds.length || !target.selection.officialSourceDocumentIds.length) {
    displayed.value = null
    displayedScope.value = null
    loading.value = false
    error.value = false
    return
  }
  const request = comparisonRequest(target.selection, target.page, target.pageSize, target.classification === 'all' ? undefined : target.classification)
  loading.value = true
  error.value = false
  try {
    const result = await $fetch<RecordComparisonResult>('/api/roster/record-comparison', { query: { ...comparisonSelectionQuery(target.selection), page: request.page, pageSize: request.pageSize, ...(request.classification ? { classification: request.classification } : {}), ...(target.asOf ? { asOf: target.asOf } : {}) } })
    if (current !== requestId) return
    displayed.value = result
    displayedScope.value = { ...target, selection: copySelection(target.selection) }
  } catch {
    if (current === requestId) error.value = true
  } finally {
    if (current === requestId) loading.value = false
  }
}
watch(committed, () => { void load() }, { immediate: true })

async function navigate(next: ComparisonRouteState, replace = false) {
  localNavigationKey = comparisonRouteKey(next)
  try {
    const target = { path: '/comparison', query: comparisonRouteQuery(next) }
    if (replace) await router.replace(target)
    else await router.push(target)
  } catch {
    // The current URL remains the submitted view if navigation is cancelled.
  } finally {
    if (localNavigationKey === comparisonRouteKey(next)) localNavigationKey = null
  }
}
function setSelection(value: ComparisonSelection) { selection.value = value }
function setProofIds(value: number[]) { selection.value = { ...selection.value, proofIds: value } }
async function run() {
  if (!canCompare.value) return
  const next: ComparisonRouteState = { ...committed.value, selection: copySelection(selection.value), asOf: asOfIso.value, page: 1 }
  const sameScope = comparisonRouteKey(next) === comparisonRouteKey(committed.value)
  await navigate(next, sameScope)
  if (sameScope) await load()
}
function setClassification(value: unknown) {
  if (typeof value !== 'string' || value !== 'all' && !Object.hasOwn(COMPARISON_CLASSES, value)) return
  void navigate({ ...committed.value, classification: value as ComparisonRouteState['classification'], page: 1 })
}
function setPage(value: number) { if (Number.isSafeInteger(value) && value > 0) void navigate({ ...committed.value, page: value }) }
function setPageSize(value: number) { if (Number.isSafeInteger(value) && value > 0 && value <= 200) void navigate({ ...committed.value, page: 1, pageSize: value }) }
const total = computed(() => displayed.value?.total ?? 0)
const resultTitle = computed(() => displayed.value
  ? `正式事件逐条对照 · 筛选后 ${total.value} 条可见事件`
  : loading.value ? '正式事件逐条对照 · 正在读取对照结果' : '正式事件逐条对照 · 对照结果暂不可用')
const shownPage = computed(() => displayed.value?.page ?? committed.value.page)
</script>

<template>
  <div ref="panel" class="flex min-w-0 flex-col gap-3" data-testid="record-comparison-panel">
    <Card class="min-w-0 gap-0 py-0"><CardHeader class="border-b px-5 py-4"><h2 class="text-sm font-medium">选择记录级对比来源</h2></CardHeader><CardContent class="flex min-w-0 flex-col gap-3 p-5">
      <ComparisonSourcePicker :selection="selection" @change="setSelection" @settled="(key, ready) => { sourceReadyKey = ready ? key : null }" />
      <ComparisonProofPicker :selection="selection" :as-of="asOfIso" @change="setProofIds" @settled="(key, ready) => { proofReadyKey = ready ? key : null }" />
      <div class="flex flex-wrap items-end gap-3"><div class="flex flex-col gap-1"><Label for="record-as-of">截止时点（可选）</Label><Input id="record-as-of" v-model="asOfLocal" type="datetime-local" step="0.001" class="w-64 max-w-full" :aria-invalid="!asOfValid" /></div><Button :disabled="!canCompare || loading" @click="run">按所选来源对比</Button><span v-if="!asOfValid" class="text-destructive text-[13px]">请填写有效的截止时点。</span><span v-else-if="!canCompare" class="text-muted-foreground text-[13px]">至少选一份正式文件和一次归档查询；导出版本可不选。</span><span v-else-if="selectionChanged" class="text-muted-foreground text-[13px]">来源或截止时点已改，点击按钮重新对比；下方仍是上次结果。</span></div>
    </CardContent></Card>
    <template v-if="submitted">
      <p v-if="displayed" class="text-muted-foreground rounded-sm border p-3 text-[13px]" aria-label="已加载结果范围"><strong class="text-foreground font-medium">已加载结果范围：</strong>{{ displayedScopeText }}</p>
      <p v-if="displayed && !displayedIsTarget" class="text-muted-foreground rounded-sm border p-3 text-[13px]" aria-label="目标结果范围"><strong class="text-foreground font-medium">当前目标范围：</strong>{{ targetScopeText }}。下方继续显示上次成功结果；目标加载成功后才会替换。</p>
      <ComparisonEvidence v-if="displayed" :result="displayed" :return-to="returnTo" />
      <div class="flex min-w-0 flex-col gap-2"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="text-sm font-medium">{{ resultTitle }}</h2><Select :model-value="committed.classification" @update:model-value="setClassification"><SelectTrigger size="sm" class="w-56 max-w-full" aria-label="按事件分类筛选"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部分类</SelectItem><SelectItem v-for="(label, code) in COMPARISON_CLASSES" :key="code" :value="code">{{ label }}</SelectItem></SelectGroup></SelectContent></Select></div>
        <TableLoadingStatus kind="comparison" :loading="loading" label="正在读取记录级结果…" />
        <TableFailureState v-if="error" title="记录级对比读取失败" :compact="!!displayed" :pending="loading" :description="displayed ? '本次目标未加载，下方保留上次成功的结果；范围见上方。' : '请核对所选来源是否仍可用，然后重试。'" @retry="load" />
        <div v-if="displayed?.rows.length" class="flex min-w-0 flex-col gap-2"><ComparisonEventRow v-for="row in displayed.rows" :key="row.event.id" :row="row" :return-to="returnTo" /></div>
        <Empty v-else-if="!loading && !error"><EmptyHeader><EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia><EmptyTitle>所选范围内没有可见正式事件</EmptyTitle><EmptyDescription>这只说明当前选择和筛选没有返回事件；查看上方来源覆盖与接口原行计数。</EmptyDescription></EmptyHeader></Empty>
        <TablePagination v-if="displayed" :page="shownPage" :page-size="displayed.pageSize" :total="displayed.total" unit="条事件" :loading="loading || error" @update:page="setPage" @update:page-size="setPageSize" />
      </div>
    </template>
  </div>
</template>
