<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PLATFORM_QUERY_STATUSES } from '#sme-roster/lib/labels'
import { humanRecordTime } from '#sme-roster/lib/roster/record-ledger'
import {
  comparisonSourceEnterpriseDetails,
  comparisonSourceEnterpriseLine,
  comparisonSourceRawNameLine,
  comparisonSourceSecondaryIds,
  comparisonSourceTitle,
  comparisonSourceUnconfirmedLine,
} from '#sme-roster/lib/roster/record-comparison-display'
import { sourceSelectionKey, type ComparisonSelection, type ComparisonSource, type ComparisonSourceCatalog, type ComparisonSourceKind } from '#sme-roster/lib/roster/record-comparison-view'
import { Button } from '#core/app/components/ui/button'
import { Checkbox } from '#core/app/components/ui/checkbox'
import { Badge } from '#core/app/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'

const props = defineProps<{ selection: ComparisonSelection; kind?: ComparisonSourceKind }>()
const emit = defineEmits<{
  change: [selection: ComparisonSelection]
  settled: [selectionKey: string, ready: boolean]
  catalog: [kind: ComparisonSourceKind, total: number]
  sources: [rows: ComparisonSource[]]
}>()

const activeKind = ref<ComparisonSourceKind>(props.kind ?? 'official_document')
const fixedKind = computed(() => props.kind != null)
const page = ref(1)
const pageSize = ref(25)
const displayed = ref<ComparisonSourceCatalog | null>(null)
const displayedKind = ref<ComparisonSourceKind | null>(null)
const loading = ref(false)
const error = ref(false)
const selectedError = ref(false)
const cache = ref<Record<string, ComparisonSource>>({})
/** 目录默认只铺开少量行，给出一级「查看全部」入口；列表本身不在卡片内滚动。 */
const COLLAPSED_ROWS = 4
const showAll = ref(false)
const rows = computed(() => displayed.value?.rows ?? [])
/** 平台查询通常有十几条，默认只铺开前几条并给出「查看全部」入口；其他类别数量少，直接全列。 */
const collapsible = computed(() => activeKind.value === 'query')
const shownRows = computed(() => {
  if (!collapsible.value || showAll.value) return rows.value
  return rows.value.slice(0, COLLAPSED_ROWS)
})
const remainingCount = computed(() => Math.max(0, rows.value.length - shownRows.value.length))
const allLabel = computed(() => {
  const group = groups.find(item => item.kind === activeKind.value)?.shortLabel ?? '来源'
  return displayed.value && displayed.value.total > displayed.value.pageSize
    ? `展开本页全部 ${rows.value.length} 项${group}`
    : `查看全部 ${displayed.value?.total ?? 0} 个${group}`
})
let requestId = 0
let hydrationId = 0
const selectionKey = computed(() => JSON.stringify(props.selection))
const hydratedKey = ref<string | null>(null)
const visibleGroups = computed(() => props.kind ? groups.filter(group => group.kind === props.kind) : groups)
/** Return-scroll restoration waits for the selected labels, not for an optional catalog column to finish. */
const layoutReady = computed(() => !loading.value && hydratedKey.value === selectionKey.value)
watch([selectionKey, layoutReady], ([key, ready]) => emit('settled', key, ready), { immediate: true, flush: 'post' })
const keyOf = (source: Pick<ComparisonSource, 'kind' | 'id'>) => `${source.kind}:${source.id}`
const groups: { kind: ComparisonSourceKind; label: string; shortLabel: string }[] = [
  { kind: 'official_document', label: '正式公布文件', shortLabel: '正式文件' },
  { kind: 'query', label: '平台查询', shortLabel: '平台查询' },
  { kind: 'export_batch', label: '平台导出版本', shortLabel: '导出版本' },
]
const selectedItems = computed(() => visibleGroups.value.flatMap(group => props.selection[sourceSelectionKey(group.kind)].map(id => ({ kind: group.kind, id, source: cache.value[`${group.kind}:${id}`] }))))
const sourceStatus = (source: ComparisonSource) => source.kind === 'query'
  ? PLATFORM_QUERY_STATUSES[source.status] ?? '状态待核'
  : source.kind === 'export_batch' ? source.status === 'imported' ? '已导入' : '未完成导入'
  : '正式文件'
const sourceNote = (source: ComparisonSource) => source.kind === 'query'
  ? `${source.completeness === 'complete' ? '完整采集' : source.completeness === 'partial' ? '部分采集' : '完整性未知'} · ${source.fullRange ? '从首页查询' : '范围未证实'}${source.conditions?.combination === 'and' ? ' · 条件按且关系' : ''}`
  : source.kind === 'export_batch' ? `原行 ${source.rowCount} 条${source.replacedBatchId ? ' · 替换既有批次' : ''}`
  : source.subtitle ?? '未记录文号'
