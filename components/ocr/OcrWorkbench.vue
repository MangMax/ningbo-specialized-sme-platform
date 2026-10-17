<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileSearch,
  FileText,
  FileWarning,
  Filter,
  Images,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Upload,
  WrapText,
  X,
} from '@lucide/vue'
import { useOcrWorkbench } from '@/composables/useOcrWorkbench'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ImagePreview from '@/components/preview/ImagePreview.vue'
import OcrBottomBar from './OcrBottomBar.vue'
import OcrFilePicker from './OcrFilePicker.vue'
import OcrFilterPanel from './OcrFilterPanel.vue'
import OcrImportDialog from './OcrImportDialog.vue'
import OcrPageBody from './OcrPageBody.vue'
import OcrPageRow from './OcrPageRow.vue'
import {
  pageReviewState,
  STATE_BADGE,
  STATE_WORD,
  type PageFilters,
  type PageReviewState,
} from '~~/lib/ocr-workbench'
import { PAGE_IMAGE_ZOOM_MIN, pageLabel } from '~~/lib/page-gallery'
import type { OcrView } from '@/composables/useOcrNavigation'

const {
  refreshAll,
  detailLoading,
  filesLoading,
  filesError,
  loadFiles,
  pdfFiles,
  fileMatches,
  fileYears,
  keyword,
  source,
  year,
  selectedPath,
  selected,
  selectFile,
  setFileFilter,
  writeBusy,
  counts,
  renderedCount,
  pageCount,
  rendering,
  renderPageImages,
  canImport,
  IMPORT_NOT_READY,
  filters,
  view,
  visibleRows,
  currentPage,
  currentRow,
  dirty,
  notice,
  ready,
  setFilters,
  setView,
  navigate,
  status,
  loadedPath,
  detailError,
  loadDetail,
  rows,
  imageVersion,
  pendingPage,
  rowFailure,
  justSaved,
  savePage,
  removePage,
  importOpen,
  importPending,
  importFailure,
  importResult,
  runImport,
  pageNumbers,
} = useOcrWorkbench()

const isNarrow = useMediaQuery('(max-width: 1023px)')
const pageRow = useTemplateRef<{ focusEditor: () => void }>('pageRow')
const bottomBar = useTemplateRef<{
  focusEdit: () => Promise<void>
  focusBar: () => Promise<void>
}>('bottomBar')

const fileOpen = ref(false)
const filterOpen = ref(false)
const compareOpen = ref(false)
const compareTrigger = ref<HTMLElement | null>(null)
const compareMode = ref<'rendered' | 'source'>('rendered')
const compareWrap = ref(true)
const compareMessage = ref('')
const jumpOpen = ref(false)
const jump = ref('')
const jumpError = ref('')

const editing = ref(false)
const draft = ref('')

/**
 * 草稿脏状态直接写回 navigation 的 `dirty`：它同时负责阻断换文件/换页/筛选、
 * 路由离开与 beforeunload。只在这里维护，避免组件内外两份真值。
 */
watch(
  [editing, draft, currentPage, rows],
  () => {
    // Read the unfiltered row directly. Depending on `currentRow` here would
    // create a sync loop: `currentRow` itself switches its source based on
    // `dirty`, so writing `dirty` would invalidate `currentRow` again.
    const row = rows.value.find((item) => item.page === currentPage.value)
    dirty.value =
      editing.value && draft.value !== (row?.result?.markdown ?? '')
  },
  { immediate: true, flush: 'sync' },
)

watch([currentPage, selectedPath], () => {
  editing.value = false
  draft.value = ''
})

// The compare dialog follows the current page while it is open (its own pager
// calls `navigate`). Close it only when the file changes or the page disappears.
watch(selectedPath, () => {
  compareOpen.value = false
})

watch(currentRow, (row) => {
  if (!row) {
    editing.value = false
    draft.value = ''
    compareOpen.value = false
  }
})

watch(
  [justSaved, pendingPage],
  ([saved, pending]) => {
    if (editing.value && pending === null && saved === currentPage.value) {
      editing.value = false
      draft.value = ''
      if (currentRow.value) void bottomBar.value?.focusEdit()
      else void bottomBar.value?.focusBar()
    }
  },
)

watch(currentPage, (page) => {
  jump.value = page === null ? '' : String(page)
  jumpError.value = ''
})

