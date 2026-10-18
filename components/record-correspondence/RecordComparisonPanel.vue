<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { ChevronDown, GitCompareArrows, RefreshCw } from '@lucide/vue'
import { COMPARISON_CLASSES, comparisonRequest, comparisonRouteFromQuery, comparisonRouteKey, comparisonRouteQuery, comparisonSelectionQuery, instantFromLocalDateTime, localDateTimeForInstant, type ComparisonRouteState, type ComparisonSelection, type ComparisonSource, type RecordComparisonResult } from '~~/lib/roster/record-comparison-view'
import { useEvidencePreviewScrollRestore } from '~~/lib/roster/evidence-preview-return'
import { humanRecordTime } from '~~/lib/roster/record-ledger'
import ComparisonSourcePicker from './ComparisonSourcePicker.vue'
import ComparisonProofPicker from './ComparisonProofPicker.vue'
import ComparisonEventRow from './ComparisonEventRow.vue'
import ComparisonEvidence from './ComparisonEvidence.vue'
import ComparisonDateTimePicker from './ComparisonDateTimePicker.vue'
import ComparisonResultScope from './ComparisonResultScope.vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

const route = useRoute()
const router = useRouter()
const committed = ref<ComparisonRouteState>(comparisonRouteFromQuery(route.query))
const copySelection = (value: ComparisonSelection): ComparisonSelection => ({ queryIds: [...value.queryIds], exportBatchIds: [...value.exportBatchIds], officialSourceDocumentIds: [...value.officialSourceDocumentIds], proofIds: [...value.proofIds] })
const selection = ref<ComparisonSelection>(copySelection(committed.value.selection))
const asOfLocal = ref(localDateTimeForInstant(committed.value.asOf))
const pickerValid = ref(true)
const displayed = ref<RecordComparisonResult | null>(null)
const displayedScope = ref<ComparisonRouteState | null>(null)
const loading = ref(false)
const error = ref(false)
const catalogTotals = ref<Partial<Record<'official_document' | 'query' | 'export_batch', number>>>({})
const sourceLabels = ref<Record<string, ComparisonSource>>({})
function rememberSources(rows: ComparisonSource[]) {
  for (const row of rows) sourceLabels.value[`${row.kind}:${row.id}`] = row
}
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
/**
 * 已有结果 / URL 里已有范围时，来源表单收成一行摘要；空状态仍展开完整选择。
 * 收起只改变可见高度，pickers、范围依据与时间选择器保持挂载，显式选择、
 * 目录 hydration、ready 回调与返回滚动都不会因为折叠而重建。
 */
const sourcesExpanded = ref(selection.value.queryIds.length > 0 || selection.value.officialSourceDocumentIds.length > 0)
/** 点「开始对比」时直接收起到最终高度，避免结果落点按动画中途的位置计算。 */
const skipPanelTransition = ref(false)
watch(submitted, (value) => { sourcesExpanded.value = value === null }, { immediate: true })
const asOfIso = computed(() => instantFromLocalDateTime(asOfLocal.value, committed.value.asOf))
const asOfValid = computed(() => pickerValid.value && (!asOfLocal.value || !!asOfIso.value))
const canCompare = computed(() => selection.value.queryIds.length > 0 && selection.value.officialSourceDocumentIds.length > 0 && asOfValid.value)
const missingSides = computed(() => [
  ...(selection.value.officialSourceDocumentIds.length ? [] : ['正式文件']),
  ...(selection.value.queryIds.length ? [] : ['平台查询']),
])
const disabledReason = computed(() => missingSides.value.length
  ? `请选择${missingSides.value.join('和')}后开始对比。`
  : '')
