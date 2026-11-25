<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { FileText, ListFilter, Plus } from '@lucide/vue'
import ActiveFilterBar from '#core/app/components/ActiveFilterBar.vue'
import DataTableCard from '#core/app/components/DataTableCard.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'
import TablePagination from '#core/app/components/TablePagination.vue'
import { Button } from '#core/app/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import { Field, FieldLabel } from '#core/app/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '#core/app/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#core/app/components/ui/table'
import type { LeadCatalog } from '../../lib/contracts'
import LeadListFacetBrowser from './LeadListFacetBrowser.vue'

const props = defineProps<{ catalog?: LeadCatalog; loading: boolean; failed: boolean }>()
const emit = defineEmits<{ register: []; retry: [] }>()
const route = useRoute()
const router = useRouter()
const viewport = useTemplateRef('catalog-rows')
const facetGroup = ref<FacetKey>('channel')
const showDrawer = ref(false)
const wide = useMediaQuery('(min-width: 64rem)')
watch(wide, value => { if (value) showDrawer.value = false })

const fields = [
  { key: 'listType', label: '名单类型', allLabel: '全部类型' },
  { key: 'channel', label: '名单来源', allLabel: '全部来源' },
  { key: 'series', label: '所属系列', allLabel: '全部系列' },
] as const
type FilterKey = typeof fields[number]['key']
type FacetKey = Exclude<FilterKey, 'series'>
const all = ':all'
const filterValue = (value: string) => value ? `value:${value}` : all

function queryText(key: string) {
  const value = route.query[key]
  return typeof value === 'string' ? value : ''
}

function positiveInteger(key: string, fallback: number) {
  const raw = queryText(key)
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : fallback
}

const selected = computed(() => ({
  listType: queryText('listType'),
  channel: queryText('channel'),
  series: queryText('series'),
}))
const hasFilters = computed(() => Object.values(selected.value).some(Boolean))
const versions = computed(() => props.catalog?.versions ?? [])
const showFilters = computed(() => versions.value.length > 0 || hasFilters.value)
const labels = computed<Record<FilterKey, Map<string, string>>>(() => ({
  listType: new Map(props.catalog?.listTypes.map(item => [item.code, item.name])),
  channel: new Map(props.catalog?.channels.map(item => [item.code, item.name])),
  series: new Map(),
}))
const label = (key: FilterKey, code: string) => labels.value[key].get(code) ?? code
function optionsFor(key: FilterKey) {
  return [...new Set([...versions.value.map(item => item[key]), selected.value[key]].filter(Boolean))]
    .map(value => ({ value, label: label(key, value) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
}
const seriesOptions = computed(() => optionsFor('series'))
const facetFields = fields.filter(field => field.key !== 'series')
const isMatch = (item: LeadCatalog['versions'][number], except?: FacetKey) =>
  fields.every(({ key }) => key === except || !selected.value[key] || item[key] === selected.value[key])
const facets = computed(() => facetFields.map(field => {
  let total = 0
  const counts = new Map<string, number>()
  for (const item of versions.value) {
    if (!isMatch(item, field.key)) continue
    total++
    const key = item[field.key]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return {
    ...field, total,
    values: optionsFor(field.key).map(option => ({ ...option, count: counts.get(option.value) ?? 0 })),
  }
}))
const activeFacets = computed(() => fields.filter(field => selected.value[field.key])
  .map(field => ({ key: field.key, label: `${field.label}：${label(field.key, selected.value[field.key])}` })))
/** 已生效条件：类型、来源与系列都摊成一行 chip，系列没有常驻 chip 控件也照样可撤。 */
const catalogChips = computed(() => activeFacets.value)

const filtered = computed(() => versions.value
  .filter(item => isMatch(item))
  .sort((a, b) => b.acquiredOn.localeCompare(a.acquiredOn) || b.id - a.id))
const pageSize = computed(() => Math.min(200, positiveInteger('pageSize', 25)))
const page = computed(() => Math.min(positiveInteger('page', 1), Math.max(1, Math.ceil(filtered.value.length / pageSize.value))))
const rows = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))

function update(query: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...query } })
}
function setFilter(key: FilterKey, value: string) {
  update({ [key]: value || undefined, page: undefined })
}
function setSeries(value: unknown) {
  if (typeof value !== 'string') return
  if (value === all) setFilter('series', '')
  else if (value.startsWith('value:')) setFilter('series', value.slice('value:'.length))
}
function clearFilters() {
  update({ series: undefined, channel: undefined, listType: undefined, page: undefined })
}

watch([page, pageSize, () => selected.value.series, () => selected.value.channel, () => selected.value.listType],
  () => viewport.value?.scrollTo({ top: 0 }), { flush: 'post' })
watch(() => route.query.version, async (version, previous) => {
  if (version || typeof previous !== 'string' || !/^[1-9]\d*$/.test(previous)) return
  await nextTick()
  if (route.query.version) return
  viewport.value?.querySelector<HTMLElement>(`[data-lead-version="${previous}"]`)?.focus({ preventScroll: true })
}, { flush: 'post' })
</script>

