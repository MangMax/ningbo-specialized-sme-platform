<script setup lang="ts">
import { historicalContentMessage } from '~~/lib/file-content-status'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import {
  Check,
  Copy,
  Download,
  Expand,
  FileText,
  ImageOff,
  Loader2,
  MoreHorizontal,
  MoveHorizontal,
  RefreshCw,
  Trash2,
  WrapText,
  X,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import type { WorkbenchRow } from '~~/lib/ocr-workbench'
import { pageReviewState, STATE_WORD } from '~~/lib/ocr-workbench'
import { OCR_CHANNELS } from '~~/lib/labels'
import { PAGE_IMAGE_ZOOM_MIN, pageLabel } from '~~/lib/page-gallery'
import ImagePreview from '@/components/preview/ImagePreview.vue'
import OcrPageBody from './OcrPageBody.vue'

const props = defineProps<{
  row: WorkbenchRow
  filePath: string
  /** 页图地址的版本号（渲染时间），避免换 DPI 后命中旧缓存。 */
  imageVersion?: string | null
  editing: boolean
  draft: string
  /** 写入/删除请求正在飞。 */
  pending?: boolean
  /** 最近一次写入/删除失败的说明。 */
  failure?: string
  /**
   * 这次失败该由哪种动作重试：`save` 重新提交、`read` 只重读、
   * `delete` 先重新确认删除、`conflict` 重新读取并保留编辑稿。空串表示没有失败。
   */
  failureAction?: 'save' | 'delete' | 'read' | 'conflict' | ''
  /** 刷新/错误快照仍可读，但不能写。 */
  disabled?: boolean
  /** 写入成功读回后的一次高亮。 */
  highlight?: boolean
  /** 窄屏当前视图；桌面始终双栏。 */
  view: 'text' | 'image' | 'compare'
}>()

const emit = defineEmits<{
  'update:draft': [value: string]
  save: [page: number, markdown: string]
  remove: [page: number]
  preview: [page: number, trigger?: HTMLElement]
  retry: []
  render: []
}>()

/** 窄屏用真实查看器（fit-width + 平移/缩放/全屏），不再把整页 contain 成缩略图。 */
const isNarrow = useMediaQuery('(max-width: 1023px)')

/** A failed DELETE is re-attempted only through the explicit confirmation. */
function retryFailure() {
  if (props.failureAction === 'delete') askDelete()
  else emit('retry')
}

function failureRetryLabel() {
  if (props.failureAction === 'conflict') return '重新读取'
  if (props.failureAction === 'delete') return '重试删除'
  if (props.failureAction === 'read') return '重试读取'
  if (props.failureAction === 'save') return '重试保存'
  return '重试'
}

/** Keep the actual trigger so Esc can return focus even after a programmatic click. */
function openPreview(event: MouseEvent) {
  emit('preview', props.row.page, event.currentTarget as HTMLElement)
}

const sourceMode = ref<'rendered' | 'source'>('rendered')
const wrap = ref(true)
const deleteOpen = ref(false)
const copyMessage = ref('')
const overflowTrigger = ref<{ $el?: HTMLButtonElement } | null>(null)
const editor = ref<{ $el?: HTMLTextAreaElement } | null>(null)
const imageViewer = ref<{
  zoomBy: (factor: number) => void
  fit: () => void
} | null>(null)
const textPaneBody = ref<HTMLElement | null>(null)
const hasHorizontalOverflow = ref(false)

const result = computed(() => props.row.result)
const image = computed(() => props.row.image)
const state = computed(() => pageReviewState(result.value))
const markdown = computed(() => result.value?.markdown ?? '')
const hasText = computed(() => markdown.value.trim().length > 0)
const dirty = computed(
  () => props.editing && props.draft !== (result.value?.markdown ?? ''),
)

const imageSrc = computed(() => {
  const url = image.value?.url
  if (!url) return ''
  return props.imageVersion
    ? `${url}?v=${encodeURIComponent(props.imageVersion)}`
    : url
})

const metaParts = computed(() => {
  const r = result.value
  if (!r) return []
  return [OCR_CHANNELS[r.channel] ?? r.channel, r.model || r.engine].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  )
})

const timeText = computed(() =>
  result.value ? formatTime(result.value.createdAt) : '',
)

function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * Focus ownership token. `focusEl` waits a few frames because overlays can move
 * focus after they unmount; a *new* focus intent (opening the delete dialog,
 * confirming it, downloading) cancels any older pending loop, so a stale
 * "return to the row menu" request cannot steal focus long after the row's
 * action has completed.
 *
 * The token also has to gate the caller's follow-up work: a superseded request
 * still resolves (it returns early on its next frame), so its continuation must
 * know it lost ownership. Otherwise an old "fresh edit resets to the document
 * head" continuation can run after a newer intent already restored the user's
 * caret. `focusEl` therefore resolves to its request generation, or `null` when
 * a newer intent superseded it; the caller re-checks that generation when its
 * continuation runs (a newer intent may start in between).
 */