const sourceKey = (value: ComparisonSelection) => JSON.stringify([value.queryIds, value.exportBatchIds, value.officialSourceDocumentIds, value.proofIds])
const selectionChanged = computed(() => sourceKey(selection.value) !== sourceKey(committed.value.selection) || asOfIso.value !== committed.value.asOf)
const displayedIsTarget = computed(() => !!displayed.value && !!displayedScope.value && comparisonRouteKey(displayedScope.value) === comparisonRouteKey(committed.value))
const resultIsCurrent = computed(() => displayedIsTarget.value && !selectionChanged.value && !loading.value && !error.value)
const returnTo = computed(() => {
  const scope = displayedScope.value
  const result = displayed.value
  if (!scope || !result) return '/comparison?mode=record'
  return `/comparison?${new URLSearchParams(comparisonRouteQuery({ ...scope, page: result.page, pageSize: result.pageSize }))}`
})
const scopeText = (scope: ComparisonRouteState) => `${scope.selection.officialSourceDocumentIds.length} 份正式文件 · ${scope.selection.queryIds.length} 次归档查询 · ${scope.selection.exportBatchIds.length} 个导出版本 · ${scope.selection.proofIds.length} 项范围依据 · ${scope.classification === 'all' ? '全部分类' : COMPARISON_CLASSES[scope.classification]} · 截止 ${scope.asOf ? humanRecordTime(scope.asOf) : '未设置'} · 第 ${scope.page} 页 · 每页 ${scope.pageSize} 条`
const displayedScopeText = computed(() => displayedScope.value && displayed.value ? scopeText({ ...displayedScope.value, page: displayed.value.page, pageSize: displayed.value.pageSize }) : '')
const loadedScope = computed(() => displayedScope.value && displayed.value ? { ...displayedScope.value, page: displayed.value.page, pageSize: displayed.value.pageSize } : null)
const targetScopeText = computed(() => scopeText(committed.value))
/** 收起摘要只陈述已经提交、对应下方结果的来源范围，不把未提交的草稿冒充结果依据。 */
const summaryCounts = computed(() => ({
  official: committed.value.selection.officialSourceDocumentIds.length,
  query: committed.value.selection.queryIds.length,
}))
// Each visible picker reports the input it has settled, so an older report cannot release a new scope.
// The optional export catalog never gates return-scroll restoration.
const sourceReady = ref<Record<'official' | 'query', string | null>>({ official: null, query: null })
function setSourceReady(slot: 'official' | 'query', key: string, ready: boolean) {
  sourceReady.value = { ...sourceReady.value, [slot]: ready ? key : null }
}
const proofReadyKey = ref<string | null>(null)
const sourceLayoutKey = computed(() => JSON.stringify(selection.value))
const proofLayoutKey = computed(() => JSON.stringify([selection.value, asOfIso.value]))
const sourceReadyKey = computed(() => sourceReady.value.official === sourceLayoutKey.value && sourceReady.value.query === sourceLayoutKey.value ? sourceLayoutKey.value : null)
const restoreScopeKey = comparisonRouteKey(committed.value)
const panel = useTemplateRef<HTMLElement>('panel')
const resultsHeader = useTemplateRef<HTMLElement>('resultsHeader')
let revealResults = false
const restoreReady = computed(() => displayedIsTarget.value && !loading.value && !error.value
  && comparisonRouteKey(committed.value) === restoreScopeKey
  && sourceReadyKey.value === sourceLayoutKey.value && proofReadyKey.value === proofLayoutKey.value)
useEvidencePreviewScrollRestore(restoreReady, (anchor) => {
  const event = [...(panel.value?.querySelectorAll<HTMLElement>('[data-event-id]') ?? [])].find(element => element.dataset.eventId === anchor.eventId)
  return event ? window.scrollY + event.getBoundingClientRect().top - anchor.viewportTop : undefined
})

