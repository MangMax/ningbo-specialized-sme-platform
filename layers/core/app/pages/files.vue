<script setup lang="ts">
import { useQuery, useQueryCache } from '@pinia/colada'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { ChevronRight, FolderUp, Search } from '@lucide/vue'
import { formatBytes } from '#core/lib/core/file-size'
import { getFileCategoryUi } from '~~/lib/app-file-category-ui'
import { describeFetchError } from '../../lib/file-content-status'
import { fileUrl } from '#core/lib/preview'
import { isPdfPath } from '#core/lib/pdf-page'
import { captureQueryRequest, useRetainedQuerySnapshot } from '#core/app/composables/useRetainedQuerySnapshot'
import type { QueryRequestSnapshot } from '#core/app/composables/useRetainedQuerySnapshot'
import { useToastFeedback } from '#core/app/composables/useToastFeedback'
import type { FileRow } from '#core/server/utils/file-store'
import MultiSelectFilter from '#core/app/components/MultiSelectFilter.vue'
import FilterChip from '#core/app/components/FilterChip.vue'
import { Button } from '#core/app/components/ui/button'
import { Card, CardContent } from '#core/app/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#core/app/components/ui/empty'
import { Input } from '#core/app/components/ui/input'


import { Separator } from '#core/app/components/ui/separator'
import { Skeleton } from '#core/app/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#core/app/components/ui/table'
import { onBeforeRouteLeave } from 'vue-router'
import EditFileDialog from '#core/app/components/files/EditFileDialog.vue'
import DeleteFileDialog from '#core/app/components/files/DeleteFileDialog.vue'
import PdfViewDialog from '#core/app/components/files/PdfViewDialog.vue'

const extensions = getFileCategoryUi()
const criteria = extensions.flatMap(category => category.filters ?? [])
const columns = extensions.flatMap(({ id, columns }) =>
  (columns ?? []).map(column => ({ ...column, key: `${id}:${column.label}` })),
)
function registeredComponents(key: 'cells' | 'expandedPanel' | 'detailPanel' | 'uploadDialog') {
  return extensions.flatMap(({ id, name, appliesTo, [key]: component }) =>
    component ? [{ id, name, component, appliesTo }] : [],
  )
}
const cellGroups = registeredComponents('cells')
const expandedPanels = registeredComponents('expandedPanel')
const detailPanels = registeredComponents('detailPanel')
const uploadDialogs = registeredComponents('uploadDialog')
const columnCount = 3 + Number(expandedPanels.length > 0) + columns.length
const tableWidth = 209 + 70 + 166 + (expandedPanels.length ? 32 : 0)
  + columns.reduce((total, column) => total + column.width, 0)

const apiGet = $fetch as unknown as <T>(
  url: string,
  opts?: { query?: Record<string, unknown> },
) => Promise<T>

type ListedFile = FileRow & { referenceCount?: number }

interface FilesResponse {
  rows: ListedFile[]
  total: number
}

const queryCache = useQueryCache()
const feedback = useToastFeedback()

// —— 筛选(多选)——
const selections = ref<Record<string, string[]>>({})
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
  ...Object.fromEntries(criteria.map(filter => [filter.key, selections.value[filter.key]?.join(',') || undefined])),
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
const rows = computed<ListedFile[]>(() => displayedResult.value?.rows ?? [])
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

function refresh() {
  return queryCache.invalidateQueries({ key: ['files'] })
}

const uploading = ref<string | null>(null)

function setFilter(key: string, values: string[]) {
  selections.value = { ...selections.value, [key]: values }
  page.value = 1
}

function clearFilters() {
  selections.value = {}
  search.value = ''
  q.value = ''
  page.value = 1
}

const activeFilters = computed(() => [
  ...criteria.flatMap(filter => (selections.value[filter.key] ?? []).map(value => ({
    key: `${filter.key}:${value}`,
    label: `${filter.label} · ${filter.options.find(option => option.value === value)?.label ?? value}`,
    clear: () => setFilter(filter.key, (selections.value[filter.key] ?? []).filter(selected => selected !== value)),
  }))),
  ...(q.value ? [{
    key: 'q',
    label: `搜索 · ${q.value}`,
    clear: () => { search.value = ''; q.value = '' },
  }] : []),
])
const hasFilters = computed(() => activeFilters.value.length > 0)

// —— 行操作 ——
const editing = ref<ListedFile | null>(null)
const editablePanels = computed(() => {
  const file = editing.value
  return file ? detailPanels.filter(panel => panel.appliesTo?.(file) ?? true) : []
})
const editOpen = ref(false)
const editPending = ref(false)
const editFailure = ref('')

const renamePending = ref(false)
const renameFailure = ref('')