let focusRequest = 0

function cancelPendingFocus() {
  focusRequest += 1
}

async function focusEl(target: {
  value: { $el?: HTMLElement } | null
}): Promise<number | null> {
  const request = ++focusRequest
  for (let frame = 0; frame < 4; frame += 1) {
    await nextTick()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    if (request !== focusRequest) return null
    const el = target.value?.$el
    if (!el || typeof el.focus !== 'function') continue
    el.focus()
    if (document.activeElement === el) return request
  }
  // Exhausted the retry window while still owning the intent: the caller may
  // apply its policy (the target may simply have been absent).
  return request === focusRequest ? request : null
}

/** Last caret place before the editor lost focus (e.g. the discard dialog). */
const savedCaret = ref<{ start: number; end: number } | null>(null)

function rememberCaret() {
  const el = editor.value?.$el
  if (!(el instanceof HTMLTextAreaElement)) return
  savedCaret.value = { start: el.selectionStart, end: el.selectionEnd }
}

/**
 * Focus the editor. `reset: true` is for a fresh edit (start at the document
 * head). Returning from the discard confirmation uses `reset: false`: the draft
 * and the caret the user was working at are still there, and re-entering at
 * 0,0 would silently throw their place away.
 */
function focusEditor(reset = true) {
  // Capture the caret before the focus dance: browsers keep the selection
  // across blur, but jsdom (and some focus implementations) reset it to 0.
  const current = editor.value?.$el
  const caret = !reset
    ? (savedCaret.value ??
      (current instanceof HTMLTextAreaElement
        ? { start: current.selectionStart, end: current.selectionEnd }
        : null))
    : null
  void focusEl(editor).then((request) => {
    // A newer focus intent superseded this one (or started while this
    // continuation was queued): it owns the caret now.
    if (request === null || request !== focusRequest) return
    const el = editor.value?.$el
    if (!(el instanceof HTMLTextAreaElement)) return
    if (!reset) {
      if (caret) el.setSelectionRange(caret.start, caret.end)
      return
    }
    savedCaret.value = null
    // Entering edit should start at the document head, not wherever the
    // browser's default caret-at-end put the scroll position. On a short
    // viewport the browser's focus scroll can also leave the first line half
    // clipped; align the editor top with its scroller explicitly.
    if (typeof el.scrollIntoView === 'function')
      el.scrollIntoView({ block: 'start', inline: 'nearest' })
    el.setSelectionRange(0, 0)
    el.scrollTop = 0
  })
}

defineExpose({ focusEditor })

async function copyText() {
  const text = markdown.value
  try {
    await navigator.clipboard.writeText(text)
    copyMessage.value = '已复制原文'
  } catch {
    copyMessage.value = '复制失败，请切到源码后手动选择复制。'
  }
  window.setTimeout(() => {
    copyMessage.value = ''
  }, 2200)
}

