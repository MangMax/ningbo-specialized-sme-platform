<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Copy, FileText, WrapText } from '@lucide/vue'
import { Badge } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '#core/app/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'
import ImagePreview from '#core/app/components/preview/ImagePreview.vue'
import { PAGE_IMAGE_ZOOM_MIN, pageLabel } from '#core/lib/page-gallery'
import { STATE_BADGE, STATE_WORD, type PageReviewState, type WorkbenchRow } from '#core/lib/ocr-workbench'
import OcrPageBody from './OcrPageBody.vue'

const {
  currentRow,
  selectedPath,
  currentPage,
  imageVersion,
  isNarrow,
  dirty,
  writeBusy,
  pageIndex,
  pages,
} = defineProps<{
  selectedPath: string
  displayName: string
  currentRow: WorkbenchRow | null
  currentPage: number | null
  currentState: PageReviewState
  imageVersion: string | null
  isNarrow: boolean
  dirty: boolean
  writeBusy: boolean
  pageIndex: number
  pages: number[]
}>()
const compareOpen = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ navigate: [page: number]; restoreFocus: [] }>()

const compareTrigger = ref<HTMLElement | null>(null)
const compareMode = ref<'rendered' | 'source'>('rendered')
const hasCompareText = computed(() => !!currentRow?.result?.markdown.trim())
const compareWrap = ref(true)
const compareMessage = ref('')

// In-dialog paging follows the selected row. A different file or a missing row closes the dialog.
watch(() => selectedPath, () => { compareOpen.value = false })
watch(() => currentRow, (row) => {
  if (!row) compareOpen.value = false
})

const currentImageSrc = computed(() => {
  const url = currentRow?.image?.url
  if (!url) return ''
  return imageVersion
    ? `${url}?v=${encodeURIComponent(imageVersion)}`
    : url
})
const compareMeta = computed(() => {
  const result = currentRow?.result
  if (!result) return ''
  return [result.model || result.engine, formatTime(result.createdAt)]
    .filter(Boolean)
    .join(' · ')
})
const compareDescription = computed(() =>
  isNarrow
    ? '上方是页图，下方是识别文本（只读）。关闭后停留当前对照页。'
    : '左侧是页图，右侧是识别文本（只读）。关闭后停留当前对照页。',
)
const compareCanPrev = computed(
  () => !dirty && !writeBusy && pageIndex > 0,
)
const compareCanNext = computed(
  () =>
    !dirty &&
    !writeBusy &&
    pageIndex >= 0 &&
    pageIndex < pages.length - 1,
)

function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function openCompare(trigger?: HTMLElement) {
  if (!currentRow) return
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
    if (currentPage === null) return
    emit('restoreFocus')
  })
}

function comparePrev() {
  if (!compareCanPrev.value) return
  emit('navigate', pages[pageIndex - 1]!)
}
function compareNext() {
  if (!compareCanNext.value) return
  emit('navigate', pages[pageIndex + 1]!)
}

async function copyCompare() {
  try {
    await navigator.clipboard.writeText(currentRow?.result?.markdown ?? '')
    compareMessage.value = '已复制原文'
  } catch {
    compareMessage.value = '复制失败，请切到源码后手动选择复制。'
  }
}

defineExpose({ openCompare })
</script>

<template>
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
        <DialogDescription class="text-muted-foreground text-table leading-relaxed">
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
          <Tabs
            :model-value="hasCompareText ? compareMode : 'rendered'"
            class="min-h-0 flex-1 gap-0"
            @update:model-value="compareMode = $event === 'source' ? 'source' : 'rendered'"
          >
            <header class="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
              <TabsList class="h-8 shrink-0" aria-label="对照正文显示方式">
                <TabsTrigger value="rendered" class="text-xs">预览</TabsTrigger>
                <TabsTrigger value="source" class="text-xs" :disabled="!hasCompareText">源码</TabsTrigger>
              </TabsList>
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
            <TabsContent
              v-for="mode in ['rendered', 'source'] as const"
              :key="mode"
              :value="mode"
              :tabindex="hasCompareText ? -1 : 0"
              class="min-h-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <OcrPageBody
                v-if="hasCompareText && currentRow?.result"
                :markdown="currentRow.result.markdown"
                :file-path="selectedPath"
                :page="currentRow.page"
                :mode="mode"
                :wrap="compareWrap"
                :hide-toolbar="true"
                content-class="p-4"
              />
              <div
                v-else
                class="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm"
              >
                <FileText class="size-5" />
                <p class="text-foreground font-medium">
                  {{ currentRow?.result ? '这一页的识别结果是空文本' : '这一页还没有识别文本' }}
                </p>
                <p class="text-xs">关掉对照后可以在底部手工录入。</p>
              </div>
            </TabsContent>
            <footer
              data-ocr-pane-footer
              class="text-muted-foreground flex h-7 shrink-0 items-center border-t px-2.5 text-[11px]"
            >
              <span class="truncate">{{ compareMeta || '没有识别结果' }}</span>
              <span class="ml-auto shrink-0">{{ STATE_WORD[currentState] }}</span>
            </footer>
          </Tabs>
        </section>
      </div>
    </DialogContent>
  </Dialog>
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

@media (prefers-reduced-motion: reduce) {
  :global([data-ocr-comparison]),
  :global([data-ocr-comparison] *),
  :global([data-slot='dialog-overlay']:has(~ [data-ocr-comparison])) {
    animation: none;
    transition: none;
  }
}
</style>