const observedAt = (source: ComparisonSource) => humanRecordTime(source.observedAt)
/** 平台查询用接口 + 称号 + 查询范围作主标题；SYN 查询键 / 信用代码退为次要信息。 */
const sourceTitle = (source: ComparisonSource) => comparisonSourceTitle(source)
const sourceSecondaryIds = (source: ComparisonSource) => comparisonSourceSecondaryIds(source)
const sourceEnterpriseLine = (source: ComparisonSource) => comparisonSourceEnterpriseLine(source)
const sourceRawNameLine = (source: ComparisonSource) => comparisonSourceRawNameLine(source)
const sourceUnconfirmedLine = (source: ComparisonSource) => comparisonSourceUnconfirmedLine(source)
const enterpriseDetails = (source: ComparisonSource) => comparisonSourceEnterpriseDetails(source)
/** 一对多可能很多：行内只给摘要，完整清单按需展开。 */
const expandedIdentities = ref<Record<string, boolean>>({})
const identityExpanded = (source: ComparisonSource) => expandedIdentities.value[keyOf(source)] === true
function toggleIdentity(source: ComparisonSource) {
  const key = keyOf(source)
  expandedIdentities.value = { ...expandedIdentities.value, [key]: !expandedIdentities.value[key] }
}
function selected(source: ComparisonSource) { return props.selection[sourceSelectionKey(source.kind)].includes(source.id) }
function toggle(source: ComparisonSource, checked: boolean) {
  if (!source.selectable) return
  const key = sourceSelectionKey(source.kind)
  const values = new Set(props.selection[key])
  if (checked) values.add(source.id)
  else values.delete(source.id)
  emit('change', { ...props.selection, [key]: [...values].sort((a, b) => a - b) })
}
async function load() {
  const requested = ++requestId
  loading.value = true
  error.value = false
  try {
    const result = await $fetch<ComparisonSourceCatalog>('/api/roster/record-comparison/sources', { query: { kind: activeKind.value, page: page.value, pageSize: pageSize.value } })
    if (requested !== requestId) return
    displayed.value = result
    displayedKind.value = activeKind.value
    emit('catalog', activeKind.value, result.total)
    for (const item of result.rows) cache.value[keyOf(item)] = item
    emit('sources', result.rows)
  } catch {
    if (requested === requestId) error.value = true
  } finally {
    if (requested === requestId) loading.value = false
  }
}
watch([activeKind, page, pageSize], () => { void load() }, { immediate: true })
watch(activeKind, () => { page.value = 1; showAll.value = false })
watch(() => props.kind, (kind) => {
  if (!kind) return
  activeKind.value = kind
  page.value = 1
  showAll.value = false
})
watch([page, pageSize], () => { showAll.value = false })

