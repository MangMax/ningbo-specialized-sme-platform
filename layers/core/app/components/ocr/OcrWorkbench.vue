<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { ChevronDown, FileText } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import { useOcrWorkbench } from '#core/app/composables/useOcrWorkbench'
import { pageReviewState } from '#core/lib/ocr-workbench'
import OcrBottomBar from './OcrBottomBar.vue'
import OcrCompareDialog from './OcrCompareDialog.vue'
import OcrDiscardDraftDialog from './OcrDiscardDraftDialog.vue'
import OcrDocumentWorkspace from './OcrDocumentWorkspace.vue'
import OcrFilePicker from './OcrFilePicker.vue'
import OcrFilterPanel from './OcrFilterPanel.vue'
import OcrImportDialog from './OcrImportDialog.vue'
import OcrPageJump from './OcrPageJump.vue'
import OcrWorkbenchHeader from './OcrWorkbenchHeader.vue'
import { useOcrDraft } from './useOcrDraft'
import { useOcrKeyboard } from './useOcrKeyboard'

const workbench = useOcrWorkbench()
const {
  contentMessage,
  refreshAll,
  detailLoading,
  filesLoading,
  filesError,
  loadFiles,
  pdfFiles,
  fileMatches,
  fileYears,
  fileSources,
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
  navigate,
  status,
  loadedPath,
  detailError,
  loadDetail,
  rows,
  imageVersion,
  pendingPage,
  rowFailure,
  needsRead,
  justSaved,
  savePage,
  importOpen,
  importPending,
  importFailure,
  importResult,
  runImport,
  pageNumbers,
} = workbench

const isNarrow = useMediaQuery('(max-width: 1023px)')
const workspace = useTemplateRef<InstanceType<typeof OcrDocumentWorkspace>>('workspace')
const bottomBar = useTemplateRef<InstanceType<typeof OcrBottomBar>>('bottomBar')
const comparison = useTemplateRef<InstanceType<typeof OcrCompareDialog>>('comparison')
const fileTrigger = useTemplateRef<InstanceType<typeof Button>>('fileTrigger')
const fileOpen = ref(false)
const filterOpen = ref(false)
const compareOpen = ref(false)
const pageNavOpen = ref(false)

const {
  editing,
  draft,
  discardOpen,
  canEdit,
  editLabel,
  startEdit,
  cancelEdit,
  leaveEdit,
  keepEditing,
  onDiscardOpen,
  saveDraft,
  retry,
  removeCurrent,
} = useOcrDraft(workbench, isNarrow, {
  editor: (reset) => workspace.value?.focusEditor(reset),
  editButton: () => { void bottomBar.value?.focusEdit() },
  pager: () => { void bottomBar.value?.focusBar() },
})

const { onRootEscape } = useOcrKeyboard({
  overlayOpen: () =>
    discardOpen.value || compareOpen.value || fileOpen.value || filterOpen.value || pageNavOpen.value,
  editing: () => editing.value,
  saving: () => pendingPage.value !== null,
  cancelEdit,
  goPrev,
  goNext,
})

const pages = computed(() => visibleRows.value.map((row) => row.page))
const pageIndex = computed(() =>
  currentPage.value === null ? -1 : pages.value.indexOf(currentPage.value),
)
const currentState = computed(() =>
  pageReviewState(currentRow.value?.result ?? null),
)

const filtered = computed(() =>
  !!(filters.value.states.length || filters.value.range.trim() || filters.value.text.trim()),
)
const displayName = computed(
  () => selected.value?.displayName || selected.value?.filename || selectedPath.value,
)

function clearFilters() {
  setFilters({ states: [], range: '', text: '' })
}

function goPrev() {
  if (pageIndex.value > 0) navigate(pages.value[pageIndex.value - 1]!)
}

function goNext() {
  if (pageIndex.value >= 0 && pageIndex.value < pages.value.length - 1)
    navigate(pages.value[pageIndex.value + 1]!)
}

function selectAndClose(path: string) {
  // The sheet owns no close policy: only an accepted selection closes it.
  // A dirty draft leaves the sheet open with the reason visible instead of
  // swallowing the click.
  if (selectFile(path)) fileOpen.value = false
}

function focusFileTrigger(event: Event) {
  event.preventDefault()
  void nextTick(() => fileTrigger.value?.$el?.focus())
}

/** Why the file rows are not switchable right now (shown inside the sheet). */
const fileSheetBlockedReason = computed(() =>
  dirty.value
    ? '有未保存的草稿，请先保存或取消编辑，再切换文件。'
    : writeBusy.value
      ? '写入处理中，请完成后再切换文件。'
      : '',
)

function restoreCompareFocus() {
  workspace.value?.focusCompare()
}
</script>

