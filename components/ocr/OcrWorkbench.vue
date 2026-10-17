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
  confirmPageSaved,
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
 * Discard confirmation. A long proofreading session must not lose its page to a
 * stray Esc or a mis-clicked 取消; the dialog is the only path that clears a dirty
 * draft. Esc inside this dialog closes the dialog (reka) and must not then also
 * exit editing — the root Esc handler bails while it is open.
 */
const discardOpen = ref(false)

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
const rowFailureAction = computed(() =>
  rowFailure.value?.page === currentPage.value ? rowFailure.value.action : '',
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
    ? '上方是页图，下方是识别文本（只读）。关闭后停留当前对照页。'
    : '左侧是页图，右侧是识别文本（只读）。关闭后停留当前对照页。',
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
  // Unchanged draft: leaving costs nothing, so don't interrupt.
  if (!dirty.value) {
    leaveEdit()
    return
  }
  discardOpen.value = true
}

/** The confirmed (or no-op) exit from editing. */
function leaveEdit() {
  discardOpen.value = false
  editing.value = false
  draft.value = ''
  void bottomBar.value?.focusEdit()
}

/** Keep the draft and put the caret back where the user was working. */
function keepEditing() {
  discardOpen.value = false
  void nextTick(() => pageRow.value?.focusEditor())
}

/**
 * Esc inside the discard dialog closes only the dialog. When the user is still
 * editing afterwards, focus goes back to the editor (not to the body).
 */
function onDiscardOpen(value: boolean) {
  discardOpen.value = value
  if (!value && editing.value) {
    void nextTick(() => pageRow.value?.focusEditor())
  }
}

function saveDraft() {
  if (!currentRow.value) return
  void savePage(currentRow.value.page, draft.value)
}

/**
 * Inline retry is dispatched by the **failure origin**, not by whether the editor
 * happens to be open. A committed write whose readback was missing must only GET;
 * re-POSTing here would silently turn "readback missing" into a second write.
 */
async function retry() {
  const failure = rowFailure.value
  if (failure?.action === 'read') {
    if (!selectedPath.value) return
    await loadDetail(selectedPath.value)
    if (detailError.value || failure.page !== currentPage.value) return
    // The retried read succeeded: verify the original draft against what the
    // server actually returns before leaving edit mode.
    if (
      editing.value &&
      currentRow.value &&
      confirmPageSaved(currentRow.value.page, draft.value)
    ) {
      discardOpen.value = false
      editing.value = false
      draft.value = ''
      if (currentRow.value) void bottomBar.value?.focusEdit()
      else void bottomBar.value?.focusBar()
    }
    return
  }
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
    // can be gone. Fall back to the current page's own compare entry (the pane
    // header control exists at every width, including the mobile image viewer).
    if (currentPage.value === null) return
    const current = document.querySelector(
      '[aria-label="打开当前页对照"]',
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

/**
 * Controls that own their own arrow-key behavior (inputs, menus, tabs, buttons,
 * links…). The global pager must never `preventDefault()` on those.
 */
function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return !!target.closest(
    'input, textarea, select, button, a[href], summary, [contenteditable="true"], [role="textbox"], [role="menu"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [role="button"], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="popover-content"]',
  )
}

/**
 * Content that scrolls on its own (wide tables, source blocks, the rendered
 * preview). ←/→ belongs to that scroller; if it were intercepted the keyboard
 * user could never reach columns 8–17 of a long table.
 */
function isScrollableContent(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return !!target.closest(
    '.preview-content, .safe-preview-html, pre, [data-ocr-scroll-region]',
  )
}

function onRootEscape(event: KeyboardEvent) {
  if (
    discardOpen.value ||
    compareOpen.value ||
    fileOpen.value ||
    filterOpen.value ||
    jumpOpen.value
  )
    return
  if (!editing.value || pendingPage.value !== null) return
  event.preventDefault()
  // Dirty drafts get an explicit discard confirmation; a clean edit exits at once.
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
    discardOpen.value ||
    editing.value ||
    compareOpen.value ||
    fileOpen.value ||
    filterOpen.value ||
    jumpOpen.value
  )
    return
  if (isInteractiveTarget(event.target) || isScrollableContent(event.target))
    return
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
  // The sheet owns no close policy: only an accepted selection closes it.
  // A dirty draft leaves the sheet open with the reason visible instead of
  // swallowing the click.
  if (selectFile(path)) fileOpen.value = false
}

