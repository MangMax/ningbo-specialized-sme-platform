<script setup lang="ts">
import { useQuery, useQueryCache } from '@pinia/colada'
import { computed, ref, type Ref } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, FolderUp, Search } from '@lucide/vue'
import {
  CATEGORY_STATE_ORDER,
  CATEGORY_STATES,
  KINDS,
  PARSE_STATE_ORDER,
  PARSE_STATES,
  SOURCES,
  SOURCE_ORDER,
} from '~~/lib/labels'
import { formatBytes } from '~~/lib/upload'
import { fileUrl } from '~~/lib/preview'
import { joinSeries, partBatches, partYears } from '~~/lib/file-parts'
import type { BackfillReport, StoredFileRow } from '~~/server/utils/stored-files'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import EditFileDialog, { type MetadataForm } from '@/components/files/EditFileDialog.vue'
import DeleteFileDialog from '@/components/files/DeleteFileDialog.vue'

/**
 * 文件管理页(票 09;段的展示是票 17):统一管理文件库(`files/`)里的**全部**文件。
 *
 * 这一页管的是**文件**,不是记录 —— 台账页管记录。所以每行是「一个文件在磁盘上是什么、
 * 被归成哪一类、里面含哪些段、被哪些记录引用」,行操作是编元数据 / 预览 / 移出库。
 *
 * **年份 / 批次两列显示的是文件内容里的段**(票 17:一份文件常含多年份、多事件,
 * 如 192号 同时含「认定 2024/2」与「复核 2021/2」),所以列头写「内容年份」「内容批次」,
 * 与旁边文件级的**「公布年份/批次」**(目录给的、单值)一眼分得开。值多时列里只平铺前两个、
 * 其余折成 `+N 年`,完整清单在展开的段明细里。行可展开看段(称号 / 事件 / 年份 / 批次 / 附件 / 行数)。
 *
 * 筛选全部走**多选**(与台账页同一套 `MultiSelectFilter`),因为「同时看经信局的
 * 已分类和待分类」是常见的;单选下拉会把这种组合挡掉。生效条件同台账一样摊成一行 chip。
 */

const apiGet = $fetch as unknown as <T>(
  url: string,
  opts?: { query?: Record<string, unknown> },
) => Promise<T>

interface FilesResponse {
  rows: StoredFileRow[]
  total: number
  /** 只在真的跑过回填的那一次请求里出现(形状与接口共用一处)。 */
  backfill?: BackfillReport
}

const queryCache = useQueryCache()

// —— 筛选(多选)——
const sources = ref<string[]>([])
const categoryStates = ref<string[]>([])
const parseStates = ref<string[]>([])
const search = ref('')
const q = ref('')
watchDebounced(
  search,
  (v) => {
    q.value = v.trim()
    page.value = 1
  },
  { debounce: 300 },
)

// —— 分页 ——
const PAGE_SIZE_PRESETS = [25, 50, 100, 200]
const MAX_PAGE_SIZE = 200
const page = ref(1)
const pageSize = ref(50)

const params = computed(() => ({
  source: sources.value.join(',') || undefined,
  categoryState: categoryStates.value.join(',') || undefined,
  parseState: parseStates.value.join(',') || undefined,
  q: q.value || undefined,
  page: page.value,
  pageSize: pageSize.value,
}))

const { data, isLoading } = useQuery({
  key: () => ['files', params.value],
  query: () => apiGet<FilesResponse>('/api/files', { query: params.value }),
  // 换筛选/翻页时保留上一批数据,避免表体清空 → 文档高度骤变 → 页面闪一下并跳回顶部。
  placeholderData: (previous) => previous,
})