<template>
  <div
    class="ocr-workbench bg-page flex h-[calc(100dvh-5.5rem)] min-h-0 flex-col overflow-hidden md:h-[calc(100dvh-6rem)]"
    aria-label="识别校对工作台"
    @keydown.esc="onRootEscape"
  >
    <h1 class="sr-only">识别校对</h1>
    <!-- 顶栏、工作区、底栏共用同一列容器与左右锚线：三块同宽、同圆角、同描边，
         不会再出现“通栏硬边横条贴着圆角卡片”的割裂。 -->
    <div class="ocr-shell flex min-h-0 flex-1 flex-col gap-2 p-2">
      <OcrWorkbenchHeader
        v-model:filter-open="filterOpen"
        :selected-path="selectedPath"
        :counts="counts"
        :current-page="currentPage"
        :current-state="currentState"
        :filters="filters"
        :visible-count="visibleRows.length"
        :dirty="dirty"
        :write-busy="writeBusy"
        :ready="ready"
        :detail-loading="detailLoading"
        :detail-error="detailError"
        :loaded-path="loadedPath"
        :status="status"
        :notice="notice"
        :can-import="canImport"
        :import-not-ready="IMPORT_NOT_READY"
        :rendered-count="renderedCount"
        :page-count="pageCount"
        :rendering="rendering"
        @filter="setFilters"
        @refresh="refreshAll"
        @import="importOpen = true"
        @render="renderPageImages"
      >
        <Button
          ref="fileTrigger"
          variant="outline"
          size="sm"
          class="max-w-[52vw] min-w-0 sm:max-w-xs"
          aria-label="选择 PDF 文件"
          aria-haspopup="dialog"
          :aria-expanded="fileOpen"
          :disabled="writeBusy"
          @click="fileOpen = true"
        >
          <FileText class="shrink-0" />
          <span class="truncate" :title="displayName || '选择 PDF'">{{
            displayName || '选择 PDF'
          }}</span>
          <ChevronDown class="shrink-0 opacity-60" />
        </Button>

        <OcrPageJump
          v-model:open="pageNavOpen"
          :is-narrow="isNarrow"
          :pages="pages"
          :rows="rows"
          :current-page="currentPage"
          :counts="counts"
          :filtered="filtered"
          :image-version="imageVersion"
          :dirty="dirty"
          :write-busy="writeBusy"
          :ready="ready"
          :detail-error="detailError"
          @navigate="navigate"
          @clear-filters="clearFilters"
        />
      </OcrWorkbenchHeader>

      <OcrDocumentWorkspace
        ref="workspace"
        :view="view"
        v-model:draft="draft"
        :selected-path="selectedPath"
        :loaded-path="loadedPath"
        :content-message="contentMessage"
        :detail-loading="detailLoading"
        :detail-error="detailError"
        :total-pages="rows.length"
        :visible-count="visibleRows.length"
        :current-row="currentRow"
        :image-version="imageVersion"
        :editing="editing"
        :dirty="dirty"
        :pending-page="pendingPage"
        :row-failure="rowFailure"
        :needs-read="needsRead"
        :just-saved="justSaved"
        @update:view="workbench.setView"
        @reload="selectedPath && loadDetail(selectedPath)"
        @retry="retry"
        @clear-filters="clearFilters"
        @save="savePage"
        @remove="removeCurrent"
        @preview="comparison?.openCompare($event)"
        @render="renderPageImages"
      />

      <OcrBottomBar
        ref="bottomBar"
        :current-page="currentPage"
        :pages="pages"
        :editing="editing"
        :dirty="dirty"
        :pending="pendingPage !== null"
        :disabled="writeBusy || !ready || !!detailError || needsRead"
        :can-edit="canEdit"
        :edit-label="editLabel"
        @navigate="navigate"
        @edit="startEdit"
        @save="saveDraft"
        @cancel="cancelEdit"
      />
    </div>

    <OcrFilePicker
      v-model:open="fileOpen"
      :file-matches="fileMatches"
      :total="pdfFiles.length"
      :file-years="fileYears"
      :file-sources="fileSources"
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
      @close-auto-focus="focusFileTrigger"
    />

    <OcrFilterPanel
      v-model:open="filterOpen"
      :filters="filters"
      :disabled="writeBusy || dirty || !ready"
      @filter="setFilters"
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

    <OcrCompareDialog
      ref="comparison"
      v-model:open="compareOpen"
      :selected-path="selectedPath"
      :display-name="displayName"
      :current-row="currentRow"
      :current-page="currentPage"
      :current-state="currentState"
      :image-version="imageVersion"
      :is-narrow="isNarrow"
      :dirty="dirty"
      :write-busy="writeBusy"
      :page-index="pageIndex"
      :pages="pages"
      @navigate="navigate"
      @restore-focus="restoreCompareFocus"
    />

    <OcrDiscardDraftDialog
      :open="discardOpen"
      :current-page="currentPage"
      @update:open="onDiscardOpen"
      @keep="keepEditing"
      @discard="leaveEdit"
    />
  </div>
</template>

<style scoped>
/*
 * Very short viewports (e.g. 720x450 ≈ 200% reflow): keep 8+ lines reachable by
 * collapsing secondary chrome. Counts stay available in the page-jump popover;
 * the filter entry moves into the top row.
 */
@media (max-height: 560px) {
  /*
   * 短视口不拿留白换“圆角感”：shell 归零，卡片退成贴边横条（去掉左右圆角与
   * 左右边框），把宝贵的行数全部留给文档。桌面/常规高度仍是同宽圆角表面。
   */
  .ocr-shell {
    padding: 0;
    gap: 0;
  }
  .ocr-shell > header,
  .ocr-shell > .ocr-bottombar {
    border-radius: 0;
    border-right-width: 0;
    border-left-width: 0;
  }
  .ocr-bottombar {
    height: 2.5rem;
  }
}
</style>
