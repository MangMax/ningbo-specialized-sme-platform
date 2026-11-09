<script setup lang="ts">
import { useQuery, useQueryCache } from '@pinia/colada'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { ChevronRight, FolderUp, Search } from '@lucide/vue'
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
import { describeFetchError } from '~~/lib/upload-register'
import { fileUrl } from '~~/lib/preview'
import { isPdfPath } from '~~/lib/pdf-page'
import { joinSeries, partBatches, partYears } from '~~/lib/file-parts'
import { captureQueryRequest, useRetainedQuerySnapshot } from '~/composables/useRetainedQuerySnapshot'
import type { QueryRequestSnapshot } from '~/composables/useRetainedQuerySnapshot'
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
import FileEventSync from '@/components/files/FileEventSync.vue'
import FileSegmentsEditor from '@/components/files/FileSegmentsEditor.vue'
import EditFileDialog, { type MetadataForm } from '@/components/files/EditFileDialog.vue'
import RenameFileDialog from '@/components/files/RenameFileDialog.vue'
import DeleteFileDialog from '@/components/files/DeleteFileDialog.vue'
import UploadDialog from '@/components/files/UploadDialog.vue'
import PdfViewDialog from '@/components/files/PdfViewDialog.vue'

/**
 * 文件管理页(票 09;段的展示是票 17):统一管理文件库(`files/`)里的**全部**文件。
 *
 * 这一页管的是**文件**,不是记录 —— 台账页管记录。所以每行是「一个文件在磁盘上是什么、
 * 被归成哪一类、里面含哪些段、被哪些记录引用」,行操作是编元数据 / 预览 / 移出库。
 *
 * **年份 / 批次两列显示的是文件内容里的段**(票 17:一份文件常含多年份、多事件,
 * 如 192号 同时含「认定 2024/2」与「复核 2021/2」),所以列头写「内容年份」「内容批次」,
 * 与旁边文件级的**「文件发布年份/批次」**(目录给的、单值)一眼分得开。值多时列里只平铺前两个、
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
type FilesQueryParams = typeof params.value
type FilesQueryResult = FilesResponse & { request: QueryRequestSnapshot<FilesQueryParams> }

const activeRequest = computed(() => captureQueryRequest('files', params.value))
const { data, isLoading, error, refetch } = useQuery<FilesQueryResult>({
  key: () => ['files', params.value],
  query: async ({ entry }) => {
    const request = captureQueryRequest('files', entry.key[1] as typeof params.value)
    const response = await apiGet<FilesResponse>('/api/files', { query: request.params })
    return { ...response, request }
  },
  // 换筛选/翻页时保留上一批数据,避免表体清空 → 文档高度骤变 → 页面闪一下并跳回顶部。
  placeholderData: (previous) => previous,
})

const {
  displayed: displayedResult,
  paginationDisabled,
  failureDescription,
} = useRetainedQuerySnapshot<FilesQueryParams, FilesQueryResult>(data, isLoading, error, activeRequest)
const rows = computed<StoredFileRow[]>(() => displayedResult.value?.rows ?? [])
const total = computed(() => displayedResult.value?.total ?? 0)
const displayedPage = computed(() => displayedResult.value?.request.page ?? page.value)
const displayedPageSize = computed(() => displayedResult.value?.request.pageSize ?? pageSize.value)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / displayedPageSize.value)))

/**
 * 表格是否真的横向溢出了(12 列合计 1154px,1440 侧栏展开时装得下,更窄就装不下)。
 *
 * 只用来决定「钉住的操作列要不要画左边那条分界线」:没溢出时不会有列从它底下滑过,
 * 画线就是凭空多一根;溢出了才需要划出「这列是钉住的」。
 * 用 `border-spacing` 没有、也不该用的情况:直接量滚动容器的 `scrollWidth`。
 */
const tableScroller = ref<HTMLElement | null>(null)
const isPinned = ref(false)
function measureOverflow() {
  const el = tableScroller.value
  isPinned.value = el ? el.scrollWidth > el.clientWidth + 1 : false
}
onMounted(() => {
  measureOverflow()
  window.addEventListener('resize', measureOverflow)
  // 字体或缩放变化也会改变文字宽度,进而改变总宽。
  window.addEventListener('pageshow', measureOverflow)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measureOverflow)
  window.removeEventListener('pageshow', measureOverflow)
})
// 行数变化会改变滚动条的有无(竖向滚动条占宽)。
watch([rows, pageSize], () => nextTick(measureOverflow))

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