const rows = computed<StoredFileRow[]>(() => data.value?.rows ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

const sourceOptions = computed(() =>
  SOURCE_ORDER.map((k) => ({ value: k, label: SOURCES[k] ?? k })),
)
const categoryOptions = computed(() =>
  CATEGORY_STATE_ORDER.map((k) => ({ value: k, label: CATEGORY_STATES[k] ?? k })),
)
const parseOptions = computed(() =>
  PARSE_STATE_ORDER.map((k) => ({ value: k, label: PARSE_STATES[k] ?? k })),
)

function refresh() {
  return queryCache.invalidateQueries({ key: ['files'] })
}

/** 任一筛选变化 → 回第一页。 */
function onFilterChange() {
  page.value = 1
}

function clearFilters() {
  sources.value = []
  categoryStates.value = []
  parseStates.value = []
  search.value = ''
  q.value = ''
  page.value = 1
}

const hasFilters = computed(
  () =>
    sources.value.length > 0 ||
    categoryStates.value.length > 0 ||
    parseStates.value.length > 0 ||
    Boolean(q.value),
)

interface ActiveFilter {
  key: string
  label: string
  clear: () => void
}

/** 一组多选筛选 → 生效条件 chip:每项可单独从对应 ref 里撤掉。与台账页同一套。 */
function multiChips(
  values: string[],
  keyPrefix: string,
  labelPrefix: string,
  target: Ref<string[]>,
  format: (v: string) => string = (v) => v,
): ActiveFilter[] {
  return values.map((v) => ({
    key: `${keyPrefix}:${v}`,
    label: `${labelPrefix} · ${format(v)}`,
    clear: () => (target.value = target.value.filter((x) => x !== v)),
  }))
}

/**
 * 生效中的条件摊平成一行。按钮上只写得出「分类 ·2」,看不出勾的到底是哪两项 ——
 * 与台账页同一条规矩:筛选生效了就把它摊开写出来,每项单独可撤。
 */
const activeFilters = computed<ActiveFilter[]>(() => [
  ...multiChips(sources.value, 'source', '来源', sources, (v) => SOURCES[v] ?? v),
  ...multiChips(categoryStates.value, 'category', '分类', categoryStates, (v) => CATEGORY_STATES[v] ?? v),
  ...multiChips(parseStates.value, 'parse', '解析', parseStates, (v) => PARSE_STATES[v] ?? v),
  ...(q.value
    ? [
        {
          key: 'q',
          label: `搜索 · ${q.value}`,
          clear: () => {
            search.value = ''
            q.value = ''
          },
        },
      ]
    : []),
])

// —— 行操作 ——
const editing = ref<StoredFileRow | null>(null)
const editOpen = ref(false)
const editPending = ref(false)
const editFailure = ref('')

const deleting = ref<StoredFileRow | null>(null)
const deleteOpen = ref(false)
const deletePending = ref(false)
const deleteFailure = ref('')

const previewOpen = ref(false)
const previewFile = ref<StoredFileRow | null>(null)

function openEdit(row: StoredFileRow) {
  editing.value = row
  editFailure.value = ''
  editOpen.value = true
}

function openDelete(row: StoredFileRow) {
  deleting.value = row
  deleteFailure.value = ''
  deleteOpen.value = true
}

function openPreview(row: StoredFileRow) {
  previewFile.value = row
  previewOpen.value = true
}

/** 保存元数据:只提交分类字段;空串转为 null 表示「清空」。 */
async function saveMetadata(form: MetadataForm) {
  if (!editing.value) return
  editPending.value = true
  editFailure.value = ''
  const nullable = (v: string) => (v.trim() ? v.trim() : null)
  const yearText = form.year.trim()
  const batchText = form.batch.trim()
  try {
    await $fetch(`/api/files/${editing.value.id}`, {
      method: 'PATCH',
      body: {
        source: nullable(form.source),
        kind: nullable(form.kind),
        year: yearText ? Number(yearText) : null,
        batch: batchText ? Number(batchText) : null,
        titleCode: nullable(form.titleCode),
      },
    })
    editOpen.value = false
    await refresh()
  } catch (error) {
    editFailure.value = describeFetchError(error)
  } finally {
    editPending.value = false
  }
}

async function confirmDelete(deleteDisk: boolean) {
  if (!deleting.value) return
  deletePending.value = true
  deleteFailure.value = ''
  try {
    await $fetch(`/api/files/${deleting.value.id}`, {
      method: 'DELETE',
      query: deleteDisk ? { deleteDisk: '1' } : {},
    })
    deleteOpen.value = false
    await refresh()
  } catch (error) {
    deleteFailure.value = describeFetchError(error)
  } finally {
    deletePending.value = false
  }
}

/** 取 $fetch 抛出的错误里那句服务端说明;认不出来给一句能指导下一步的话。 */
function describeFetchError(error: unknown): string {
  const err = error as { statusMessage?: string; data?: { message?: string; statusMessage?: string }; message?: string }
  return err?.data?.message ?? err?.data?.statusMessage ?? err?.statusMessage ?? '操作失败,请重试。'
}

const sizeOf = (row: StoredFileRow) => formatBytes(row.bytes)
const previewSrc = computed(() =>
  previewFile.value ? fileUrl(previewFile.value.relPath) : '',
)

const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-20 h-9 text-xs font-medium'

function setPage(n: number) {
  page.value = Math.min(Math.max(1, n), totalPages.value)
}
function setPageSize(n: number) {
  pageSize.value = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(n) || 50))
  page.value = 1
}