const pages = computed(() => visibleRows.value.map((row) => row.page))
const pageIndex = computed(() =>
  currentPage.value === null ? -1 : pages.value.indexOf(currentPage.value),
)
const currentState = computed<PageReviewState>(() =>
  pageReviewState(currentRow.value?.result ?? null),
)
const canEdit = computed(
  () => !!currentRow.value && !detailLoading.value && !detailError.value,
)
const editLabel = computed(() =>
  currentRow.value
    ? currentRow.value.result
      ? '编辑'
      : '手工录入'
    : '编辑',
)
const rowFailureMessage = computed(() =>
  rowFailure.value?.page === currentPage.value ? rowFailure.value.message : '',
)
const currentImageSrc = computed(() => {
  const url = currentRow.value?.image?.url
  if (!url) return ''
  return imageVersion.value
    ? `${url}?v=${encodeURIComponent(imageVersion.value)}`
    : url
})
const compareMeta = computed(() => {
  const result = currentRow.value?.result
  if (!result) return ''
  return [result.model || result.engine, formatTime(result.createdAt)]
    .filter(Boolean)
    .join(' · ')
})
const compareDescription = computed(() =>
  isNarrow.value
    ? '上方是页图，下方是识别文本（只读）。Esc 关闭后回到原来的页。'
    : '左侧是页图，右侧是识别文本（只读）。Esc 关闭后回到原来的页。',
)
const compareCanPrev = computed(
  () => !dirty.value && !writeBusy.value && pageIndex.value > 0,
)
const compareCanNext = computed(
  () =>
    !dirty.value &&
    !writeBusy.value &&
    pageIndex.value >= 0 &&
    pageIndex.value < pages.value.length - 1,
)
const activeFilterCount = computed(
  () =>
    filters.value.states.length +
    (filters.value.range.trim() ? 1 : 0) +
    (filters.value.text.trim() ? 1 : 0),
)
interface FilterChip {
  key: string
  label: string
  remove: () => void
}
const filterChips = computed<FilterChip[]>(() => {
  const chips: FilterChip[] = filters.value.states.map((state) => ({
    key: `state-${state}`,
    label: STATE_WORD[state],
    remove: () =>
      applyFilters({
        ...filters.value,
        states: filters.value.states.filter((item) => item !== state),
      }),
  }))
  if (filters.value.range.trim())
    chips.push({
      key: 'range',
      label: `页 ${filters.value.range.trim()}`,
      remove: () => applyFilters({ ...filters.value, range: '' }),
    })
  if (filters.value.text.trim())
    chips.push({
      key: 'text',
      label: `关键词 ${filters.value.text.trim()}`,
      remove: () => applyFilters({ ...filters.value, text: '' }),
    })
  return chips
})
const filterSummary = computed(() =>
  filterChips.value.map((chip) => chip.label).join(' · '),
)
const displayName = computed(
  () => selected.value?.displayName || selected.value?.filename || selectedPath.value,
)

function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function applyFilters(next: PageFilters) {
  setFilters(next)
}

function clearFilters() {
  setFilters({ states: [], range: '', text: '' })
}

function startEdit() {
  if (!currentRow.value || !canEdit.value) return
  draft.value = currentRow.value.result?.markdown ?? ''
  editing.value = true
  void nextTick(() => pageRow.value?.focusEditor())
}

function cancelEdit() {
  editing.value = false
  draft.value = ''
  void bottomBar.value?.focusEdit()
}

function saveDraft() {
  if (!currentRow.value) return
  void savePage(currentRow.value.page, draft.value)
}

function retry() {
  if (editing.value && currentRow.value) saveDraft()
  else if (selectedPath.value) void loadDetail(selectedPath.value)
}

async function removeCurrent() {
  const page = currentPage.value
  if (page === null) return
  await removePage(page)
  await nextTick()
  void bottomBar.value?.focusBar()
}

function goPrev() {
  if (pageIndex.value > 0) navigate(pages.value[pageIndex.value - 1]!)
}

function goNext() {
  if (pageIndex.value >= 0 && pageIndex.value < pages.value.length - 1)
    navigate(pages.value[pageIndex.value + 1]!)
}