/** 一次 200ms 的落点：更新后结果标题轻微变色，告诉用户列表已经换成新结果。 */
const resultPulse = ref(false)
const resultVersion = ref(0)
let pulseTimer: ReturnType<typeof setTimeout> | null = null
function pulseResult() {
  resultPulse.value = true
  if (pulseTimer) clearTimeout(pulseTimer)
  pulseTimer = setTimeout(() => { resultPulse.value = false }, 700)
}
onBeforeUnmount(() => { if (pulseTimer) clearTimeout(pulseTimer) })
function scrollToResults(instant = false) {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  resultsHeader.value?.scrollIntoView?.({ block: 'start', behavior: instant || reduced ? 'auto' : 'smooth' })
}

async function load() {
  const current = ++requestId
  const target = committed.value
  if (!target.selection.queryIds.length || !target.selection.officialSourceDocumentIds.length) {
    displayed.value = null
    displayedScope.value = null
    loading.value = false
    error.value = false
    skipPanelTransition.value = false
    return
  }
  const request = comparisonRequest(target.selection, target.page, target.pageSize, target.classification === 'all' ? undefined : target.classification)
  loading.value = true
  error.value = false
  const shouldReveal = revealResults
  try {
    const result = await $fetch<RecordComparisonResult>('/api/roster/record-comparison', { query: { ...comparisonSelectionQuery(target.selection), page: request.page, pageSize: request.pageSize, ...(request.classification ? { classification: request.classification } : {}), ...(target.asOf ? { asOf: target.asOf } : {}) } })
    if (current !== requestId) return
    displayed.value = result
    displayedScope.value = { ...target, selection: copySelection(target.selection) }
    resultVersion.value++
    if (shouldReveal) pulseResult()
  } catch {
    if (current === requestId) error.value = true
  } finally {
    if (current === requestId) {
      loading.value = false
      if (shouldReveal) {
        revealResults = false
        await nextTick()
        scrollToResults()
      }
      // 收起动画关闭到落点完成，避免结果标题按动画中途的位置计算。
      skipPanelTransition.value = false
    }
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
  if (!canCompare.value || loading.value) return
  skipPanelTransition.value = true
  sourcesExpanded.value = false
  revealResults = true
  const next: ComparisonRouteState = { ...committed.value, selection: copySelection(selection.value), asOf: asOfIso.value, page: 1 }
  const sameScope = comparisonRouteKey(next) === comparisonRouteKey(committed.value)
  await navigate(next, sameScope)
  if (comparisonRouteKey(committed.value) !== comparisonRouteKey(next)) {
    revealResults = false
    skipPanelTransition.value = false
    return
  }
  const pending = sameScope ? load() : undefined
  await nextTick()
  // 来源表单收起后立刻把进行中反馈带入视野，不等慢请求完成。
  scrollToResults(true)
  await pending
}
function setClassification(value: unknown) {
  if (typeof value !== 'string' || value !== 'all' && !Object.hasOwn(COMPARISON_CLASSES, value)) return
  if (value === committed.value.classification) return
  revealResults = true
  void navigate({ ...committed.value, classification: value as ComparisonRouteState['classification'], page: 1 })
}
function setPage(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) return
  revealResults = true
  void navigate({ ...committed.value, page: value })
}
function setPageSize(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 200) return
  revealResults = true
  void navigate({ ...committed.value, page: 1, pageSize: value })
}
function setCatalogTotal(kind: 'official_document' | 'query' | 'export_batch', total: number) { catalogTotals.value = { ...catalogTotals.value, [kind]: total } }
const total = computed(() => displayed.value?.total ?? 0)
const resultTitle = computed(() => displayed.value
  ? `正式事件逐条对照 · 筛选后 ${total.value} 条可见事件`
  : loading.value ? '正式事件逐条对照 · 正在读取对照结果' : '正式事件逐条对照 · 对照结果暂不可用')
const shownPage = computed(() => displayed.value?.page ?? committed.value.page)