/** 元数据是否三项都齐 —— 决定「待分类」要不要显眼。 */
const isComplete = (row: StoredFileRow) => row.source !== null && row.kind !== null

// —— 段(票 17)——
/**
 * 展开的行。**可多行同时展开** —— 验收时要并排比两份文件的段(如 192号 与 145号),
 * 单开(手风琴)会把前一份收起来。
 */
const expandedIds = ref<number[]>([])
const isExpanded = (id: number) => expandedIds.value.includes(id)
function toggleParts(id: number) {
  expandedIds.value = isExpanded(id)
    ? expandedIds.value.filter((x) => x !== id)
    : [...expandedIds.value, id]
}

/**
 * 「内容年份 / 内容批次」列的展示值:**文件内容**里各段去重后的年份(如 `2021、2024`)。
 *
 * 列窄,值可以很多(工信部导出表跨 2021–2026 六个年份、四个批次)。所以只平铺前 2 个,
 * 其余折成 `+4年` / `+4批` —— 带上单位才读得懂「还剩几个」;只写 `+4` 看不出那是什么,
 * 直接截断又让人以为年份就这么多。完整清单在展开的段明细里,悬停 `title` 也能看全。
 *
 * `+4年` 里不留空格:这一列的量过的上限就是 `2021、2022 +4年`(98.6px),加空格会把
 * 「+4年」挤出列宽、只剩省略号 —— 那就等于没写。
 */