function goToPage() {
  const value = jump.value.trim()
  const page = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(page)) {
    jumpError.value = '请输入正整数页号。'
    return
  }
  if (!pages.value.includes(page)) {
    jumpError.value = '请输入当前命中范围内的实际页号。'
    return
  }
  jumpError.value = ''
  jumpOpen.value = false
  navigate(page)
}

function openCompare(trigger?: HTMLElement) {
  if (!currentRow.value) return
  compareTrigger.value =
    trigger ??
    (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null)
  compareMode.value = 'rendered'
  compareMessage.value = ''
  compareOpen.value = true
}

/** Reka restores focus to the pre-dialog element; the OCR dialog owns that choice. */
function preventAutoFocus(event: Event) {
  event.preventDefault()
}

function onCompareOpen(value: boolean) {
  compareOpen.value = value
  if (value) return
  const trigger = compareTrigger.value
  compareTrigger.value = null
  void nextTick(() => {
    if (trigger?.isConnected) {
      trigger.focus()
      return
    }
    // In-dialog paging remounts the keyed page row, so the original click target
    // can be gone. Fall back to the current page's own compare entry.
    if (currentPage.value === null) return
    const current = document.querySelector(
      `[aria-label="放大看${pageLabel(currentPage.value)}"]`,
    )
    if (current instanceof HTMLElement) current.focus()
  })
}

function comparePrev() {
  if (!compareCanPrev.value) return
  navigate(pages.value[pageIndex.value - 1]!)
}
function compareNext() {
  if (!compareCanNext.value) return
  navigate(pages.value[pageIndex.value + 1]!)
}

async function copyCompare() {
  try {
    await navigator.clipboard.writeText(currentRow.value?.result?.markdown ?? '')
    compareMessage.value = '已复制原文'
  } catch {
    compareMessage.value = '复制失败，请切到源码后手动选择复制。'
  }
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return !!target.closest(
    'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="popover-content"]',
  )
}

function onRootEscape(event: KeyboardEvent) {
  if (
    compareOpen.value ||
    fileOpen.value ||
    filterOpen.value ||
    jumpOpen.value
  )
    return
  if (!editing.value || pendingPage.value !== null) return
  event.preventDefault()
  cancelEdit()
}

function onKeydown(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  )
    return
  if (
    editing.value ||
    compareOpen.value ||
    fileOpen.value ||
    filterOpen.value ||
    jumpOpen.value
  )
    return
  if (isTypingTarget(event.target)) return
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    goPrev()
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    goNext()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function selectAndClose(path: string) {
  selectFile(path)
}
</script>

