<script setup lang="ts">
import { useQuery, useQueryCache } from '@pinia/colada'
import { computed, ref, watch, type Component } from 'vue'
import { useMediaQuery, watchDebounced } from '@vueuse/core'
import { ChevronRight, Eye, FolderOpen, FolderUp, MoreHorizontal, Pencil, Search, Trash2 } from '@lucide/vue'
import { formatBytes } from '#core/lib/core/file-size'
import { describeFetchError } from '#core/lib/file-content-status'
import type { FileCategoryUi } from '#core/lib/core/file-category-ui'
import { fileUrl } from '#core/lib/preview'
import { isPdfPath } from '#core/lib/pdf-page'
import { captureQueryRequest, useRetainedQuerySnapshot } from '#core/app/composables/useRetainedQuerySnapshot'
import type { QueryRequestSnapshot } from '#core/app/composables/useRetainedQuerySnapshot'
import { useToastFeedback } from '#core/app/composables/useToastFeedback'
import type { FileRow } from '#core/server/utils/file-store-contract'
import ActiveFilterBar from '#core/app/components/ActiveFilterBar.vue'
import DataTableCard from '#core/app/components/DataTableCard.vue'
import MultiSelectFilter from '#core/app/components/MultiSelectFilter.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import { Button } from '#core/app/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#core/app/components/ui/dropdown-menu'
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#core/app/components/ui/empty'
import { Input } from '#core/app/components/ui/input'
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

const props = withDefaults(defineProps<{
  title: string
  endpoint: string
  category?: FileCategoryUi
  uploadDialog: Component
  uploadLabel?: string
  detailsLabel?: string
  allowRemoval?: boolean
  showSize?: boolean
}>(), { uploadLabel: '上传文件', detailsLabel: '文件信息', allowRemoval: false, showSize: true })

const criteria = props.category?.filters ?? []
const columns = props.category?.columns ?? []
const narrowWorkspace = useMediaQuery('(max-width: 1279px)')
const compactDetails = computed(() => Boolean(props.category && narrowWorkspace.value))
function registeredComponents(key: 'cells' | 'expandedPanel' | 'detailPanel') {
  return (props.category ? [props.category] : []).flatMap(({ id, name, appliesTo, [key]: component }) =>
    component ? [{ id, name, component, appliesTo }] : [],
  )
}
const cellGroups = registeredComponents('cells')
const expandedPanels = registeredComponents('expandedPanel')
const detailPanels = registeredComponents('detailPanel')
const columnCount = computed(() => 2 + Number(props.showSize) + Number(expandedPanels.length > 0)
  + (compactDetails.value ? 0 : columns.length))
const tableWidth = 176 + (props.showSize ? 70 : 0) + 56 + (expandedPanels.length ? 32 : 0)
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

const activeRequest = computed(() => captureQueryRequest(props.endpoint, params.value))
const { data, isLoading, error, refetch } = useQuery<FilesQueryResult>({
  key: () => ['files', params.value, props.endpoint],
  query: async ({ entry }) => {
    const endpoint = entry.key[2] as string
    const request = captureQueryRequest(endpoint, entry.key[1] as FilesQueryParams)
    const response = await apiGet<FilesResponse>(endpoint, { query: request.params })
    return { ...response, request }
  },
  placeholderData: (previous) => previous,
})

const {
  displayed: displayedResult,
  paginationDisabled,
  failureDescription,
} = useRetainedQuerySnapshot<FilesQueryParams, FilesQueryResult>(data, isLoading, error, activeRequest)
const rows = computed<ListedFile[]>(() => displayedResult.value?.rows ?? [])
const displayedHasFilters = computed(() => {
  const displayed = displayedResult.value?.request.params
  return displayed ? Object.entries(displayed).some(([key, value]) => key !== 'page' && key !== 'pageSize' && Boolean(value)) : false
})
const total = computed(() => displayedResult.value?.total ?? 0)
const displayedPage = computed(() => displayedResult.value?.request.page ?? page.value)
const displayedPageSize = computed(() => displayedResult.value?.request.pageSize ?? pageSize.value)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / displayedPageSize.value)))

function refresh() {
  return queryCache.invalidateQueries({ key: ['files'] })
}

const uploading = ref(false)

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
    clear: () => { search.value = ''; q.value = ''; page.value = 1 },
  }] : []),
])
const hasFilters = computed(() => activeFilters.value.length > 0)

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