/** Restored comparison URLs still show business labels rather than bare source IDs. */
async function hydrateSelectedLabels() {
  const current = ++hydrationId
  const key = selectionKey.value
  const selection = props.selection
  hydratedKey.value = null
  selectedError.value = false
  for (const group of visibleGroups.value) {
    const missing = new Set(selection[sourceSelectionKey(group.kind)].filter(id => !cache.value[`${group.kind}:${id}`]))
    if (!missing.size) continue
    const selectedIds = [...missing].join(',')
    let catalogPage = 1
    try {
      while (missing.size) {
        const result = await $fetch<ComparisonSourceCatalog>('/api/roster/record-comparison/sources', { query: { kind: group.kind, page: catalogPage, pageSize: 200, ids: selectedIds } })
        if (current !== hydrationId) return
        for (const item of result.rows) { cache.value[keyOf(item)] = item; missing.delete(item.id) }
        emit('sources', result.rows)
        if (catalogPage * result.pageSize >= result.total) break
        catalogPage++
      }
    } catch { if (current !== hydrationId) return; selectedError.value = true /* The selected IDs remain intact; compare API validates the source set. */ }
    if (missing.size) selectedError.value = true
  }
  if (current === hydrationId) hydratedKey.value = key
}
watch(selectionKey, () => { void hydrateSelectedLabels() }, { immediate: true, flush: 'sync' })
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2" data-testid="record-comparison-source-picker" :aria-label="fixedKind ? `选择${groups.find(group => group.kind === activeKind)?.label ?? '来源'}` : '选择记录级对比来源'">
    <p v-if="!fixedKind" class="text-muted-foreground text-table">逐项选择正式文件、平台查询和导出版本。选择只限定本次分析范围，不表示文件覆盖完整或两个来源版本相同。</p>
    <Tabs v-if="!fixedKind" :model-value="activeKind" @update:model-value="activeKind = $event as ComparisonSourceKind">
      <TabsList class="h-auto w-full flex-wrap justify-start gap-1" aria-label="来源类别"><TabsTrigger v-for="group in groups" :key="group.kind" :value="group.kind">{{ group.label }} · {{ selection[sourceSelectionKey(group.kind)].length }}</TabsTrigger></TabsList>
    </Tabs>
    <TableLoadingStatus kind="comparison" :loading="loading" label="正在读取可选来源…" />
    <TableFailureState v-if="error" title="来源目录读取失败" :compact="!!displayed" :pending="loading" :description="displayed ? '仍显示上次成功的目录页，请重试当前目标。' : '请重试读取来源目录。'" @retry="load" />
    <p v-if="displayed && (displayedKind !== activeKind || displayed.page !== page)" class="text-muted-foreground text-table">目标目录尚未加载，下面保留上次成功的来源页。</p>
    <div v-if="shownRows.length" class="min-w-0 rounded-sm border" data-testid="source-catalog">
      <ul class="flex min-w-0 flex-col divide-y">
        <li v-for="source in shownRows" :key="keyOf(source)" class="flex min-w-0 items-start gap-3 p-2.5" :data-source-kind="source.kind" :data-source-id="source.id">
          <Checkbox :id="`source-${source.kind}-${source.id}`" :model-value="selected(source)" :disabled="!source.selectable" class="mt-0.5" :aria-label="`选择${sourceTitle(source)}`" @update:model-value="toggle(source, $event === true)" />
          <div class="min-w-0 flex-1">
            <label :for="`source-${source.kind}-${source.id}`" class="min-w-0 cursor-pointer break-words [overflow-wrap:anywhere]">
              <span class="block text-table font-medium">{{ sourceTitle(source) }}</span>
              <span class="text-muted-foreground block text-table" :title="sourceNote(source)">{{ observedAt(source) }}<span v-if="source.kind === 'query' && source.completeness === 'partial'"> · 部分采集</span><span v-else-if="source.kind === 'official_document' && source.subtitle"> · {{ source.subtitle }}</span></span>
              <template v-if="source.kind === 'query'">
                <span v-if="sourceEnterpriseLine(source)" class="block text-table" data-testid="source-enterprise-identity">{{ sourceEnterpriseLine(source) }}</span>
                <span v-if="sourceUnconfirmedLine(source)" class="text-muted-foreground block text-table" data-testid="source-unconfirmed-name">{{ sourceUnconfirmedLine(source) }}</span>
                <span v-if="sourceRawNameLine(source)" class="text-muted-foreground block text-table" data-testid="source-raw-name">{{ sourceRawNameLine(source) }}</span>
              </template>
              <span v-if="sourceSecondaryIds(source).length" class="text-muted-foreground block font-mono text-xs">
                {{ sourceSecondaryIds(source).join(' · ') }}
              </span>
            </label>
            <template v-if="source.kind === 'query' && enterpriseDetails(source).length > 3">
              <Button variant="link" size="sm" class="h-6 self-start px-1 text-table" :aria-expanded="identityExpanded(source)" @click="toggleIdentity(source)">
                {{ identityExpanded(source) ? '收起主体清单' : `查看全部 ${enterpriseDetails(source).length} 条主体信息` }}
              </Button>
              <ul v-if="identityExpanded(source)" class="text-muted-foreground mt-1 flex flex-col gap-0.5 text-table leading-5" data-testid="source-enterprise-details">
                <li v-for="detail in enterpriseDetails(source)" :key="detail" class="break-words [overflow-wrap:anywhere]">{{ detail }}</li>
              </ul>
            </template>
          </div>
          <Badge variant="outline" class="shrink-0">{{ sourceStatus(source) }}</Badge>
        </li>
      </ul>
    </div>
    <p v-else-if="!loading && !error" class="text-muted-foreground text-table">此类别尚无可选来源。</p>
    <Button v-if="remainingCount > 0 && !showAll" variant="link" size="sm" class="h-7 self-start px-1 text-table" @click="showAll = true">{{ allLabel }}<span aria-hidden="true">（还有 {{ remainingCount }} 项）</span></Button>
    <Button v-else-if="showAll && rows.length > COLLAPSED_ROWS" variant="link" size="sm" class="h-7 self-start px-1 text-table" @click="showAll = false">收起，只看前 {{ COLLAPSED_ROWS }} 项</Button>
    <!-- 只有超过一页时才出现分页；目录本身不再使用内层滚动。 -->
    <TablePagination v-if="displayed && displayed.total > displayed.pageSize" :page="displayed.page" :page-size="displayed.pageSize" :total="displayed.total" unit="项来源" :loading="loading || error" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
    <DisclosurePanel v-if="selectedItems.length" compact content-class="pb-0" aria-label="已选来源" class="text-table">
      <template #trigger>
        <span class="text-muted-foreground text-table">管理已选来源（{{ selectedItems.length }}）</span>
      </template>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <Button v-for="item in selectedItems" :key="`${item.kind}:${item.id}`" variant="secondary" size="sm" class="h-auto max-w-full whitespace-normal text-left text-xs" :aria-label="`移除${item.source ? sourceTitle(item.source) : '已选来源'}`" @click="item.source ? toggle(item.source, false) : emit('change', { ...selection, [sourceSelectionKey(item.kind)]: selection[sourceSelectionKey(item.kind)].filter(id => id !== item.id) })">{{ item.source ? sourceTitle(item.source) : (selectedError ? '来源名称暂不可读' : '正在读取来源名称…') }} · 移除</Button>
      </div>
    </DisclosurePanel>
    <Button v-if="selectedError" variant="outline" size="sm" class="self-start" @click="hydrateSelectedLabels">重试读取已选来源名称</Button>
  </section>
</template>