/**
 * 上传通道(票 10):点「上传」开弹窗;传完由 `UploadDialog` 登记进库并 emit `registered`,
 * 这里失效 `['files']` 那一批查询(所有筛选组合),让新行**立即出现**,不必手动刷新。
 */
const uploadOpen = ref(false)

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

const renaming = ref<StoredFileRow | null>(null)
const renameOpen = ref(false)
const renamePending = ref(false)
const renameFailure = ref('')

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

function openRename(row: StoredFileRow) {
  renaming.value = row
  renameFailure.value = ''
  renameOpen.value = true
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

/** 只提交用户可见名称;从不把它作为磁盘文件名或路径。 */
async function saveDisplayName(displayName: string) {
  if (!renaming.value) return
  renamePending.value = true
  renameFailure.value = ''
  try {
    await $fetch(`/api/files/${renaming.value.id}`, {
      method: 'PATCH',
      body: { displayName },
    })
    renameOpen.value = false
    await refresh()
  } catch (error) {
    renameFailure.value = describeFetchError(error)
  } finally {
    renamePending.value = false
  }
}

async function confirmDelete(_deleteDisk: boolean) {
  if (!deleting.value) return
  deletePending.value = true
  deleteFailure.value = ''
  try {
    await $fetch(`/api/files/${deleting.value.id}`, {
      method: 'DELETE',
    })
    deleteOpen.value = false
    await refresh()
  } catch (error) {
    deleteFailure.value = describeFetchError(error)
  } finally {
    deletePending.value = false
  }
}

const sizeOf = (row: StoredFileRow) => formatBytes(row.bytes)
const previewSrc = computed(() =>
  previewFile.value ? fileUrl(previewFile.value.relPath) : '',
)

const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-20 h-9 text-xs font-medium'

/**
 * 操作列的表头 / 单元格:横向滚动时**钉在表格右边**。
 *
 * 这一页 12 列合计 1154px,1280 / 1366 视口(侧栏展开)装不下,会横向滚动;而编辑 /
 * 改名 / 预览 / 移出恰恰是这一页的常用操作。不钉住的话,默认视野里够不到它们 —— 用户得先
 * 横向滚到底才知道能操作。钉住后无论滚到哪一段,操作始终在。
 *
 * 底色见样式区：必须使用实心底色，避免滚动内容透过固定列。
 * 且 hover 时与行的 `bg-accent/70` 同色,否则一行里后面几列一变深、这列还是白的,
 * 像是浮在外面。左边那条分界线只在真的溢出时才画(见 `isPinned`)。
 * 单元格 `z-10` 低于表头的 `z-30`:上下滚时行内单元格不会盖住表头。
 */
const ACTION_TH = computed(
  () => `${TH_CLASS} sticky right-0 z-30 w-[166px] ${isPinned.value ? 'pin-edge' : ''}`,
)
const ACTION_TD = computed(
  () =>
    `bg-card group-hover:bg-accent/70 sticky right-0 z-10 w-[166px] transition-colors ${isPinned.value ? 'pin-edge' : ''}`,
)

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
/** 「文件发布年份/批次」列:文件级**单值**(目录给的),形如 `2024 / 2`、`2024`、`—`。 */
function publishedYearBatch(row: StoredFileRow): string {
  if (row.year == null) return '—'
  return row.batch == null ? String(row.year) : `${row.year} / ${row.batch}`
}
</script>

<template>
  <div class="files-page flex min-w-0 flex-col gap-2 sm:gap-3">
    <PageHeader
      title="文件管理"
      description="文件库里的全部来源文件;展开任意一行看它含哪些段。"
    >
      <template #actions>
        <!-- 上传接 tus(票 10):点开是上传弹窗,传完登记进库并失效列表查询,
             列表会立即出现新行 —— 不必手动刷新。 -->
        <Button variant="outline" size="sm" title="上传文件到文件库" @click="uploadOpen = true">
          <FolderUp />
          上传
        </Button>
      </template>
    </PageHeader>

    <!-- 工具栏:搜索 + 三个多选筛选。左侧筛,右侧只报当前条数。 -->
    <div class="flex flex-wrap items-center gap-2">
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

    <Card class="gap-0 overflow-hidden py-0 shadow-none">
      <CardContent class="relative p-0">
        <TableLoadingStatus kind="files" :loading="isLoading" label="正在筛选与加载文件…" />
        <TableFailureState v-if="error" title="文件列表暂时无法加载" :compact="rows.length > 0" :pending="isLoading" :description="failureDescription" @retry="refetch()" />
        <div
          v-if="!error || rows.length > 0"
          ref="tableScroller"
          data-testid="files-table-scroll"
          class="data-table-scroll [container-type:inline-size] [&_[data-slot=table-container]]:overflow-visible"
          :aria-busy="isLoading"
        >
          <!-- 12 列。恢复改名操作后,表格总宽为 1154px。
               1440(侧栏展开)容器 1124px → 不横滚;1280 / 1366 装不下(实测 1280 差 144px,
               1366 差 58px),这时**操作列钉在右边**(见下面的 `sticky right-0`)——
               编辑/预览/移出是这一页最常做的事,不能因为横向滚动就够不到。
               剩下的中间列照旧横向滚动去读,与同门台账页一致。
               文件名留 209px:放下「甬经信中小〔2026〕101号关于…」,截断点落在文号之后,
               邻近的两份文件才不会截成同一个样子。
               `table-fixed`:列宽按表头的 w-* 逐列算,宽屏下也不会某一列吃满剩余空间。 -->
          <Table class="data-table min-w-[1154px] table-fixed">
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead :class="[TH_CLASS, 'w-8']">
                  <span class="sr-only">展开段</span>
                </TableHead>
                <TableHead :class="[TH_CLASS, 'w-[209px]']">文件名</TableHead>
                <TableHead :class="[TH_CLASS, 'w-[81px]']">来源</TableHead>
                <TableHead :class="[TH_CLASS, 'w-[80px]']">类别</TableHead>
                <TableHead
                  :class="[TH_CLASS, 'w-[92px]']"
                  title="目录给出的文件发布年份/批次 —— 这份文件是哪一批公布的(单值)"
                >
                  文件发布年份/批次
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
                <!-- 右对齐的两列:表头要比正文多 4px 内边距(`table-head` 默认 px-2、
                     `table-cell` 默认 px-3),否则数字右缘和表头差 4px,一眼看得出没对齐。 -->
                <TableHead :class="[TH_CLASS, 'w-[56px] pr-3 text-right']">被引用</TableHead>
                <TableHead :class="[TH_CLASS, 'w-[70px] pr-3 text-right']">大小</TableHead>
                <TableHead :class="[ACTION_TH]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody :data-loading="isLoading ? 'true' : 'false'">
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
                  <TableRow class="group hover:bg-accent/70">
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
                        :title="`${row.displayName}\n磁盘文件名:${row.filename}\n${row.relPath}`"
                      >
                        {{ row.displayName }}
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
                    <!-- 文件发布年份/批次:文件级单值(目录给的),退到次级色 —— 内容年份才是要读的信息。 -->
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
                      <!-- 分类状态:已定 / 程序推的 / 未定。三档靠**线型**分开(与事件同一套
                           语言 —— `dashed` = 还没坐实),不靠颜色 —— 颜色已被称号梯度占用。 -->
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
                      <!-- 解析状态:未解析 / 已解析 / 解析失败。
                           与左边那列刻意用**不同**的线型:两列挨着、列宽也差不多,若默认态
                           都画成同一条实线灰边(改前就是这样),扫视时这两列读成一个东西,
                           「这份文件还没解析」这个信号就没了。`unparsed` 是**待办**,走虚线
                           (与入库培育同一档语义);`parsed` 已坐实走实线;`failed` 才是红。 -->
                      <Badge
                        :variant="
                          row.parseState === 'failed'
                            ? 'destructive'
                            : row.parseState === 'parsed'
                              ? 'solid'
                              : 'dashed'
                        "
                      >
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
                    <TableCell :class="ACTION_TD">
                      <div class="flex flex-wrap items-center gap-1">
                        <FileEventSync :file-id="row.id" @synced="refresh()" />
                        <Button variant="ghost" size="sm" class="h-7 px-1.5 text-xs" @click="toggleParts(row.id)">管理分段</Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="h-7 px-1.5 text-xs"
                          @click="openEdit(row)"
                        >
                          文件信息
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="h-7 px-1.5 text-xs"
                          :aria-label="`修改 ${row.displayName} 的用户可见名称`"
                          title="只改用户可见名称"
                          @click="openRename(row)"
                        >
                          改名
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
                    v-if="isExpanded(row.id)"
                    class="hover:bg-transparent"
                    data-testid="file-parts-row"
                  >
                    <TableCell :colspan="12" class="bg-muted/40 p-0">
                      <div class="sticky left-0 w-[100cqw] p-3 sm:p-4"><FileSegmentsEditor :open="true" :file="row" :refresh-list="refresh" /></div>
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

    <TablePagination v-if="!error || rows.length > 0" :page="displayedPage" :page-size="displayedPageSize" :total="total" :loading="paginationDisabled" unit="个文件" @update:page="setPage" @update:page-size="setPageSize" />

    <UploadDialog v-model:open="uploadOpen" @registered="refresh()" />


    <EditFileDialog
      v-model:open="editOpen"
      :file="editing"
      :pending="editPending"
      :failure="editFailure"
      @save="saveMetadata"
    />

    <RenameFileDialog
      v-model:open="renameOpen"
      :file="renaming"
      :pending="renamePending"
      :failure="renameFailure"
      @save="saveDisplayName"
    />

    <Button variant="outline" @click="deleting = null; deleteFailure = ''; deleteOpen = true">恢复隔离文件</Button>
    <DeleteFileDialog
      v-model:open="deleteOpen"
      :file-id="deleting?.id"
      @changed="refresh"
      :filename="deleting?.displayName ?? ''"
      :rel-path="deleting?.relPath ?? ''"
      :reference-count="deleting?.referenceCount ?? 0"
      :pending="deletePending"
      :failure="deleteFailure"
      @confirm="confirmDelete"
    />

    <!-- PDF 走「原文 / 页图」两视图弹窗(票 13 的页图在这里看);其余格式仍是单一预览弹窗。
         为什么页图不做成第五颗行操作按钮:操作列 166px 已容纳编辑/改名/预览/移出,
         再加一颗会继续扩宽表格 —— 详细理由见 `components/files/PdfViewDialog.vue`。 -->
    <PdfViewDialog
      v-if="previewFile && isPdfPath(previewFile.relPath)"
      v-model:open="previewOpen"
      :src="previewSrc"
      :name="previewFile.displayName"
      :file="previewFile.relPath"
    />
    <FilePreviewDialog
      v-else
      v-model:open="previewOpen"
      :src="previewSrc"
      :name="previewFile?.displayName ?? ''"
    />
  </div>
</template>

<style scoped>
.files-page :deep(.text-xs), .files-page :deep(.text-sm) { font-size: 13px; line-height: 1.5; }
.files-page :deep([data-slot='button']) { box-shadow: none; }

/*
 * 钉在右边的「操作」列:横向滚动时它盖在中间列上,所以底色必须是**实心**的
 * (`bg-card` / hover 的 `bg-accent`),半透明会透出底下的文字。
 *
 * 这两个底色的写法有两个要点:
 *   1. 用 Tailwind 工具类写在模板里,不写进这个 style 块 —— 这里的规则不在 `@layer`
 *      里,会**压过** Tailwind 的 `group-hover:*`(未分层的样式总是赢分层样式,与选择器
 *      权重无关),那样 hover 时这一列不会跟着行底一起变深。
 *   2. 单元格先铺一层不透明的 `bg-card`,hover 再叠 `bg-accent/70` —— 与行的
 *      `hover:bg-accent/70` 走同一套合成(accent 70% 压在卡片白底上),两边得出的
 *      像素完全相同。直接写不透明的 `bg-accent` 会**偏深一档**,行里会多出一条竖带。
 * 这里只留一个不跟任何工具类打架的:分隔线。
 *
 * 分隔线只在真的横向溢出时才加(`isPinned`)。用 inset 的 box-shadow 而不是
 * border-left:border 会占 1px 宽、把量好的 166px 列挤成 165px;阴影不占位。
 */
.pin-edge {
  box-shadow: inset 1px 0 0 var(--border);
}
</style>