function download() {
  const blob = new Blob([markdown.value], {
    type: 'text/plain;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${pageLabel(props.row.page)}.md`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  void focusEl(overflowTrigger)
}

function askDelete() {
  cancelPendingFocus()
  deleteOpen.value = true
}

function confirmDelete() {
  cancelPendingFocus()
  deleteOpen.value = false
  emit('remove', props.row.page)
}

function cancelDelete() {
  deleteOpen.value = false
  void focusEl(overflowTrigger)
}

/**
 * After a confirmed delete the row may leave the filter; the parent then moves
 * focus to the fixed bottom bar. Stop reka from restoring focus to the removed
 * overflow trigger a frame later and stealing it back.
 */
function preventDeleteAutoFocus(event: Event) {
  event.preventDefault()
}

/**
 * The row menu must not restore focus to its trigger on close.
 *
 * With the delete flow that restore can land *after* the row has already been
 * deleted and the parent moved focus to the bottom bar, silently stealing it
 * back. Ownership is explicit instead: download returns focus to the trigger;
 * the delete dialog owns focus while it is open, and the parent owns it after.
 */
function preventMenuAutoFocus(event: Event) {
  event.preventDefault()
}

/** 长表/源码在窄容器里可能横向溢出；给一条可见的「还能往右看」提示。 */
function measureHorizontalOverflow() {
  const root = textPaneBody.value
  if (!root) {
    hasHorizontalOverflow.value = false
    return
  }
  // Safe HTML tables and code blocks create their own horizontal scrollers.
  // Measure the content wrapper and those inner scrollers, not only the wrapper
  // (whose scrollWidth stays equal to its clientWidth when a child owns overflow).
  const candidates = [
    root.querySelector('.preview-content'),
    ...root.querySelectorAll('.safe-preview-html, pre'),
  ].filter((node): node is HTMLElement => node instanceof HTMLElement)
  hasHorizontalOverflow.value = candidates.some(
    (node) => node.scrollWidth > node.clientWidth + 1,
  )
}

let observer: ResizeObserver | null = null
let mutation: MutationObserver | null = null

function observeOverflow() {
  observer?.disconnect()
  mutation?.disconnect()
  const el = textPaneBody.value
  if (!el || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => measureHorizontalOverflow())
  observer.observe(el)
  mutation = new MutationObserver(() => measureHorizontalOverflow())
  mutation.observe(el, { childList: true, subtree: true, characterData: true })
  measureHorizontalOverflow()
}

watch(
  () => props.row.page,
  () => {
    sourceMode.value = 'rendered'
    copyMessage.value = ''
    deleteOpen.value = false
    void nextTick(() => {
      observeOverflow()
      if (props.editing) focusEditor()
    })
  },
)

watch(
  () => props.editing,
  (editing) => {
    if (!editing) return
    void nextTick(() => focusEditor())
  },
)

watch(
  () => [sourceMode.value, wrap.value, props.row.page, props.editing],
  () => {
    void nextTick(() => {
      observeOverflow()
    })
  },
)

onMounted(() => {
  void nextTick(() => observeOverflow())
})
onBeforeUnmount(() => {
  cancelPendingFocus()
  observer?.disconnect()
  mutation?.disconnect()
})
</script>

<template>
  <li
    data-ocr-page-row
    class="h-full min-h-0 list-none"
    :class="highlight ? 'ring-primary/25 ring-2' : ''"
  >
    <div
      class="grid h-full min-h-0 grid-cols-1 gap-3"
      :data-ocr-compare-row="view === 'compare' ? '' : undefined"
      :class="
        view === 'compare'
          ? 'grid-rows-[minmax(0,55fr)_minmax(0,45fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-rows-1'
          : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
      "
    >
      <!-- 页图：真值。桌面与文本并排；窄屏是独立 tab / 对照上半屏。 -->
      <section
        aria-label="当前页页图"
        class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md"
        :class="[
          view === 'text' ? 'hidden lg:flex' : 'flex',
          // The narrow viewer is its own card; avoid card-in-card chrome.
          isNarrow && image ? 'border-0 bg-transparent' : 'bg-card border',
        ]"
      >
        <header
          data-ocr-pane-header
          class="flex h-10 shrink-0 items-center gap-2 border-b px-2.5"
        >
          <span class="text-xs font-medium">页图</span>
          <div class="ml-auto flex items-center gap-1">
            <template v-if="isNarrow && image">
              <Button
                variant="ghost"
                size="icon"
                class="size-8"
                aria-label="缩小页图"
                title="缩小页图"
                @click="imageViewer?.zoomBy(1 / 1.25)"
              >
                <ZoomOut />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="size-8"
                aria-label="放大页图"
                title="放大页图"
                @click="imageViewer?.zoomBy(1.25)"
              >
                <ZoomIn />
              </Button>
            </template>
            <Button
              v-if="image"
              variant="ghost"
              size="sm"
              aria-label="打开当前页对照"
              @click="openPreview"
            >
              <Expand />
              <span class="hidden sm:inline">对照</span>
            </Button>
            <Button
              v-else
              variant="outline"
              size="sm"
              :disabled="disabled || pending"
              @click="emit('render')"
            >
              <RefreshCw />
              渲染页图
            </Button>
          </div>
        </header>
        <p v-if="result" role="status" class="shrink-0 border-b px-3 py-2 text-sm break-words">{{ historicalContentMessage(result.historicalBinding) }}</p>
        <div
          :key="`${filePath}:${row.page}:image`"
          class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2 lg:p-3"
        >
          <!-- Narrow screens get a real viewer: page width fills the pane and the
               user can pan/zoom/fullscreen. A contain-only thumbnail is not a
               comparison surface. -->
          <ImagePreview
            v-if="image && isNarrow"
            ref="imageViewer"
            class="h-full w-full min-h-0"
            :src="imageSrc"
            name="页图"
            hide-kind-label
            fit-mode="width"
            :zoom-min="PAGE_IMAGE_ZOOM_MIN"
          />
          <button
            v-else-if="image"
            type="button"
            class="group focus-visible:border-ring focus-visible:ring-ring/50 relative flex h-full w-full items-center justify-center rounded-sm transition-shadow hover:ring-2 hover:ring-primary/20 focus-visible:ring-3 focus-visible:outline-none motion-reduce:transition-none"
            :aria-label="`放大看${pageLabel(row.page)}`"
            @click="openPreview"
          >
            <img
              :src="imageSrc"
              alt=""
              loading="lazy"
              decoding="async"
              class="h-full w-full object-contain"
              draggable="false"
            />
            <!-- A corner affordance instead of a 35% black wash: the page image is
                 the evidence being proofread and must keep its contrast on hover. -->
            <span
              data-ocr-zoom-hint
              class="bg-background/95 pointer-events-none absolute top-2 right-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
            >
              <Expand class="size-3.5" />
              放大
            </span>
          </button>
          <div
            v-else
            class="text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-2 rounded-sm border border-dashed px-4 text-center text-xs leading-relaxed"
          >
            <ImageOff class="size-5" />
            <span>这一页还没有页图。{{ image ? '' : '渲染后即可对照。' }}</span>
            <Button
              variant="outline"
              size="sm"
              :disabled="disabled || pending"
              @click="emit('render')"
            >
              <RefreshCw />
              渲染页图
            </Button>
          </div>
        </div>
      </section>

      <!-- 文本：阅读 / 源码 / 原始 Markdown 编辑。 -->
      <section
        aria-label="当前页识别文本"
        class="bg-card ocr-text-pane flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border"
        :class="view === 'image' ? 'hidden lg:flex' : 'flex'"
      >
        <header
          data-ocr-pane-header
          class="flex h-10 shrink-0 items-center gap-1.5 border-b px-2"
        >
          <template v-if="editing">
            <span class="text-xs font-medium">原始 Markdown</span>
            <Badge v-if="dirty" variant="dashed" class="shrink-0">未保存</Badge>
          </template>
          <template v-else>
            <div
              class="bg-muted flex shrink-0 items-center gap-0.5 rounded-md p-0.5"
              role="group"
              aria-label="正文显示方式"
            >
              <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                :class="
                  sourceMode === 'rendered'
                    ? 'bg-background text-foreground shadow-sm hover:bg-background'
                    : 'text-muted-foreground'
                "
                :aria-pressed="sourceMode === 'rendered'"
                @click="sourceMode = 'rendered'"
                >预览</Button
              >
              <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                :class="
                  sourceMode === 'source'
                    ? 'bg-background text-foreground shadow-sm hover:bg-background'
                    : 'text-muted-foreground'
                "
                :aria-pressed="sourceMode === 'source'"
                :disabled="!hasText"
                @click="sourceMode = 'source'"
                >源码</Button
              >
            </div>
            <div class="ml-auto flex min-w-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                :class="wrap ? 'text-foreground' : 'text-muted-foreground'"
                :aria-pressed="wrap"
                title="自动换行"
                @click="wrap = !wrap"
              >
                <WrapText />
                <span class="hidden sm:inline">自动换行</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="size-8"
                aria-label="复制原文"
                title="复制原文"
                :disabled="!hasText"
                @click="copyText"
              >
                <Copy />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    ref="overflowTrigger"
                    variant="ghost"
                    size="icon"
                    class="size-8"
                    aria-label="本页更多操作"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  @close-auto-focus="preventMenuAutoFocus"
                >
                  <DropdownMenuItem :disabled="!hasText" @select="download">
                    <Download />
                    下载原文
                  </DropdownMenuItem>
                  <template v-if="result">
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      :disabled="pending || disabled"
                      @select="askDelete"
                    >
                      <Trash2 />
                      删除本页结果…
                    </DropdownMenuItem>
                  </template>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </template>
        </header>
        <p v-if="result" role="status" class="shrink-0 border-b px-3 py-2 text-sm break-words">{{ historicalContentMessage(result.historicalBinding) }}</p>

        <p
          v-if="copyMessage"
          role="status"
          class="text-muted-foreground shrink-0 border-b px-3 py-1 text-[11px]"
        >
          {{ copyMessage }}
        </p>

        <Alert v-if="failure" variant="destructive" class="rounded-none border-x-0 border-t-0">
          <AlertDescription class="text-destructive! flex flex-wrap items-center gap-2 font-medium">
            <span>{{ failure }}</span>
            <Button variant="outline" size="sm" @click="retryFailure">
              {{ failureRetryLabel() }}</Button
            >
          </AlertDescription>
        </Alert>

        <div
          ref="textPaneBody"
          :key="`${filePath}:${row.page}:text`"
          class="min-h-0 flex-1 overflow-hidden"
        >
          <Textarea
            v-if="editing"
            ref="editor"
            :model-value="draft"
            :readonly="pending"
            :aria-label="`${pageLabel(row.page)}的 OCR 文本`"
            spellcheck="false"
            class="h-full min-h-0 w-full resize-none rounded-none border-0 bg-transparent p-4 font-mono text-[length:var(--ocr-code-size)] leading-relaxed shadow-none transition-none focus-visible:ring-0 motion-reduce:transition-none"
            placeholder="这一页的识别文本（原始 Markdown）。空白页留空即可——空结果也会占住页号。"
            @update:model-value="emit('update:draft', $event)"
            @select="rememberCaret"
            @keyup="rememberCaret"
            @click="rememberCaret"
            @blur="rememberCaret"
          />
          <OcrPageBody
            v-else-if="hasText"
            :markdown="markdown"
            :file-path="filePath"
            :page="row.page"
            :mode="sourceMode"
            :wrap="wrap"
            :hide-toolbar="true"
            content-class="p-4 lg:p-5"
          />
          <div
            v-else
            class="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm leading-relaxed"
          >
            <FileText class="size-5" />
            <p class="text-foreground font-medium">
              {{ result ? STATE_WORD[state] : '这一页还没有识别文本' }}
            </p>
            <p class="text-table leading-relaxed">
              {{
                result
                  ? '这一页的正文为空（已保存为空结果）。可以编辑、手工补录，或继续翻页。'
                  : '可以用底部的「手工录入」贴入这一页的文本，或继续翻页。'
              }}
            </p>
          </div>
        </div>

        <div
          v-if="hasHorizontalOverflow && !editing"
          data-ocr-horizontal-hint
          class="text-muted-foreground bg-muted/50 flex h-7 shrink-0 items-center gap-1.5 border-t px-2.5 text-[11px]"
        >
          <MoveHorizontal class="size-3.5" />
          内容较宽，左右滚动查看全部列
        </div>

        <footer
          data-ocr-pane-footer
          class="text-muted-foreground flex h-7 shrink-0 items-center gap-2 border-t px-2.5 text-[11px]"
        >
          <template v-if="editing">
            <span class="truncate">
              保存使用原始 Markdown；预览只读，不参与保存。
            </span>
          </template>
          <template v-else-if="result">
            <span class="truncate" :title="[...metaParts, timeText].filter(Boolean).join(' · ')">
              {{ [...metaParts, timeText].filter(Boolean).join(' · ') }}
            </span>
            <span class="ml-auto shrink-0">{{ STATE_WORD[state] }}</span>
          </template>
          <template v-else>
            <span>未识别</span>
          </template>
        </footer>
      </section>
    </div>

    <Dialog v-model:open="deleteOpen">
      <DialogContent
        class="sm:max-w-md"
        @close-auto-focus="preventDeleteAutoFocus"
      >
        <DialogHeader>
          <DialogTitle>删除这一页的识别结果？</DialogTitle>
          <DialogDescription>
            {{ filePath.split('/').pop() }} · {{ pageLabel(row.page) }}。只删这一页的文本，不动页图与台账；删除后重做要重新识别。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" :disabled="pending" @click="cancelDelete">
            取消
          </Button>
          <Button variant="destructive" :disabled="pending" @click="confirmDelete">
            <Loader2 v-if="pending" class="animate-spin motion-reduce:animate-none" />
            <Trash2 v-else />
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </li>
</template>

<style scoped>
.ocr-text-pane {
  --code-font-size: var(--ocr-code-size);
}

.ocr-text-pane :deep(.preview-content) {
  font-size: var(--ocr-prose-size);
  line-height: var(--ocr-prose-leading);
}

/* 窄 pane 里 36px 的 Markdown H1 会压过正文；降到 24–28px。 */
.ocr-text-pane :deep(.preview-content h1) {
  font-size: clamp(1.5rem, 2.2vw, 1.75rem);
  line-height: 1.3;
}

.ocr-text-pane :deep(.preview-content h2) {
  font-size: 1.25rem;
  line-height: 1.35;
}

.ocr-text-pane :deep(.preview-content table) {
  font-size: var(--ocr-code-size);
}

.ocr-text-pane :deep(.preview-content pre) {
  font-size: var(--ocr-code-size);
}

/* 横向滚动条在 macOS 上默认不可见；留一条始终可见的细滑块。 */
.ocr-text-pane :deep(.preview-content) {
  scrollbar-color: color-mix(in oklab, var(--foreground) 28%, transparent)
    transparent;
}
</style>