const deleting = ref<ListedFile | null>(null)
const deleteOpen = ref(false)
const deletePending = ref(false)
const deleteFailure = ref('')

const previewOpen = ref(false)
const previewFile = ref<ListedFile | null>(null)

function openEdit(row: ListedFile) {
  editing.value = row
  editFailure.value = ''
  renameFailure.value = ''
  editOpen.value = true
}

function openDelete(row: ListedFile) {
  deleting.value = row
  deleteFailure.value = ''
  deleteOpen.value = true
}

function openPreview(row: ListedFile) {
  previewFile.value = row
  previewOpen.value = true
}

/** 保存元数据:只提交分类字段;空串转为 null 表示「清空」。 */
async function saveMetadata(patch: Record<string, unknown>) {
  if (!editing.value) return
  editPending.value = true
  editFailure.value = ''
  try {
    await $fetch(`/api/files/${editing.value.id}`, {
      method: 'PATCH',
      body: patch,
    })
    editOpen.value = false
    feedback.succeed('保存', '文件信息')
    await refresh()
  } catch (error) {
    editFailure.value = describeFetchError(error)
    feedback.fail('保存', '文件信息', editFailure.value, () => saveMetadata(patch))
  } finally {
    editPending.value = false
  }
}

/** 只提交用户可见名称;从不把它作为磁盘文件名或路径。 */
async function saveDisplayName(displayName: string) {
  if (!editing.value) return
  renamePending.value = true
  renameFailure.value = ''
  try {
    await $fetch(`/api/files/${editing.value.id}`, {
      method: 'PATCH',
      body: { displayName },
    })
    editing.value = { ...editing.value, displayName }
    feedback.succeed('保存', '文件名称')
    await refresh()
  } catch (error) {
    renameFailure.value = describeFetchError(error)
    feedback.fail('保存', '文件名称', renameFailure.value, () => saveDisplayName(displayName))
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
    feedback.succeed('移出', '文件')
    await refresh()
  } catch (error) {
    deleteFailure.value = describeFetchError(error)
    feedback.fail('移出', '文件', deleteFailure.value, () => confirmDelete(_deleteDisk))
  } finally {
    deletePending.value = false
  }
}

const sizeOf = (row: ListedFile) => formatBytes(row.bytes)
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

const expandedIds = ref<number[]>([])
const isExpanded = (id: number) => expandedIds.value.includes(id)
type ExpandedPanel = { requestLeave?: () => Promise<boolean> }
const editors = new Map<string, ExpandedPanel>()
const panelKey = (fileId: number, moduleId: string) => `${fileId}:${moduleId}`
function setExpandedPanel(fileId: number, moduleId: string, instance: unknown) {
  const key = panelKey(fileId, moduleId)
  if (instance) editors.set(key, instance as ExpandedPanel)
  else editors.delete(key)
}
async function guardEditors() {
  for (const editor of editors.values()) {
    if (editor.requestLeave && !await editor.requestLeave()) return false
  }
  return true
}
onBeforeRouteLeave(guardEditors)
async function toggleDetails(id: number) {
  if (isExpanded(id)) {
    for (const panel of expandedPanels) {
      const editor = editors.get(panelKey(id, panel.id))
      if (editor?.requestLeave && !await editor.requestLeave()) return
    }
    expandedIds.value = expandedIds.value.filter(value => value !== id)
  } else {
    expandedIds.value = [...expandedIds.value, id]
  }
}

// Keep the displayed query fixed until the current detail operation is resolved.
let changingQuery = false
let queryGuardPending = false
type QueryState = [typeof selections.value, string, number, number]
let queuedQuery: QueryState | null = null
function applyQuery([filters, query, pg, size]: QueryState) {
  changingQuery = true
  selections.value = filters
  q.value = query
  page.value = pg
  pageSize.value = size
  changingQuery = false
}
watch([selections, q, page, pageSize], async (values, previous) => {
  if (changingQuery || !editors.size) return
  const queued = queuedQuery
  if (queryGuardPending && queued) {
    const [filters, query, pg, size] = values
    const [oldFilters, oldQuery, oldPg, oldSize] = previous
    const merged = Object.fromEntries(criteria.map(({ key }) => [
      key, filters[key] === oldFilters[key] ? queued[0][key] ?? [] : filters[key] ?? [],
    ]))
    queuedQuery = [merged, query === oldQuery ? queued[1] : query,
      pg === oldPg ? queued[2] : pg, size === oldSize ? queued[3] : size]
  } else {
    queuedQuery = values
  }
  applyQuery(previous)
  if (queryGuardPending) return
  queryGuardPending = true
  const allowed = await guardEditors()
  queryGuardPending = false
  if (allowed && queuedQuery) applyQuery(queuedQuery)
  if (!allowed) search.value = q.value
  queuedQuery = null
}, { flush: 'sync' })
</script>