/** Why the file rows are not switchable right now (shown inside the sheet). */
const fileSheetBlockedReason = computed(() =>
  dirty.value
    ? '有未保存的草稿，请先保存或取消编辑，再切换文件。'
    : writeBusy.value
      ? '写入处理中，请完成后再切换文件。'
      : '',
)
</script>

<template>
  <div
    class="ocr-workbench bg-page flex h-[calc(100dvh-5.5rem)] min-h-0 flex-col overflow-hidden md:h-[calc(100dvh-6rem)]"
    aria-label="识别校对工作台"
    @keydown.esc="onRootEscape"
  >
    <header class="bg-card shrink-0 border-b">
      <div class="ocr-topbar flex h-14 min-w-0 items-center gap-2 px-2.5 sm:px-3">
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
            <span class="truncate" :title="displayName || '选择 PDF'">{{
              displayName || '选择 PDF'
            }}</span>
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
                <p v-else class="text-muted-foreground text-[11px] leading-relaxed">
                  当前命中 {{ pages.length }} 页 · 全文件 {{ rows.length }} 页 ·
                  有文本 {{ counts.text }} · 空结果 {{ counts.empty }} · 未识别
                  {{ counts.none }}
                </p>
              </form>
            </PopoverContent>
          </Popover>
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-1">
          <!-- Short viewports hide the metadata row to give the document height;
               the filter entry and its active count move up here. -->
          <Button
            variant="ghost"
            size="sm"
            class="ocr-short-filter hidden h-8 gap-1 px-2"
            :disabled="!ready || !!detailError"
            aria-label="筛选当前文件"
            @click="filterOpen = true"
          >
            <Filter />
            <span v-if="activeFilterCount" class="tabular-nums">{{
              activeFilterCount
            }}</span>
          </Button>
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
        class="ocr-meta-row flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-t px-2.5 py-1.5 text-xs sm:px-3"
      >
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

        <!-- Chips stay removable at every width (390 included): one horizontally
             scrollable row on narrow screens, wrapped from sm up. -->
        <span
          class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto sm:flex-wrap sm:overflow-visible"
        >
          <Badge
            v-for="chip in filterChips"
            :key="chip.key"
            variant="quiet"
            class="max-w-44 shrink-0 gap-1 sm:max-w-52"
          >
            <span class="truncate">{{ chip.label }}</span>
            <button
              type="button"
              class="hover:bg-foreground/10 focus-visible:ring-ring -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:outline-none"
              :aria-label="`移除筛选：${chip.label}`"
              :disabled="dirty"
              @click="chip.remove"
            >
              <X class="size-3.5" />
            </button>
          </Badge>
          <Button
            v-if="activeFilterCount && visibleRows.length"
            variant="ghost"
            size="sm"
            class="h-7 shrink-0 px-1.5 text-xs"
            :disabled="dirty"
            @click="clearFilters"
            >清除条件</Button
          >
        </span>

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

    <main
      class="ocr-workspace-scroll relative min-h-0 flex-1 overflow-hidden"
      aria-label="校对内容"
    >
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
          class="ocr-view-tabs shrink-0 gap-0 border-b px-2 py-1.5 lg:hidden"
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
              @click="retry"
              >重试读取</Button
            >
          </AlertDescription>
        </Alert>

        <ul role="list" class="ocr-workspace-list min-h-0 flex-1 p-2 sm:p-3">
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
              :failure-action="rowFailureAction"
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
      :blocked-reason="fileSheetBlockedReason"
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
          class="ocr-compare-grid grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-3"
        >
          <div class="flex h-full min-h-0 flex-col">
            <ImagePreview
              v-if="currentImageSrc"
              data-comparison-image
              class="min-h-0"
              :src="currentImageSrc"
              name="页图"
              hide-kind-label
              :fit-mode="isNarrow ? 'width' : 'contain'"
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
              data-ocr-pane-footer
              class="text-muted-foreground flex h-7 shrink-0 items-center border-t px-2.5 text-[11px]"
            >
              <span class="truncate">{{ compareMeta || '没有识别结果' }}</span>
              <span class="ml-auto shrink-0">{{ STATE_WORD[currentState] }}</span>
            </footer>
          </section>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Discarding a dirty draft is the only destructive exit from editing:
         without this dialog both 取消 and Esc used to drop the page silently. -->
    <Dialog :open="discardOpen" @update:open="onDiscardOpen">
      <DialogContent class="sm:max-w-md" @close-auto-focus="preventAutoFocus">
        <div class="flex flex-col gap-1.5">
          <DialogTitle>放弃未保存的校对？</DialogTitle>
          <DialogDescription class="text-[13px] leading-relaxed">
            第 {{ currentPage ?? 1 }} 页还有未保存的修改。放弃后这次编辑的内容会被丢弃，且无法撤销。
          </DialogDescription>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <Button variant="outline" @click="keepEditing">继续编辑</Button>
          <Button variant="destructive" @click="leaveEdit">放弃草稿</Button>
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