const SERIES_HEAD = 2
function seriesCell(values: readonly number[], unit: string) {
  if (!values.length) return null
  const rest = values.length - SERIES_HEAD
  return {
    head: joinSeries(values.slice(0, SERIES_HEAD))!,
    more: rest > 0 ? `+${rest}${unit}` : '',
  }
}
const contentYears = (row: StoredFileRow) => seriesCell(partYears(row.parts), '年')
const contentBatches = (row: StoredFileRow) => seriesCell(partBatches(row.parts), '批')
/** 完整清单进 `title` —— 列里只平铺前两个,悬停能看到全部。 */
const contentYearsTitle = (row: StoredFileRow) => joinSeries(partYears(row.parts)) ?? undefined
const contentBatchesTitle = (row: StoredFileRow) => joinSeries(partBatches(row.parts)) ?? undefined
/** 「公布年份/批次」列:文件级**单值**(目录给的),形如 `2024 / 2`、`2024`、`—`。 */
function publishedYearBatch(row: StoredFileRow): string {
  if (row.year == null) return '—'
  return row.batch == null ? String(row.year) : `${row.year} / ${row.batch}`
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader
      class="rise-in"
      style="--rise-index: 0"
      title="文件管理"
      description="文件库里的全部来源文件;展开任意一行看它含哪些段。"
    >
      <template #actions>
        <!-- 上传接 tus 是票 10 的事,这里先把入口占住。禁用态不用 tooltip 说明原因 ——
             「通道未接入」这类话属于制作说明,不该写进界面;理由放 title,悬停才有。 -->
        <Button variant="outline" size="sm" disabled title="上传通道尚未接入">
          <FolderUp />
          上传
        </Button>
      </template>
    </PageHeader>

    <!-- 工具栏:搜索 + 三个多选筛选。左侧筛,右侧只报当前条数。 -->
    <div class="rise-in flex flex-wrap items-center gap-2" style="--rise-index: 1">
      <div class="relative min-w-56 flex-1 sm:max-w-xs">
        <Search
          class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input v-model="search" class="bg-card h-8 pl-8" placeholder="搜索文件名" />
      </div>

      <Separator orientation="vertical" class="hidden h-5 sm:block" />

      <MultiSelectFilter
        v-model="sources"
        :options="sourceOptions"
        placeholder="全部来源"
        summary-prefix="来源"
        class="w-28"
        @update:model-value="onFilterChange"
      />
      <MultiSelectFilter
        v-model="categoryStates"
        :options="categoryOptions"
        placeholder="全部分类状态"
        summary-prefix="分类"
        class="w-32"
        @update:model-value="onFilterChange"
      />
      <MultiSelectFilter
        v-model="parseStates"
        :options="parseOptions"
        placeholder="全部解析状态"
        summary-prefix="解析"
        class="w-32"
        @update:model-value="onFilterChange"
      />

      <span class="text-muted-foreground ml-auto text-xs tabular-nums">
        符合条件
        <span class="text-foreground font-medium">{{ total.toLocaleString('zh-CN') }}</span> 个文件
      </span>
    </div>

    <!-- 生效中的条件摊开写出来:光看下拉按钮看不出到底勾了哪几项。与台账页同一行样式。 -->
    <TransitionGroup
      v-if="activeFilters.length"
      tag="div"
      class="flex flex-wrap items-center gap-1.5"
      enter-active-class="transition duration-150 ease-snap"
      enter-from-class="scale-90 opacity-0"
      leave-active-class="transition duration-100 ease-snap"
      leave-to-class="scale-90 opacity-0"
      move-class="transition duration-150 ease-snap"
    >
      <FilterChip v-for="f in activeFilters" :key="f.key" :label="f.label" @remove="f.clear()" />
      <Button
        v-if="activeFilters.length > 1"
        variant="ghost"
        size="sm"
        class="text-muted-foreground h-6 px-1.5 text-xs"
        @click="clearFilters"
      >
        清除全部
      </Button>
    </TransitionGroup>

    <Card class="rise-in gap-0 overflow-hidden py-0" style="--rise-index: 2">
      <CardContent class="p-0">
        <div
          class="max-h-[max(320px,calc(100dvh-17rem))] overflow-auto [&_[data-slot=table-container]]:overflow-visible"
        >
          <!-- 12 列。列宽是按**实测文字宽度**定的:下限宽度取「1440 宽屏下(侧栏展开)刚好
               不横滚」的值 —— 超了就会把最右边的行操作推出视野,而编辑/预览/移出正是这一页
               最常做的事。窄屏照旧横向滚动,不把文件名挤没。
               文件名留 219px:刚好放下「甬经信中小〔2026〕101号关于…」,截断点落在文号之后,
               邻近的两份文件才不会截成同一个样子。
               `table-fixed`:列宽按表头的 w-* 逐列算,宽屏下也不会某一列吃满剩余空间。 -->
          <Table class="min-w-[1118px] table-fixed">
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead :class="[TH_CLASS, 'w-8']">
                  <span class="sr-only">展开段</span>
                </TableHead>
                <TableHead :class="[TH_CLASS, 'w-[209px]']">文件名</TableHead>
                <TableHead :class="[TH_CLASS, 'w-[81px]']">来源</TableHead>
                <TableHead :class="[TH_CLASS, 'w-[72px]']">类别</TableHead>
                <TableHead
                  :class="[TH_CLASS, 'w-[92px]']"
                  title="目录给出的公布年份/批次 —— 这份文件是哪一批公布的(单值)"
                >
                  公布年份/批次
                </TableHead>
                <TableHead
                  :class="[TH_CLASS, 'w-[132px]']"
                  title="文件内容里各段的年份(可多个);复核段记的是被复核的原认定年份"
                >
                  内容年份
                </TableHead>
                <TableHead :class="[TH_CLASS, 'w-[84px]']" title="文件内容里各段的批次(可多个)">
                  内容批次
                </TableHead>
                <TableHead :class="[TH_CLASS, 'w-[76px]']">分类状态</TableHead>
                <TableHead :class="[TH_CLASS, 'w-[76px]']">解析状态</TableHead>
                <TableHead :class="[TH_CLASS, 'w-[56px] text-right']">被引用</TableHead>
                <TableHead :class="[TH_CLASS, 'w-[70px] text-right']">大小</TableHead>
                <TableHead :class="[TH_CLASS, 'w-[138px]']">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-if="isLoading && rows.length === 0" class="hover:bg-transparent">
                <TableCell :colspan="12" class="p-0">
                  <div class="flex flex-col">
                    <div
                      v-for="i in 8"
                      :key="i"
                      class="flex h-11 items-center gap-3 border-b px-3 last:border-b-0"
                    >
                      <Skeleton class="h-4 flex-1" />
                      <Skeleton class="h-5 w-16 rounded-sm" />
                      <Skeleton class="h-4 w-12" />
                      <Skeleton class="h-5 w-16 rounded-sm" />
                    </div>
                  </div>
                </TableCell>
              </TableRow>

              <template v-else-if="rows.length">
                <template v-for="row in rows" :key="row.id">
                  <TableRow class="hover:bg-accent/70 h-11">
                    <TableCell class="pr-0">
                      <Button
                        v-if="row.parts.length"
                        variant="ghost"
                        size="icon"
                        class="size-7"
                        :aria-expanded="isExpanded(row.id)"
                        :title="`展开 ${row.parts.length} 段明细`"
                        @click="toggleParts(row.id)"
                      >
                        <ChevronRight
                          class="size-4 transition-transform duration-150"
                          :class="isExpanded(row.id) && 'rotate-90'"
                        />
                        <span class="sr-only">展开段明细</span>
                      </Button>
                      <span
                        v-else
                        class="text-muted-foreground/60 inline-block w-6 text-center text-xs"
                        title="还没有段(尚未解析)"
                        >—</span
                      >
                    </TableCell>
                    <TableCell class="w-[209px]">
                      <!-- 只写文件名。先前下面还压了一行 `rel_path`,但它对每行都截在同一个
                           位置(`jxj/announcement/2026/1/甬经信中小〔20…`),既分不出文件、
                           又占掉一行高。路径没丢:悬停这里能看到完整的文件名 + 库内路径,
                           编辑弹窗里也有单独一块只读路径。
                           `block` 不能省:行内元素的 overflow 不生效,不加就会顶出去压住右边列。 -->
                      <span
                        class="block truncate font-medium"
                        :title="`${row.filename}\n${row.relPath}`"
                      >
                        {{ row.filename }}
                      </span>
                    </TableCell>
                    <TableCell>
                      <!-- 方标 = 来源语言:经信局藏青、工信部金色(与台账页同一个 SourceChip)。
                           写成一个灰底 Badge 就看不出哪份是国家级名单了。 -->
                      <SourceChip v-if="row.source" :code="row.source" />
                      <span v-else class="text-muted-foreground text-xs">—</span>
                    </TableCell>
                    <TableCell class="text-muted-foreground text-xs">
                      <!-- 类别是低信息量的属性(公布文件/导出表),写成正文色小字即可。
                           一行里已经有来源方标 + 两个状态徽章,再挂一个同形的徽章只是噪音。 -->
                      <span class="block truncate">{{ row.kind ? KINDS[row.kind] : '—' }}</span>
                    </TableCell>
                    <!-- 公布年份/批次:文件级单值(目录给的),退到次级色 —— 内容年份才是要读的信息。 -->
                    <TableCell class="text-muted-foreground text-xs tabular-nums">
                      {{ publishedYearBatch(row) }}
                    </TableCell>
                    <!-- 内容年份:文件**内容**含哪几年(如 2021、2024)。超过两个折成 `+N 年`。 -->
                    <TableCell
                      class="truncate text-xs font-medium tabular-nums"
                      :title="contentYearsTitle(row)"
                    >
                      <template v-if="contentYears(row)">
                        {{ contentYears(row)!.head
                        }}<span
                          v-if="contentYears(row)!.more"
                          class="text-muted-foreground ml-1 font-normal"
                        >
                          {{ contentYears(row)!.more }}</span
                        >
                      </template>
                      <span v-else class="text-muted-foreground font-normal">—</span>
                    </TableCell>
                    <TableCell class="truncate text-xs tabular-nums" :title="contentBatchesTitle(row)">
                      <template v-if="contentBatches(row)">
                        {{ contentBatches(row)!.head
                        }}<span
                          v-if="contentBatches(row)!.more"
                          class="text-muted-foreground ml-1"
                        >
                          {{ contentBatches(row)!.more }}</span
                        >
                      </template>
                      <span v-else class="text-muted-foreground">—</span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        :variant="row.categoryState === 'set' ? 'quiet' : 'dashed'"
                        :title="
                          row.categoryState === 'unset' && !isComplete(row)
                            ? '来源或类别未填全'
                            : undefined
                        "
                      >
                        {{ CATEGORY_STATES[row.categoryState] }}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge :variant="row.parseState === 'failed' ? 'destructive' : 'quiet'">
                        {{ PARSE_STATES[row.parseState] }}
                      </Badge>
                    </TableCell>
                    <TableCell class="text-right text-xs tabular-nums">
                      <span
                        :class="
                          row.referenceCount > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'
                        "
                      >
                        {{ row.referenceCount }}
                      </span>
                    </TableCell>
                    <TableCell class="text-muted-foreground text-right text-xs tabular-nums">
                      {{ sizeOf(row) }}
                    </TableCell>
                    <TableCell>
                      <div class="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          class="h-7 px-1.5 text-xs"
                          @click="openEdit(row)"
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="h-7 px-1.5 text-xs"
                          @click="openPreview(row)"
                        >
                          预览
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-muted-foreground hover:text-destructive h-7 px-1.5 text-xs"
                          @click="openDelete(row)"
                        >
                          移出
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>

                  <!-- 段明细(票 17):称号 / 事件 / 年份 / 批次 / 附件 / 行数。 -->
                  <TableRow
                    v-if="isExpanded(row.id) && row.parts.length"
                    class="hover:bg-transparent"
                    data-testid="file-parts-row"
                  >
                    <TableCell :colspan="12" class="bg-muted/40 p-0">
                      <!-- 缩进 + 一条竖线,让这段明细读起来属于上面那一行(与详情页用竖线
                           分隔两侧来源是同一种手法),而不是又一张浮在里面的表。
                           明细表按内容收窄(w-auto),不跟着外层撑满 —— 六列都是短值,撑满
                           只会让「行数」的数字飘到老远。右侧空出来的地方放段数,免得留一大块白。 -->
                      <div
                        class="border-border/70 ml-5 flex items-start gap-4 border-l-2 py-3 pr-4 pl-4"
                      >
                        <Table class="w-auto text-xs">
                          <TableHeader>
                            <TableRow class="hover:bg-transparent">
                              <TableHead class="text-muted-foreground h-7 w-48 text-xs font-medium">
                                称号
                              </TableHead>
                              <TableHead class="text-muted-foreground h-7 w-24 text-xs font-medium">
                                事件
                              </TableHead>
                              <TableHead class="text-muted-foreground h-7 w-20 text-xs font-medium">
                                年份
                              </TableHead>
                              <TableHead class="text-muted-foreground h-7 w-16 text-xs font-medium">
                                批次
                              </TableHead>
                              <TableHead class="text-muted-foreground h-7 w-24 text-xs font-medium">
                                附件
                              </TableHead>
                              <TableHead
                                class="text-muted-foreground h-7 text-right text-xs font-medium"
                              >
                                行数
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <TableRow
                              v-for="(part, i) in row.parts"
                              :key="i"
                              class="hover:bg-transparent"
                            >
                              <TableCell class="py-1.5">
                                <TitleBadge :code="part.titleCode" />
                              </TableCell>
                              <TableCell class="py-1.5">
                                <!-- 年份/批次在右边各有一列,这里只出事件类型,不重复写一遍。 -->
                                <EventChip :type="part.eventKind" hide-batch />
                              </TableCell>
                              <TableCell class="py-1.5 tabular-nums">{{ part.year ?? '—' }}</TableCell>
                              <TableCell class="py-1.5 tabular-nums">{{ part.batch ?? '—' }}</TableCell>
                              <TableCell class="py-1.5">{{ part.attachment ?? '—' }}</TableCell>
                              <TableCell class="py-1.5 text-right tabular-nums">
                                {{ part.rowCount.toLocaleString('zh-CN') }}
                              </TableCell>
                            </TableRow>
                          </TableBody>
                        </Table>
                        <!-- 只留段数。原先还有一句解释「年份是段的内容年份、公布年份/批次与段无关」
                             的话 —— 列头已经分别写着「公布年份/批次」和「内容年份」,不必再讲一遍模型。 -->
                        <p
                          class="text-muted-foreground ml-auto shrink-0 text-xs whitespace-nowrap tabular-nums"
                        >
                          共 {{ row.parts.length }} 段
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                </template>
              </template>

              <TableRow v-else class="hover:bg-transparent">
                <TableCell :colspan="12" class="p-0">
                  <Empty class="border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><Search /></EmptyMedia>
                      <EmptyTitle>没有匹配的文件</EmptyTitle>
                      <EmptyDescription>
                        {{ hasFilters ? '去掉一两个筛选条件,或换个关键词再试。' : '文件库还是空的。' }}
                      </EmptyDescription>
                    </EmptyHeader>
                    <Button v-if="hasFilters" variant="outline" size="sm" @click="clearFilters">
                      清除全部筛选
                    </Button>
                  </Empty>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>

    <div class="rise-in flex flex-wrap items-center gap-x-4 gap-y-3" style="--rise-index: 3">
      <div class="flex items-center gap-2">
        <span class="text-muted-foreground text-xs">每页</span>
        <Select :model-value="String(pageSize)" @update:model-value="(v) => setPageSize(Number(v))">
          <SelectTrigger class="bg-card h-8 w-20" aria-label="每页条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="n in PAGE_SIZE_PRESETS" :key="n" :value="String(n)">{{ n }}</SelectItem>
          </SelectContent>
        </Select>
        <span class="text-muted-foreground text-xs">个</span>
      </div>

      <span class="text-muted-foreground text-xs tabular-nums">
        第 {{ page }} / {{ totalPages }} 页
      </span>

      <Pagination
        v-if="total > 0"
        v-slot="{ page: current }"
        class="mx-0 ml-auto w-auto justify-end"
        :page="page"
        :items-per-page="pageSize"
        :total="total"
        :sibling-count="1"
        :show-edges="totalPages > 5"
        @update:page="setPage"
      >
        <PaginationContent v-slot="{ items }">
          <PaginationFirst>
            <ChevronsLeft class="size-4" />
            <span class="sr-only">第一页</span>
          </PaginationFirst>
          <PaginationPrevious>
            <ChevronLeft class="size-4" />
            <span class="hidden sm:block">上一页</span>
          </PaginationPrevious>
          <template v-for="(item, index) in items" :key="index">
            <PaginationItem
              v-if="item.type === 'page'"
              :value="item.value"
              :is-active="item.value === current"
            >
              {{ item.value }}
            </PaginationItem>
            <PaginationEllipsis v-else :index="index" />
          </template>
          <PaginationNext>
            <span class="hidden sm:block">下一页</span>
            <ChevronRight class="size-4" />
          </PaginationNext>
          <PaginationLast>
            <ChevronsRight class="size-4" />
            <span class="sr-only">最后一页</span>
          </PaginationLast>
        </PaginationContent>
      </Pagination>
    </div>

    <EditFileDialog
      v-model:open="editOpen"
      :file="editing"
      :pending="editPending"
      :failure="editFailure"
      @save="saveMetadata"
    />

    <DeleteFileDialog
      v-model:open="deleteOpen"
      :filename="deleting?.filename ?? ''"
      :rel-path="deleting?.relPath ?? ''"
      :reference-count="deleting?.referenceCount ?? 0"
      :pending="deletePending"
      :failure="deleteFailure"
      @confirm="confirmDelete"
    />

    <!-- 预览复用台账的出处预览弹窗(与平行会话做的是同一个组件)。 -->
    <FilePreviewDialog v-model:open="previewOpen" :src="previewSrc" :name="previewFile?.filename ?? ''" />
  </div>
</template>
