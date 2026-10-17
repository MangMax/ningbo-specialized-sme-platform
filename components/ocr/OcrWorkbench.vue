<script setup lang="ts">
import { useOcrWorkbench } from '@/composables/useOcrWorkbench'
import OcrPageNavigation from './OcrPageNavigation.vue'
import OcrPageBody from './OcrPageBody.vue'
import OcrFilePicker from './OcrFilePicker.vue'
import OcrImportDialog from './OcrImportDialog.vue'
import OcrPageRow from './OcrPageRow.vue'
import ImagePreview from '@/components/preview/ImagePreview.vue'
import {
  FileText,
  FileWarning,
  Images,
  Loader2,
  RefreshCw,
  Upload,
} from '@lucide/vue'
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import {
  pendingLabel,
  reviewBreakdown,
  STATE_BADGE,
  STATE_WORD,
} from '~~/lib/ocr-workbench'
import { PAGE_IMAGE_ZOOM_MIN, pageLabel } from '~~/lib/page-gallery'
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
  justSaved,
  savePage,
  removePage,
  previewPage,
  previewSrc,
  previewRow,
  previewState,
  previewMeta,
  importOpen,
  importPending,
  importFailure,
  importResult,
  runImport,
  pageNumbers,
} = useOcrWorkbench()
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader title="识别校对" description="逐页对着页图核对 OCR 文本。">
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="detailLoading || writeBusy"
          @click="refreshAll"
        >
          <RefreshCw />
          刷新
        </Button>
      </template>
    </PageHeader>

    <div
      class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]"
    >
      <!-- 左栏:选文件。宽屏**吸顶** —— 翻到第 40 页还能换文件,不必滚回顶部
           (一份 56 页的 PDF 实测 16774px)。 -->
      <OcrFilePicker
        :file-matches="fileMatches"
        :total="pdfFiles.length"
        :file-years="fileYears"
        :keyword="keyword"
        :source="source"
        :year="year"
        :selected-path="selectedPath"
        :files-loading="filesLoading"
        :files-error="filesError"
        :disabled="writeBusy"
        @filter="setFileFilter"
        @select="selectFile"
        @retry="loadFiles"
      />

      <!-- 右栏:逐页校对。 -->
      <div class="flex min-w-0 flex-col gap-3">
        <Empty v-if="!selectedPath" class="bg-card rounded-lg border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Images /></EmptyMedia>
            <EmptyTitle>先选一份 PDF</EmptyTitle>
          </EmptyHeader>
        </Empty>

        <template v-else>
          <!-- 文件条**吸顶**:翻到几十页之后,当前是哪一份、还剩几页要校对、导入入口
               都还在视野里。`top-14` 让开顶栏(布局里那条 `sticky top-0 z-30`)。 -->
          <div
            aria-label="当前文件与页号"
            role="region"
            class="bg-card sticky top-14 z-20 flex flex-col gap-x-3 gap-y-2 rounded-lg border px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center"
          >
            <span
              class="min-w-0 truncate text-sm font-medium sm:flex-1"
              :title="selected?.filename"
            >
              {{ selected?.displayName || selected?.filename || selectedPath }}
            </span>

            <span class="shrink-0 text-xs tabular-nums"
              >{{
                currentPage === null ? '无命中页' : `第 ${currentPage} 页`
              }}
              / {{ rows.length }} 页</span
            >
            <span class="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Badge :variant="counts.none ? 'dashed' : 'solid'">{{
                pendingLabel(counts)
              }}</Badge>
              <span class="text-muted-foreground text-xs tabular-nums">
                {{ reviewBreakdown(counts) }}
              </span>

              <span class="flex items-center gap-2">
                <Button
                  v-if="renderedCount < (pageCount ?? 0) || renderedCount === 0"
                  variant="outline"
                  size="sm"
                  :disabled="rendering"
                  @click="renderPageImages"
                >
                  <Loader2
                    v-if="rendering"
                    class="animate-spin motion-reduce:animate-none"
                  />
                  {{ rendering ? '渲染中…' : '渲染页图' }}
                </Button>
                <Button
                  size="sm"
                  :disabled="!canImport"
                  :title="canImport ? undefined : IMPORT_NOT_READY"
                  @click="importOpen = true"
                >
                  <Upload />
                  导入结果
                </Button>
              </span>
            </span>
          </div>

          <OcrPageNavigation
            :filters="filters"
            :pages="visibleRows.map((r) => r.page)"
            :current-page="currentPage"
            :total="rows.length"
            :disabled="writeBusy || dirty || !ready"
            @filter="setFilters"
            @navigate="navigate"
          />
          <p v-if="notice" role="status" class="text-muted-foreground text-xs">
            {{ notice }}
          </p>
          <p v-if="dirty" role="status" class="text-sm">
            有未保存的草稿，请先保存或取消编辑，再切换文件、页面或筛选。
          </p>
          <p
            v-if="detailLoading && loadedPath"
            role="status"
            class="text-muted-foreground text-xs"
          >
            正在刷新，保留上次成功读取的当前文件内容…
          </p>
          <Alert v-if="detailError && loadedPath" variant="destructive"
            ><AlertDescription
              >{{ detailError
              }}<Button
                variant="outline"
                size="sm"
                @click="loadDetail(selectedPath)"
                >重试</Button
              ></AlertDescription
            ></Alert
          >
          <!-- 状态条:`Alert` 自带 `role="alert"`(隐式 `aria-live="assertive"`),
               所以读屏会在动作完成后念出这句话 —— 行内只是换了几个字,不足以当反馈。 -->
          <Alert
            v-if="status"
            :variant="status.tone === 'error' ? 'destructive' : 'default'"
          >
            <AlertDescription
              :class="
                status.tone === 'error' ? 'text-destructive! font-medium' : ''
              "
            >
              {{ status.message }}
            </AlertDescription>
          </Alert>

          <div v-if="detailLoading && !loadedPath" class="flex flex-col gap-2">
            <Skeleton v-for="i in 3" :key="i" class="h-24 w-full" />
          </div>

          <!-- 读回失败(页图或**逐页正文**拿不到):**一页都不给**。
               没有行就没有编辑框,也就不会出现「对着空框保存、把真实文本抹掉」那条路
               —— 这是 B2 那条「读不到正文不许冒充空结果」的界面落点。 -->
          <Empty
            v-else-if="detailError && !loadedPath"
            class="bg-card rounded-lg border py-12"
          >
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

          <Empty
            v-else-if="!rows.length"
            class="bg-card rounded-lg border py-12"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileText /></EmptyMedia>
              <EmptyTitle>这一页还没有可校对的内容</EmptyTitle>
              <EmptyDescription>
                读不到这份 PDF 的页数(文件可能已损坏或被移走),所以列不出页码。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>

          <!-- 「只看待校对」把要做的页挑出来之后,可能一页不剩(也可能这份文件本来就没有)。 -->
          <Empty
            v-else-if="!visibleRows.length && !currentRow"
            class="bg-card rounded-lg border py-10"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileText /></EmptyMedia>
              <EmptyTitle>没有命中页</EmptyTitle>
              <EmptyDescription
                >调整条件或清除页筛选，恢复这份文件的全部实际页。</EmptyDescription
              >
            </EmptyHeader>
            <Button
              variant="outline"
              size="sm"
              @click="setFilters({ states: [], range: '', text: '' })"
              >清除页筛选</Button
            >
          </Empty>

          <ul v-else class="flex flex-col gap-2" role="list">
            <Transition
              enter-active-class="transition-opacity duration-150 ease-snap motion-reduce:transition-none"
              enter-from-class="opacity-0"
              leave-active-class="hidden"
            >
              <OcrPageRow
                v-if="currentRow"
                :id="`ocr-row-${currentRow.page}`"
                :key="`${selectedPath}:${currentRow.page}`"
                class="scroll-mt-32"
                :row="currentRow"
                :file-path="selectedPath"
                :image-version="imageVersion"
                :disabled="detailLoading || !!detailError"
                @dirty="dirty = $event"
                :pending="pendingPage === currentRow.page"
                :failure="
                  rowFailure?.page === currentRow.page ? rowFailure.message : ''
                "
                :highlight="justSaved === currentRow.page"
                @save="savePage"
                @remove="removePage"
                @preview="previewPage = $event"
              />
            </Transition>
          </ul>
        </template>
      </div>
    </div>

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

    <Dialog
      :open="previewPage !== null"
      @update:open="(v: boolean) => !v && (previewPage = null)"
    >
      <DialogContent
        class="flex h-[92vh] w-[96vw] flex-col border-0 bg-transparent p-0 shadow-none sm:max-w-[min(1500px,96vw)] [&_[data-slot=dialog-close]]:top-2 [&_[data-slot=dialog-close]]:z-10 [&_[role=toolbar]]:pr-10"
      >
        <DialogTitle class="sr-only">
          {{
            previewPage === null
              ? ''
              : `${selected?.filename ?? ''}${pageLabel(previewPage)}`
          }}
        </DialogTitle>
        <DialogDescription class="sr-only">
          左边是这一页的页图,右边是它的识别文本(只读)。按 Esc 或点右上角关闭。
        </DialogDescription>

        <div
          class="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]"
        >
          <ImagePreview
            v-if="previewSrc"
            class="min-h-0"
            :src="previewSrc"
            :name="previewPage === null ? '' : pageLabel(previewPage)"
            hide-kind-label
            :zoom-min="PAGE_IMAGE_ZOOM_MIN"
          />
          <div
            class="bg-card flex min-h-0 flex-col gap-2 overflow-hidden rounded-lg border p-3"
          >
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge :variant="STATE_BADGE[previewState]">{{
                STATE_WORD[previewState]
              }}</Badge>
              <span v-if="previewMeta" class="text-muted-foreground text-xs">{{
                previewMeta
              }}</span>
            </div>
            <!-- 与行内同一条规则:空结果就写「(空)」,不再说「还没有识别文本」——
                 那句话属于「未识别」那一档。 -->
            <OcrPageBody
              v-if="previewRow?.result"
              :markdown="previewRow.result.markdown"
              :file-path="selectedPath"
              :page="previewRow.page"
              class="min-h-0 flex-1"
            />
            <p v-else class="text-muted-foreground text-xs leading-relaxed">
              这一页还没有识别文本。关掉之后在列表里点「手工录入」可以贴进来。
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