<template>
  <div class="files-page flex min-w-0 flex-col gap-2 sm:gap-3">
    <PageHeader
      title="文件管理"
      description="查看、预览和维护文件库里的文件。"
    >
      <template #actions>
        <!-- 上传接 tus(票 10):点开是上传弹窗,传完登记进库并失效列表查询,
             列表会立即出现新行 —— 不必手动刷新。 -->
        <Button v-for="upload in uploadDialogs" :key="upload.id" variant="outline" size="sm" title="上传文件到文件库" @click="uploading = upload.id">
          <FolderUp />
          {{ uploadDialogs.length === 1 ? '上传' : `上传 · ${upload.name}` }}
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

      <Separator v-if="criteria.length" orientation="vertical" class="hidden h-5 sm:block" />
      <MultiSelectFilter
        v-for="filter in criteria"
        :key="filter.key"
        :model-value="selections[filter.key] ?? []"
        :options="[...filter.options]"
        :placeholder="filter.placeholder"
        :summary-prefix="filter.label"
        :class="filter.width"
        @update:model-value="setFilter(filter.key, $event)"
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
          <Table class="data-table table-fixed" :style="{ minWidth: tableWidth + 'px' }">
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead v-if="expandedPanels.length" :class="[TH_CLASS, 'w-8']">
                  <span class="sr-only">展开明细</span>
                </TableHead>
                <TableHead :class="[TH_CLASS, 'w-[209px]']">文件名</TableHead>
                <TableHead
                  v-for="column in columns"
                  :key="column.key"
                  :class="[TH_CLASS, column.align === 'right' && 'pr-3 text-right']"
                  :style="{ width: column.width + 'px' }"
                  :title="column.tooltip"
                >
                  {{ column.label }}
                </TableHead>
                <TableHead :class="[TH_CLASS, 'w-[70px] pr-3 text-right']">大小</TableHead>
                <TableHead :class="[ACTION_TH]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody :data-loading="isLoading ? 'true' : 'false'">
              <TableRow v-if="isLoading && rows.length === 0" class="hover:bg-transparent">
                <TableCell :colspan="columnCount" class="p-0">
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
                    <TableCell class="pr-0" v-if="expandedPanels.length">
                      <Button
                        v-if="expandedPanels.some(panel => panel.appliesTo?.(row) ?? true)"
                        variant="ghost"
                        size="icon"
                        class="size-8"
                        :aria-expanded="isExpanded(row.id)"
                        title="展开明细"
                        @click="toggleDetails(row.id)"
                      >
                        <ChevronRight
                          class="size-4 transition-transform duration-150"
                          :class="isExpanded(row.id) && 'rotate-90'"
                        />
                        <span class="sr-only">展开明细</span>
                      </Button>
                    </TableCell>
                    <TableCell class="w-[209px]">
                      <!-- Hover exposes the full name and path when the cell truncates. -->
                      <span
                        class="block truncate font-medium"
                        :title="`${row.displayName}\n磁盘文件名:${row.filename}\n${row.relPath}`"
                      >
                        {{ row.displayName }}
                      </span>
                    </TableCell>
                    <component :is="column.component" v-for="column in cellGroups" :key="column.id" :file="row" />
                    <TableCell class="text-muted-foreground text-right text-xs tabular-nums">
                      {{ sizeOf(row) }}
                    </TableCell>
                    <TableCell :class="ACTION_TD">
                      <div class="flex flex-wrap items-center gap-1">

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

                  <TableRow v-if="isExpanded(row.id)" class="hover:bg-transparent" data-testid="file-parts-row">
                    <TableCell :colspan="columnCount" class="bg-muted/40 p-0">
                      <div class="sticky left-0 w-[100cqw] p-3 sm:p-4">
                        <component
                          :is="panel.component"
                          v-for="panel in expandedPanels.filter(panel => panel.appliesTo?.(row) ?? true)"
                          :key="panel.id"
                          :ref="(instance: unknown) => setExpandedPanel(row.id, panel.id, instance)"
                          :open="true"
                          :file="row"
                          :refresh-list="refresh"
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                </template>
              </template>

              <TableRow v-else class="hover:bg-transparent">
                <TableCell :colspan="columnCount" class="p-0">
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

    <component
      :is="upload.component"
      v-for="upload in uploadDialogs"
      :key="upload.id"
      :open="uploading === upload.id"
      @update:open="uploading = $event ? upload.id : null"
      @registered="refresh()"
    />


    <EditFileDialog
      v-model:open="editOpen"
      :file="editing"
      :panels="editablePanels"
      :pending="editPending"
      :failure="editFailure"
      :name-pending="renamePending"
      :name-failure="renameFailure"
      @rename="saveDisplayName"
      @save="saveMetadata"
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