<template>
  <!-- 宽屏「目录栏 | 结果卡」双栏；窄屏目录收进工具栏的筛选抽屉，侧栏整列隐藏。 -->
  <div
    class="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)]"
    :class="showFilters && 'lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)]'"
  >
    <aside v-if="showFilters" aria-label="名单筛选侧栏" class="hidden min-h-0 min-w-0 flex-col border-r lg:flex">
      <LeadListFacetBrowser v-model:group="facetGroup" :groups="facets" :selected="selected" @select="setFilter" />
    </aside>

    <DataTableCard toolbar-class="gap-2">
    <template #toolbar>
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <Sheet v-if="showFilters" v-model:open="showDrawer">
          <SheetTrigger as-child>
            <Button type="button" variant="outline" size="sm" class="lg:hidden"><ListFilter aria-hidden="true" />筛选</Button>
          </SheetTrigger>
          <SheetContent side="left" class="w-11/12 min-w-0 gap-0 sm:max-w-sm">
            <SheetHeader class="shrink-0 border-b px-4 py-4">
              <SheetTitle>名单筛选</SheetTitle>
              <SheetDescription class="sr-only">按名单来源和类型筛选</SheetDescription>
            </SheetHeader>
            <LeadListFacetBrowser v-model:group="facetGroup" :groups="facets" :selected="selected" @select="setFilter" />
            <div class="shrink-0 border-t p-3">
              <Button type="button" class="w-full" @click="showDrawer = false">查看 {{ filtered.length.toLocaleString('zh-CN') }} 份名单</Button>
            </div>
          </SheetContent>
        </Sheet>
        <Field v-if="showFilters" class="max-w-52 min-w-0 flex-1 gap-0">
          <FieldLabel for="lead-catalog-series" class="sr-only">所属系列</FieldLabel>
          <Select :model-value="filterValue(selected.series)" @update:model-value="setSeries">
            <SelectTrigger id="lead-catalog-series" size="sm" class="w-full min-w-0 *:data-[slot=select-value]:min-w-0" aria-label="所属系列">
              <SelectValue />
            </SelectTrigger>
            <SelectContent class="max-w-(--reka-select-content-available-width)">
              <SelectItem :value="all">全部系列</SelectItem>
              <SelectItem v-for="option in seriesOptions" :key="option.value" :value="filterValue(option.value)">
                <span class="min-w-0 wrap-anywhere">{{ option.label }}</span>
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Button type="button" size="sm" class="ml-auto shrink-0" @click="emit('register')"><Plus aria-hidden="true" />新增名单</Button>
      </div>
      <ActiveFilterBar
        aria-label="已选名单筛选条件"
        :items="catalogChips"
        @remove="key => setFilter(key as FilterKey, '')"
        @clear="clearFilters"
      />
    </template>

    <template #status>
      <TableLoadingStatus kind="ledger" :loading="loading" label="正在读取名单目录…" />
    </template>

    <TableFailureState
      v-if="failed" title="名单目录加载失败" :compact="Boolean(catalog)"
      :description="catalog ? '仍显示上次读取的名单目录。' : undefined"
      :pending="loading" @retry="emit('retry')"
    />
    <div v-if="rows.length" ref="catalog-rows" class="data-table-scroll @container" role="region" aria-label="名单目录" tabindex="0">
      <Table class="data-table table-fixed min-w-0" aria-label="名单目录">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">名单</TableHead>
            <TableHead scope="col" class="hidden w-36 @min-[36rem]:table-cell @min-[55rem]:w-[19%]">名单类型</TableHead>
            <TableHead scope="col" class="hidden w-36 @min-[36rem]:table-cell @min-[55rem]:w-[19%]">名单来源</TableHead>
            <TableHead scope="col" class="hidden w-30 @min-[36rem]:table-cell">获取日期</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="item in rows" :key="item.id">
            <TableCell class="whitespace-normal wrap-anywhere">
              <Button variant="link" as-child class="h-auto max-w-full justify-start p-0 text-left whitespace-normal">
                <NuxtLink
                  :to="{ query: { ...route.query, version: String(item.id), exportJob: undefined } }"
                  :data-lead-version="item.id"
                  :aria-label="`查看名单：${item.series}，${item.acquiredOn}，${item.fileName}`"
                >{{ item.series }}</NuxtLink>
              </Button>
              <p class="text-muted-foreground">{{ item.fileName }}</p>
              <dl class="mt-1 flex flex-wrap gap-x-4 gap-y-1 @min-[36rem]:hidden">
                <div class="flex flex-wrap gap-x-1"><dt class="text-muted-foreground">类型</dt><dd>{{ label('listType', item.listType) }}</dd></div>
                <div class="flex flex-wrap gap-x-1"><dt class="text-muted-foreground">来源</dt><dd>{{ label('channel', item.channel) }}</dd></div>
                <div class="flex basis-full flex-wrap gap-x-1"><dt class="text-muted-foreground">获取日期</dt><dd><time :datetime="item.acquiredOn">{{ item.acquiredOn }}</time></dd></div>
              </dl>
            </TableCell>
            <TableCell class="hidden whitespace-normal wrap-anywhere @min-[36rem]:table-cell">{{ label('listType', item.listType) }}</TableCell>
            <TableCell class="hidden whitespace-normal wrap-anywhere @min-[36rem]:table-cell">{{ label('channel', item.channel) }}</TableCell>
            <TableCell class="hidden tabular-nums @min-[36rem]:table-cell"><time :datetime="item.acquiredOn">{{ item.acquiredOn }}</time></TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <Empty v-else-if="catalog">
      <EmptyHeader>
        <EmptyMedia variant="icon"><FileText aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>{{ hasFilters ? '没有符合条件的名单' : '还没有名单' }}</EmptyTitle>
      </EmptyHeader>
    </Empty>

    <template #footer>
      <TablePagination
        v-if="filtered.length" in-card :page="page" :page-size="pageSize" :total="filtered.length" unit="份"
        @update:page="update({ page: String($event) })"
        @update:page-size="update({ pageSize: String($event), page: undefined })"
      />
    </template>
    </DataTableCard>
  </div>
</template>