/*
 * Wide compare dialog: the image is height-limited, so giving it ≈950px only
 * creates dead space beside it. Size the image column from the available height
 * (A4 aspect), let the text column take the rest, and keep the text scrollable.
 */
.ocr-compare-grid {
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
}
@media (min-width: 1024px) {
  .ocr-compare-grid {
    grid-template-columns:
      minmax(0, min(46%, calc((92vh - 10rem) * 0.72)))
      minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
}

/*
 * Short-height compare dialog: squeezing two panes into ~160px each turns the
 * page image into a thumbnail. Stack one column and let the dialog body scroll,
 * giving both panes a real reading height.
 */
@media (max-width: 1023.98px) and (max-height: 560px) {
  .ocr-compare-grid {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .ocr-compare-grid > * {
    flex: 0 0 auto;
    min-height: 300px;
  }
}

/*
 * Short viewports and narrow screens: keep the workspace at a readable minimum
 * and let it scroll inside `main`. The fixed bottom bar stays reachable, the
 * document itself still does not scroll, and the text/editor never collapse to
 * a two-line strip.
 */
@media (max-height: 640px) {
  .ocr-workspace-scroll {
    overflow-y: auto;
  }
  .ocr-workspace-list {
    min-height: 340px;
  }
  .ocr-workbench :deep([data-ocr-page-row]) {
    min-height: 340px;
  }
  /* Stacked compare on a short screen: give both panes a real reading height
     and let the workspace scroll between them (single-column fallback). */
  .ocr-workbench :deep(li:has(> div[data-ocr-compare-row])) {
    min-height: 520px;
  }
}
/*
 * Very short viewports (e.g. 720x450 ≈ 200% reflow): keep 8+ lines reachable by
 * collapsing secondary chrome. Counts stay available in the page-jump popover;
 * the filter entry moves into the top row.
 */
@media (max-height: 560px) {
  .ocr-meta-row {
    display: none;
  }
  .ocr-short-filter {
    display: inline-flex;
  }
  .ocr-topbar {
    height: 2.5rem;
  }
  .ocr-view-tabs {
    padding-top: 0;
    padding-bottom: 0;
  }
  .ocr-view-tabs :deep([data-slot='tabs-list']) {
    height: 1.75rem;
  }
  .ocr-workspace-list {
    padding: 0;
  }
  .ocr-workbench :deep([data-ocr-pane-header]) {
    height: 2rem;
  }
  .ocr-workbench :deep([data-ocr-pane-footer]) {
    display: none;
  }
  .ocr-bottombar {
    height: 2.5rem;
  }
}
@media (max-height: 520px) {
  .ocr-workbench :deep([data-ocr-pane-footer]) {
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