const actionWidth = 'w-14 text-right'
const ACTION_TH = `table-sticky-action-head ${actionWidth}`
const ACTION_TD = `table-sticky-action-cell ${actionWidth}`

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
  <WorkspacePage :title="title">
    <DataTableCard toolbar-class="gap-3">
      <template #toolbar>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="relative min-w-0 flex-1 basis-52 sm:max-w-xs">
            <Search
              class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <Input v-model="search" type="search" size="sm" class="pl-8" aria-label="搜索文件名" placeholder="搜索文件名" />
          </div>
          <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
            <slot name="toolbar-actions" />
            <Button v-if="allowRemoval" variant="ghost" size="sm" @click="deleting = null; deleteFailure = ''; deleteOpen = true">恢复隔离文件</Button>
            <Button size="sm" @click="uploading = true"><FolderUp aria-hidden="true" />{{ uploadLabel }}</Button>
          </div>
        </div>
        <div v-if="criteria.length" class="flex flex-wrap items-center gap-2">
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

        <ActiveFilterBar
          :items="activeFilters.map(({ key, label }) => ({ key, label }))"
          clear-label="清除全部"
          :show-clear-min="2"
          @remove="key => activeFilters.find(filter => filter.key === key)?.clear()"
          @clear="clearFilters"
        />
      </template>

      <template #status>
        <TableLoadingStatus kind="files" :loading="isLoading" label="正在筛选与加载文件…" />
      </template>

      <TableFailureState v-if="error" title="文件列表暂时无法加载" :compact="Boolean(displayedResult)" :pending="isLoading" :description="failureDescription" @retry="refetch()" />
      <div
        v-if="!error || displayedResult"
        data-testid="files-table-scroll"
        class="data-table-scroll [container-type:inline-size] focus-visible:outline-ring focus-visible:outline-2 focus-visible:-outline-offset-2"
        role="region"
        tabindex="0"
        :aria-label="`${title}列表`"
        :aria-busy="isLoading"
      >
        <Table class="data-table table-fixed" :style="category && !compactDetails ? { minWidth: tableWidth + 'px' } : undefined">
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead v-if="expandedPanels.length" scope="col" class="w-8">
                <span class="sr-only">展开明细</span>
              </TableHead>
              <TableHead scope="col" :class="category && !compactDetails && 'w-44'">文件名</TableHead>
              <TableHead
                v-for="column in compactDetails ? [] : columns"
                :key="column.label"
                scope="col"
                :class="column.align === 'right' && 'pr-3 text-right'"
                :style="{ width: column.width + 'px' }"
                :title="column.tooltip"
              >
                {{ column.label }}
              </TableHead>
              <TableHead v-if="showSize" scope="col" class="w-[70px] pr-3 text-right">大小</TableHead>
              <TableHead scope="col" :class="ACTION_TH">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody :data-loading="isLoading ? 'true' : 'false'">
            <TableRow v-if="isLoading && !displayedResult" class="hover:bg-transparent">
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
                <TableRow>
                  <TableCell v-if="expandedPanels.length" class="pr-0">
                    <Button
                      v-if="expandedPanels.some(panel => panel.appliesTo?.(row) ?? true)"
                      variant="ghost"
                      size="icon"
                      class="size-8"
                      :aria-expanded="isExpanded(row.id)"
                      :aria-controls="isExpanded(row.id) ? `file-details-${row.id}` : undefined"
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
                  <TableCell>
                    <button
                      type="button"
                      class="hover:text-primary block cursor-pointer text-left whitespace-normal wrap-anywhere font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                      :title="`${row.displayName}\n磁盘文件名:${row.filename}\n${row.relPath}`"
                      @click="openPreview(row)"
                    >
                      {{ row.displayName }}
                    </button>
                    <component v-if="compactDetails && category?.cells" :is="category.cells" :file="row" mode="summary" />
                  </TableCell>
                  <component :is="column.component" v-for="column in compactDetails ? [] : cellGroups" :key="column.id" :file="row" />
                  <TableCell v-if="showSize" class="text-muted-foreground text-right text-xs tabular-nums">
                    {{ sizeOf(row) }}
                  </TableCell>
                  <TableCell :class="ACTION_TD">
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          class="text-muted-foreground hover:text-foreground size-7"
                          :aria-label="`更多操作：${row.displayName}`"
                        >
                          <MoreHorizontal class="size-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" class="w-36">
                        <DropdownMenuItem @select="openPreview(row)">
                          <Eye class="size-3.5" aria-hidden="true" />
                          预览
                        </DropdownMenuItem>
                        <DropdownMenuItem @select="openEdit(row)">
                          <Pencil class="size-3.5" aria-hidden="true" />
                          {{ detailsLabel }}
                        </DropdownMenuItem>
                        <template v-if="allowRemoval">
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            class="text-destructive focus:text-destructive"
                            @select="openDelete(row)"
                          >
                            <Trash2 class="size-3.5" aria-hidden="true" />
                            移出
                          </DropdownMenuItem>
                        </template>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>

                <TableRow v-if="isExpanded(row.id)" :id="`file-details-${row.id}`" class="hover:bg-transparent" data-testid="file-parts-row">
                  <TableCell :colspan="columnCount" class="bg-muted/40 p-0">
                    <div class="sticky left-0 w-[100cqw] p-3 sm:p-4">
                      <component v-if="compactDetails && category?.cells" :is="category.cells" :file="row" mode="details" />
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

            <TableRow v-else-if="displayedResult" class="hover:bg-transparent">
              <TableCell :colspan="columnCount" class="p-0">
                <Empty class="sticky left-0 w-[100cqw] border-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><Search v-if="displayedHasFilters" /><FolderOpen v-else /></EmptyMedia>
                    <EmptyTitle>{{ displayedHasFilters ? '没有匹配的文件' : '暂无文件' }}</EmptyTitle>
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

      <template #footer>
        <TablePagination v-if="displayedResult" in-card :page="displayedPage" :page-size="displayedPageSize" :total="total" :loading="paginationDisabled"
          unit="个文件" @update:page="setPage" @update:page-size="setPageSize" />
      </template>
    </DataTableCard>

    <component :is="uploadDialog" v-model:open="uploading" @registered="refresh()" />


    <EditFileDialog
      v-model:open="editOpen"
      :file="editing"
      :title="detailsLabel"
      :panels="editablePanels"
      :pending="editPending"
      :failure="editFailure"
      :name-pending="renamePending"
      :name-failure="renameFailure"
      @rename="saveDisplayName"
      @save="saveMetadata"
    />


    <DeleteFileDialog
      v-if="allowRemoval"
      v-model:open="deleteOpen"
      :file-id="deleting?.id"
      @changed="refresh"
      :filename="deleting?.displayName ?? ''"
      :rel-path="deleting?.relPath ?? ''"
      :pending="deletePending"
      :failure="deleteFailure"
      @confirm="confirmDelete"
    />

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
  </WorkspacePage>
</template>