<template>
  <div
    class="ocr-workbench bg-page flex h-[calc(100dvh-5.5rem)] min-h-0 flex-col overflow-hidden md:h-[calc(100dvh-6rem)]"
    aria-label="识别校对工作台"
    @keydown.esc="onRootEscape"
  >
    <header class="bg-card shrink-0 border-b">
      <div class="flex h-14 min-w-0 items-center gap-2 px-2.5 sm:px-3">
        <span class="hidden shrink-0 text-sm font-semibold md:inline">识别校对</span>

        <div
          role="region"
          aria-label="当前文件与页号"
          class="flex min-w-0 flex-1 items-center gap-1"
        >
          <Button
            variant="outline"
            size="sm"
            class="max-w-[52vw] min-w-0 sm:max-w-xs"
            aria-label="选择 PDF 文件"
            :disabled="writeBusy"
            @click="fileOpen = true"
          >
            <FileText class="shrink-0" />
            <span class="truncate">{{ displayName || '选择 PDF' }}</span>
            <ChevronDown class="shrink-0 opacity-60" />
          </Button>

          <Popover v-model:open="jumpOpen">
            <PopoverTrigger as-child>
              <Button
                variant="ghost"
                size="sm"
                class="shrink-0 gap-1 tabular-nums"
                :disabled="currentPage === null"
                aria-label="跳转实际页号"
                title="跳到实际页号"
              >
                <span aria-live="polite">
                  {{
                    currentPage === null
                      ? '无命中页'
                      : `第 ${currentPage} / ${rows.length} 页`
                  }}
                </span>
                <ChevronDown class="size-3.5 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" class="w-64">
              <form class="flex flex-col gap-2" @submit.prevent="goToPage">
                <label class="text-xs font-medium" for="ocr-jump">跳到实际页号</label>
                <div class="flex items-center gap-2">
                  <Input
                    id="ocr-jump"
                    v-model="jump"
                    class="w-24"
                    inputmode="numeric"
                    aria-label="跳转实际页号"
                  />
                  <Button size="sm" :disabled="!pages.length">跳转</Button>
                </div>
                <p v-if="jumpError" role="alert" class="text-destructive text-xs">
                  {{ jumpError }}
                </p>
                <p v-else class="text-muted-foreground text-[11px]">
                  当前命中 {{ pages.length }} 页
                </p>
              </form>
            </PopoverContent>
          </Popover>
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="size-9"
                aria-label="工作台更多操作"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-52">
              <DropdownMenuGroup>
                <DropdownMenuItem @select="refreshAll">
                  <RefreshCw />
                  刷新文件与结果
                </DropdownMenuItem>
                <DropdownMenuItem
                  :disabled="!canImport"
                  :title="canImport ? undefined : IMPORT_NOT_READY"
                  @select="importOpen = true"
                >
                  <Upload />
                  导入识别结果
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="
                    selectedPath &&
                    (renderedCount < (pageCount ?? 0) || renderedCount === 0)
                  "
                  :disabled="rendering || writeBusy"
                  @select="renderPageImages"
                >
                  <Loader2 v-if="rendering" class="animate-spin motion-reduce:animate-none" />
                  <Images v-else />
                  {{ rendering ? '渲染中…' : '渲染页图' }}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <!-- 文件级身份只在这里出现一次：计数、筛选入口与活跃条件、状态行。 -->
      <div
        v-if="selectedPath"
        class="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-t px-2.5 py-1.5 text-xs sm:px-3"
      >
        <span class="shrink-0 tabular-nums">共 {{ rows.length }} 页</span>
        <span class="text-muted-foreground shrink-0 tabular-nums">
          有文本 {{ counts.text }} · 空结果 {{ counts.empty }} · 未识别
          {{ counts.none }}
        </span>
        <Badge
          v-if="currentPage !== null"
          :variant="STATE_BADGE[currentState]"
          class="shrink-0"
          >{{ STATE_WORD[currentState] }}</Badge
        >
        <span
          v-if="activeFilterCount"
          class="text-muted-foreground shrink-0 tabular-nums"
          >命中 {{ visibleRows.length }} 页</span
        >

        <Button
          variant="outline"
          size="sm"
          class="h-7 shrink-0 px-2"
          :disabled="!ready || !!detailError"
          @click="filterOpen = true"
        >
          <Filter />
          筛选<template v-if="activeFilterCount">
            <span class="tabular-nums">{{ activeFilterCount }}</span></template
          >
        </Button>

        <!-- 桌面：逐条 chip；移动：一条截断摘要，避免多行 chips 把首屏挤掉。 -->
        <span class="hidden min-w-0 flex-wrap items-center gap-1 sm:flex">
          <Badge
            v-for="chip in filterChips"
            :key="chip.key"
            variant="quiet"
            class="max-w-52 gap-1"
          >
            <span class="truncate">{{ chip.label }}</span>
            <button
              type="button"
              class="hover:text-foreground focus-visible:ring-ring rounded-xs focus-visible:ring-2 focus-visible:outline-none"
              :aria-label="`移除筛选：${chip.label}`"
              :disabled="dirty"
              @click="chip.remove"
            >
              <X class="size-3" />
            </button>
          </Badge>
          <Button
            v-if="activeFilterCount && visibleRows.length"
            variant="ghost"
            size="sm"
            class="h-7 px-1.5 text-xs"
            :disabled="dirty"
            @click="clearFilters"
            >清除条件</Button
          >
        </span>
        <span
          v-if="activeFilterCount"
          class="text-muted-foreground min-w-0 flex-1 truncate text-[11px] sm:hidden"
          :title="filterSummary"
          >{{ filterSummary }}</span
        >

        <span class="ml-auto flex min-w-0 items-center gap-2">
          <span
            v-if="dirty"
            role="status"
            class="text-foreground max-w-full truncate text-[11px] font-medium"
            title="有未保存的草稿，请先保存或取消编辑，再切换文件、页面或筛选。"
            >有未保存的草稿，请先保存或取消编辑，再切换文件、页面或筛选。</span
          >
          <template v-else>
            <span
              v-if="status"
              role="status"
              class="max-w-full truncate text-[11px]"
              :class="
                status.tone === 'error'
                  ? 'text-destructive font-medium'
                  : 'text-muted-foreground'
              "
              :title="status.message"
              >{{ status.message }}</span
            >
            <span
              v-if="notice && visibleRows.length"
              role="status"
              class="text-muted-foreground max-w-full truncate text-[11px]"
              :title="notice"
              >{{ notice }}</span
            >
            <span
              v-if="detailLoading && loadedPath"
              role="status"
              class="text-muted-foreground truncate text-[11px]"
              >正在刷新，保留上次成功读取的当前文件内容…</span
            >
          </template>
        </span>
      </div>
      <div v-else class="text-muted-foreground border-t px-3 py-2 text-xs">
        选择一份文件后，这里显示页数与识别状态。
      </div>
    </header>

    <main class="relative min-h-0 flex-1 overflow-hidden" aria-label="校对内容">
      <div
        v-if="!selectedPath"
        class="flex h-full items-center justify-center p-6"
      >
        <Empty class="border-0 bg-transparent">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileSearch /></EmptyMedia>
            <EmptyTitle>选择一份 PDF 开始校对</EmptyTitle>
            <EmptyDescription>
              文件选择在顶栏；切换文件才会重置页码与页筛选。
            </EmptyDescription>
          </EmptyHeader>
          <Button size="sm" @click="fileOpen = true">选择 PDF</Button>
        </Empty>
      </div>

      <div
        v-else-if="detailLoading && !loadedPath"
        class="flex h-full flex-col gap-2 p-3"
      >
        <Skeleton class="h-10 w-full" />
        <Skeleton class="h-full w-full" />
      </div>

      <div
        v-else-if="detailError && !loadedPath"
        class="flex h-full items-center justify-center p-6"
      >
        <Empty class="border-0 bg-transparent">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileWarning /></EmptyMedia>
            <EmptyTitle>读不到这份文件的结果</EmptyTitle>
            <EmptyDescription>{{ detailError }}</EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            size="sm"
            :disabled="detailLoading"
            @click="selectedPath && loadDetail(selectedPath)"
          >
            <RefreshCw />
            重试
          </Button>
        </Empty>
      </div>

      <div
        v-else-if="!rows.length"
        class="flex h-full items-center justify-center p-6"
      >
        <Empty class="border-0 bg-transparent">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileText /></EmptyMedia>
            <EmptyTitle>这一页还没有可校对的内容</EmptyTitle>
            <EmptyDescription>
              读不到这份 PDF 的页数（文件可能已损坏或被移走），所以列不出页码。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>

      <div
        v-else-if="!visibleRows.length && !currentRow"
        class="flex h-full items-center justify-center p-6"
      >
        <Empty class="border-0 bg-transparent">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileText /></EmptyMedia>
            <EmptyTitle>没有命中页</EmptyTitle>
            <EmptyDescription>
              调整条件或清除当前筛选，恢复这份文件的全部实际页。
            </EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            size="sm"
            :disabled="dirty"
            @click="clearFilters"
            >清除页筛选</Button
          >
        </Empty>
      </div>

      <div v-else class="flex h-full min-h-0 flex-col">
        <Tabs
          :model-value="view"
          class="shrink-0 gap-0 border-b px-2 py-1.5 lg:hidden"
          @update:model-value="(value) => setView(String(value) as OcrView)"
        >
          <TabsList class="grid w-full grid-cols-3" aria-label="校对视图">
            <TabsTrigger value="text">文本</TabsTrigger>
            <TabsTrigger value="image">页图</TabsTrigger>
            <TabsTrigger value="compare">对照</TabsTrigger>
          </TabsList>
        </Tabs>

        <Alert
          v-if="detailError && loadedPath"
          variant="destructive"
          class="mx-2 mt-2 shrink-0"
        >
          <AlertDescription class="text-destructive! font-medium">
            {{ detailError }}
            <Button
              variant="outline"
              size="sm"
              class="ml-2"
              @click="selectedPath && loadDetail(selectedPath)"
              >重试读取</Button
            >
          </AlertDescription>
        </Alert>

        <ul role="list" class="min-h-0 flex-1 p-2 sm:p-3">
          <Transition
            enter-active-class="transition duration-150 ease-snap motion-reduce:transition-none"
            enter-from-class="translate-y-1 opacity-0"
            leave-active-class="hidden"
          >
            <OcrPageRow
              v-if="currentRow"
              ref="pageRow"
              :key="`${selectedPath}:${currentRow.page}`"
              :row="currentRow"
              :file-path="selectedPath"
              :image-version="imageVersion"
              :editing="editing"
              :draft="draft"
              :pending="pendingPage === currentRow.page"
              :failure="rowFailureMessage"
              :disabled="detailLoading || !!detailError"
              :highlight="justSaved === currentRow.page"
              :view="view"
              class="h-full"
              @update:draft="draft = $event"
              @save="(page, markdown) => savePage(page, markdown)"
              @remove="removeCurrent"
              @preview="(_page, trigger) => openCompare(trigger)"
              @retry="retry"
              @render="renderPageImages"
            />
          </Transition>
        </ul>
      </div>
    </main>

    <OcrBottomBar
      ref="bottomBar"
      :current-page="currentPage"
      :pages="pages"
      :editing="editing"
      :dirty="dirty"
      :pending="pendingPage !== null"
      :disabled="writeBusy || !ready || !!detailError"
      :can-edit="canEdit"
      :edit-label="editLabel"
      @navigate="navigate"
      @edit="startEdit"
      @save="saveDraft"
      @cancel="cancelEdit"
    />

    <OcrFilePicker
      v-model:open="fileOpen"
      :file-matches="fileMatches"
      :total="pdfFiles.length"
      :file-years="fileYears"
      :keyword="keyword"
      :source="source"
      :year="year"
      :selected-path="selectedPath"
      :selected="selected"
      :current-page-count="rows.length"
      :current-counts="counts"
      :current-loading="detailLoading"
      :files-loading="filesLoading"
      :files-error="filesError"
      :disabled="writeBusy"
      @filter="setFileFilter"
      @select="selectAndClose"
      @retry="loadFiles"
    />

    <OcrFilterPanel
      v-model:open="filterOpen"
      :filters="filters"
      :disabled="writeBusy || dirty || !ready"
      @filter="applyFilters"
    />

    <OcrImportDialog
      v-model:open="importOpen"
      :filename="selected?.filename ?? ''"
      :page-numbers="pageNumbers"
      :page-count="pageCount"
      :pending="importPending"
      :failure="importFailure"
      :result="importResult"
      @submit="runImport"
    />

    <!-- 当前页对照：390 上下、桌面左右；弹窗内可继续翻页，Esc 回到原焦点。 -->
    <Dialog :open="compareOpen" @update:open="onCompareOpen">
      <DialogContent
        data-ocr-comparison
        class="flex h-[92vh] w-[96vw] flex-col gap-2 border-0 bg-transparent p-0 shadow-none sm:max-w-[min(1500px,96vw)] [&_[data-slot=dialog-close]]:top-2 [&_[data-slot=dialog-close]]:z-20"
        @close-auto-focus="preventAutoFocus"
      >
        <div class="bg-card flex flex-col gap-1 rounded-md border px-3 py-2 pr-12">
          <div class="flex min-w-0 items-center gap-2">
            <DialogTitle class="min-w-0 truncate text-sm">
              <span class="sm:hidden">{{ pageLabel(currentPage ?? 1) }}</span>
              <span class="hidden sm:inline"
                >{{ displayName }} · {{ pageLabel(currentPage ?? 1) }}</span
              >
            </DialogTitle>
            <Badge :variant="STATE_BADGE[currentState]" class="shrink-0">{{
              STATE_WORD[currentState]
            }}</Badge>
            <div class="ml-auto flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                aria-label="对照上一页"
                :disabled="!compareCanPrev"
                @click="comparePrev"
              >
                <ChevronLeft />
                <span class="hidden sm:inline">上一页</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label="对照下一页"
                :disabled="!compareCanNext"
                @click="compareNext"
              >
                <span class="hidden sm:inline">下一页</span>
                <ChevronRight />
              </Button>
            </div>
          </div>
          <DialogDescription class="text-muted-foreground text-[13px] leading-relaxed">
            <span class="text-foreground font-medium sm:hidden"
              >{{ displayName }} · </span
            >{{ compareDescription }}
          </DialogDescription>
        </div>

        <div
          class="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:grid-rows-1"
        >
          <div class="flex h-full min-h-0 flex-col">
            <ImagePreview
              v-if="currentImageSrc"
              data-comparison-image
              class="min-h-0"
              :src="currentImageSrc"
              name="页图"
              hide-kind-label
              :zoom-min="PAGE_IMAGE_ZOOM_MIN"
            />
            <div
              v-else
              class="bg-card text-muted-foreground flex h-full items-center justify-center rounded-lg border text-sm"
            >
              这一页还没有页图
            </div>
          </div>

          <section
            class="bg-card ocr-text-pane flex min-h-0 flex-col overflow-hidden rounded-lg border"
            aria-label="对照识别文本"
          >
            <header class="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
              <div
                class="bg-muted flex shrink-0 items-center gap-0.5 rounded-md p-0.5"
                role="group"
                aria-label="对照正文显示方式"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  :class="
                    compareMode === 'rendered'
                      ? 'bg-background text-foreground shadow-sm hover:bg-background'
                      : 'text-muted-foreground'
                  "
                  :aria-pressed="compareMode === 'rendered'"
                  @click="compareMode = 'rendered'"
                  >预览</Button
                >
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  :class="
                    compareMode === 'source'
                      ? 'bg-background text-foreground shadow-sm hover:bg-background'
                      : 'text-muted-foreground'
                  "
                  :aria-pressed="compareMode === 'source'"
                  @click="compareMode = 'source'"
                  >源码</Button
                >
              </div>
              <div class="ml-auto flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  :class="compareWrap ? 'text-foreground' : 'text-muted-foreground'"
                  :aria-pressed="compareWrap"
                  @click="compareWrap = !compareWrap"
                >
                  <WrapText />
                  <span class="hidden sm:inline">自动换行</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-8"
                  aria-label="复制对照原文"
                  @click="copyCompare"
                >
                  <Copy />
                </Button>
              </div>
            </header>
            <p
              v-if="compareMessage"
              role="status"
              class="text-muted-foreground shrink-0 border-b px-3 py-1 text-[11px]"
            >
              {{ compareMessage }}
            </p>
            <OcrPageBody
              v-if="currentRow?.result && currentRow.result.markdown.trim()"
              :markdown="currentRow.result.markdown"
              :file-path="selectedPath"
              :page="currentRow.page"
              :mode="compareMode"
              :wrap="compareWrap"
              :hide-toolbar="true"
              class="min-h-0 flex-1"
              content-class="p-4"
            />
            <div
              v-else
              class="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-sm"
            >
              <FileText class="size-5" />
              <p class="text-foreground font-medium">
                {{ currentRow?.result ? '这一页的识别结果是空文本' : '这一页还没有识别文本' }}
              </p>
              <p class="text-xs">关掉对照后可以在底部手工录入。</p>
            </div>
            <footer
              class="text-muted-foreground flex h-7 shrink-0 items-center border-t px-2.5 text-[11px]"
            >
              <span class="truncate">{{ compareMeta || '没有识别结果' }}</span>
              <span class="ml-auto shrink-0">{{ STATE_WORD[currentState] }}</span>
            </footer>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.ocr-text-pane {
  --code-font-size: var(--ocr-code-size);
}
.ocr-text-pane :deep(.preview-content) {
  font-size: var(--ocr-prose-size);
  line-height: var(--ocr-prose-leading);
}
.ocr-text-pane :deep(.preview-content h1) {
  font-size: clamp(1.5rem, 2.2vw, 1.75rem);
  line-height: 1.3;
}
.ocr-text-pane :deep(.preview-content h2) {
  font-size: 1.25rem;
  line-height: 1.35;
}
.ocr-text-pane :deep(.preview-content table),
.ocr-text-pane :deep(.preview-content pre) {
  font-size: var(--ocr-code-size);
}

/* Short viewports (e.g. a 200% browser zoom on a laptop) need the pixels for
 * the document, not for the duplicate horizontal-affordance strip. The styled
 * native scrollbar and the table itself remain available. */
@media (max-height: 560px) {
  .ocr-workbench :deep([data-ocr-horizontal-hint]) {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  :global([data-ocr-comparison]),
  :global([data-ocr-comparison] *),
  :global([data-slot='dialog-overlay']:has(~ [data-ocr-comparison])) {
    animation: none;
    transition: none;
  }
}
</style>