/** 全局分类计数直接来自接口；入口只负责跳到该分类，不把当前页顺序冒充全局排序。 */
const classificationEntries = computed(() => {
  const counts = displayed.value?.counts
  if (!counts) return []
  const entries = [
    { code: 'historical_conflict' as const, count: counts.historical_conflict ?? 0 },
    { code: 'unresolved' as const, count: counts.unresolved ?? 0 },
    { code: 'historical_aligned' as const, count: counts.historical_aligned ?? 0 },
    { code: 'official_without_correspondence' as const, count: counts.official_without_correspondence ?? 0 },
  ]
  return entries.filter(entry => entry.count > 0 || entry.code === committed.value.classification)
})
</script>

<template>
  <div ref="panel" class="flex min-w-0 flex-col gap-3" data-testid="record-comparison-panel">
      <div v-if="displayed" class="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="按分类查看结果">
        <span class="text-muted-foreground mr-1 text-[13px]">{{ resultIsCurrent ? '对比结论' : '上次结论' }}：</span>
        <Button
          v-for="entry in classificationEntries"
          :key="entry.code"
          variant="outline"
          size="sm"
          class="h-7 gap-1.5 px-2 text-[13px] tabular-nums transition-colors duration-150 ease-snap motion-reduce:transition-none"
          :class="[
            entry.code === 'historical_conflict' && 'border-destructive/40 text-destructive',
            entry.code === 'unresolved' && 'border-warning/50 text-warning',
            committed.classification === entry.code && 'bg-accent',
          ]"
          :aria-pressed="committed.classification === entry.code"
          @click="setClassification(committed.classification === entry.code ? 'all' : entry.code)"
        >
          <span class="size-1.5 rounded-full" :class="[
            entry.code === 'historical_conflict' ? 'bg-destructive' : entry.code === 'unresolved' ? 'bg-warning' : entry.code === 'historical_aligned' ? 'bg-success' : 'bg-muted-foreground',
          ]" aria-hidden="true" />
          {{ COMPARISON_CLASSES[entry.code] }}
          <span class="text-muted-foreground">{{ entry.count }}</span>
        </Button>
        <Button v-if="committed.classification !== 'all'" variant="ghost" size="sm" class="h-7 px-2 text-[13px]" @click="setClassification('all')">查看全部</Button>
      </div>
    <Card class="min-w-0 gap-0 py-0">
      <div v-if="submitted" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5" :class="sourcesExpanded && 'border-b'">
        <h2 class="shrink-0 text-sm font-medium">来源</h2>
        <p class="text-muted-foreground min-w-0 flex-1 text-[13px] leading-5">
          <span class="tabular-nums">{{ summaryCounts.official }} 份文件 · {{ summaryCounts.query }} 次查询</span>
          <span v-if="committed.asOf"> · 截止 {{ humanRecordTime(committed.asOf) }}</span>
          <span v-if="selectionChanged" class="text-warning"> · 选择已改，展开后重新对比</span>
        </p>
        <Button
          variant="ghost"
          size="sm"
          class="h-7 shrink-0 gap-1 px-2 text-[13px]"
          :aria-expanded="sourcesExpanded"
          @click="sourcesExpanded = !sourcesExpanded"
        >
          {{ sourcesExpanded ? '收起' : '展开修改' }}
          <ChevronDown class="size-4 transition-transform duration-150 ease-snap motion-reduce:transition-none" :class="!sourcesExpanded && '-rotate-90'" />
        </Button>
      </div>
      <div v-else class="flex items-center px-4 py-3 sm:px-5">
        <h2 class="text-sm font-medium">选择两侧来源</h2>
      </div>
      <!-- 折叠只收高度，不卸载表单：显式选择、目录 hydration 与返回滚动都依赖这些实例。 -->
      <div
        class="source-disclosure grid"
        :class="skipPanelTransition && 'source-disclosure-instant'"
        :style="{ gridTemplateRows: !submitted || sourcesExpanded ? '1fr' : '0fr' }"
        :inert="!!submitted && !sourcesExpanded"
      >
        <div class="min-h-0 overflow-hidden">
          <CardContent class="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
            <div class="flex min-w-0 flex-col gap-3">
              <section class="flex min-w-0 flex-col gap-2" aria-label="左侧正式文件">
                <header class="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 class="text-sm font-medium">正式文件</h3>
                  <span class="text-muted-foreground text-[13px] tabular-nums">已选 {{ selection.officialSourceDocumentIds.length }} / {{ catalogTotals.official_document ?? '—' }}</span>
                </header>
                <ComparisonSourcePicker :kind="'official_document'" :selection="selection" @change="setSelection" @catalog="setCatalogTotal" @sources="rememberSources" @settled="(key, ready) => setSourceReady('official', key, ready)" />
              </section>

              <section class="flex min-w-0 flex-col gap-2" aria-label="右侧平台查询">
                <header class="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 class="text-sm font-medium">平台查询</h3>
                  <span class="text-muted-foreground text-[13px] tabular-nums">已选 {{ selection.queryIds.length }} / {{ catalogTotals.query ?? '—' }}</span>
                </header>
                <ComparisonSourcePicker :kind="'query'" :selection="selection" @change="setSelection" @catalog="setCatalogTotal" @sources="rememberSources" @settled="(key, ready) => setSourceReady('query', key, ready)" />
              </section>

              <!--
                用原生 details：折叠时内容仍在 DOM 中，书签里的范围依据选择照常初始化、
                校验并参与滚动恢复；也不引入额外的展开动画帧。
              -->
              <details class="min-w-0 rounded-sm border">
                <summary class="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2.5">
                  <span class="text-[13px] font-medium">更多选项</span>
                  <span class="text-muted-foreground text-xs">截止时点 · 范围依据 · 导出版本 · 分类筛选</span>
                </summary>
                <div class="flex min-w-0 flex-col gap-3 border-t p-3">
                  <div class="flex max-w-full flex-col gap-1">
                    <Label for="record-as-of">截止时点（可选）</Label>
                    <ComparisonDateTimePicker id="record-as-of" v-model="asOfLocal" @validity-change="pickerValid = $event" />
                    <p class="text-muted-foreground text-xs">只影响对比结果的历史范围；不选则按当前数据。</p>
                  </div>
                  <ComparisonProofPicker :selection="selection" :as-of="asOfIso" @change="setProofIds" @settled="(key, ready) => { proofReadyKey = ready ? key : null }" />
                  <section class="flex min-w-0 flex-col gap-2 rounded-sm border p-3" aria-label="可选导出版本">
                    <header class="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 class="text-sm font-medium">导出版本（可选）</h3>
                      <span class="text-muted-foreground text-[13px] tabular-nums">已选 {{ selection.exportBatchIds.length }} / {{ catalogTotals.export_batch ?? '—' }}</span>
                    </header>
                    <p class="text-muted-foreground text-[13px]">导出版本只用于「已认定接口与导出版本」观察，不是开始对比的前提。</p>
                    <ComparisonSourcePicker :kind="'export_batch'" :selection="selection" @change="setSelection" @catalog="setCatalogTotal" @sources="rememberSources" />
                  </section>
                  <div class="flex max-w-full flex-col gap-1">
                    <Label for="record-classification">分类筛选</Label>
                    <Select :model-value="committed.classification" @update:model-value="setClassification">
                      <SelectTrigger id="record-classification" size="sm" class="w-full max-w-56" aria-label="按事件分类筛选"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部分类</SelectItem>
                          <SelectItem v-for="(label, code) in COMPARISON_CLASSES" :key="code" :value="code">{{ label }}</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <p class="text-muted-foreground text-xs">结果上方的结论胶囊是主入口；这里用于精确选择同一分类。</p>
                  </div>
                </div>
              </details>
            </div>

            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
              <Button :disabled="!canCompare || loading" :aria-busy="loading" @click="run">
                <RefreshCw v-if="loading" class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {{ loading ? '正在对比…' : '开始对比' }}
              </Button>
              <p v-if="!asOfValid" class="text-destructive text-[13px]">请填写有效的截止时点。</p>
              <p v-else-if="!canCompare" class="text-muted-foreground text-[13px]">{{ disabledReason }}</p>
              <p v-else-if="loading" class="text-muted-foreground text-[13px]">正在读取对比结果，完成后会在下方更新。</p>
              <p v-else-if="selectionChanged && displayed" class="text-muted-foreground text-[13px]">来源或截止时点已改，下方仍是上次结果；点「开始对比」更新。</p>
              <p v-else-if="!displayed" class="text-muted-foreground text-[13px]">已选择来源，点「开始对比」。</p>
              <p v-else-if="displayed" class="text-muted-foreground text-[13px]">结果已更新。</p>
            </div>
          </CardContent>
        </div>
      </div>
    </Card>

    <template v-if="submitted">
      <ComparisonResultScope v-if="loadedScope" aria-label="已加载结果范围" :scope="loadedScope" :labels="sourceLabels" :current="resultIsCurrent" :description="displayedScopeText" />
      <p v-if="displayed && !displayedIsTarget" class="text-muted-foreground rounded-sm border border-warning/40 bg-warning/5 p-3 text-[13px]" aria-label="目标结果范围">
        <strong class="text-foreground font-medium">当前目标范围：</strong>{{ targetScopeText }}。下方继续显示上次成功结果；目标加载成功后才替换。
      </p>

      <div class="flex min-w-0 flex-col gap-2" :aria-busy="loading" aria-label="对比结果">
        <h2
          ref="resultsHeader"
          class="scroll-mt-20 text-sm font-medium transition-colors duration-200 ease-snap motion-reduce:transition-none"
          :class="resultPulse && 'text-primary'"
        >{{ resultTitle }}</h2>
        <p v-if="loading" role="status" class="text-muted-foreground flex items-center gap-2 text-sm"><RefreshCw class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在对比，请稍候…</p>
        <TableFailureState v-if="error" title="记录级对比读取失败" :compact="!!displayed" :pending="loading" :description="displayed ? '本次目标未加载，下方保留上次成功的结果；范围见上方。' : '请核对所选来源是否仍可用，然后重试。'" @retry="load" />
        <Transition name="comparison-result" appear>
          <div v-if="displayed?.rows.length" :key="resultVersion" class="flex min-w-0 flex-col gap-2">
            <ComparisonEventRow v-for="row in displayed.rows" :key="row.event.id" :row="row" :return-to="returnTo" />
          </div>
        </Transition>
        <Empty v-if="!displayed?.rows.length && !loading && !error">
          <EmptyHeader>
            <EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia>
            <EmptyTitle>所选范围内没有可见正式事件</EmptyTitle>
            <EmptyDescription>这只说明当前选择和筛选没有返回事件；下方「其他来源记录」保留所选来源的查询覆盖与未对应接口原行。</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <TablePagination v-if="displayed" :page="shownPage" :page-size="displayed.pageSize" :total="displayed.total" unit="条事件" :loading="loading || error" @update:page="setPage" @update:page-size="setPageSize" />
      </div>

      <details v-if="displayed" class="min-w-0 rounded-sm border bg-card" data-testid="comparison-details">
        <summary class="cursor-pointer px-3 py-2.5 text-[13px] font-medium">其他来源记录</summary>
        <div class="min-w-0 border-t p-3">
          <ComparisonEvidence :result="displayed" :return-to="returnTo" />
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.source-disclosure { transition: grid-template-rows 180ms var(--ease-snap); }
.source-disclosure-instant { transition: none; }
.comparison-result-enter-active { animation: comparison-arrive 180ms ease-out; }
@keyframes comparison-arrive {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .source-disclosure { transition: none; }
  .comparison-result-enter-active { animation: none; }
}
</style>
