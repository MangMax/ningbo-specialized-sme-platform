<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { FileSpreadsheet, FileText, Presentation } from '@lucide/vue'
import type { LucideIcon } from '@lucide/vue'
import PreviewStates from '@/components/preview/PreviewStates.vue'
import PreviewToolbar from '@/components/preview/PreviewToolbar.vue'
import { resolvePreviewKind, describeLoadError, type PreviewKind } from '~~/lib/preview'

/**
 * Word / Excel / PowerPoint 预览。用 @silurus/ooxml 的**滚动式**查看器:
 * 一个容器里连续排页,而不是一次一页地换。读公布文件时人要前后翻着对,
 * 连续滚动比翻页省事。
 *
 * 这个库自带的是画布与滚动逻辑,没有工具栏 —— 工具栏是这里自己搭的,
 * 因此和其它几个预览器长得完全一样。
 *
 * 三个格式的查看器类不同(XlsxViewer 自己管 canvas 与工作表标签,
 * 另外两个要挂在一个容器上),所以按 kind 分支创建,对外是一套接口。
 */
const props = withDefaults(
  defineProps<{
    /** 文件地址(URL 或同源路径)。 */
    src: string
    /** 文件名,用于工具栏标题。 */
    name?: string
    /** 明确指定类型;不给则按扩展名推断。 */
    kind?: PreviewKind | null
  }>(),
  { name: '', kind: null },
)

const emit = defineEmits<{ error: [message: string] }>()

/** 预览器对外统一的能力面:导航 + 缩放。三项都可能有,按格式支持情况填。 */
interface ViewerHandle {
  destroy: () => void
  load: (source: string) => Promise<unknown>
  getScale: () => number
  setScale: (v: number) => void
  fitWidth: () => void
  fitPage: () => void
  /** 翻到第 index 项(1 起)。 */
  goTo: (index: number) => void | Promise<void>
  /** 总项数(页 / 工作表 / 幻灯片)。 */
  count: () => number
  /** 当前项(1 起)。 */
  current: () => number
}

const host = ref<HTMLElement | null>(null)
const viewer = shallowRef<ViewerHandle | null>(null)
const status = ref<'loading' | 'ready' | 'error' | 'unsupported'>('loading')
const errorMessage = ref('')
const progress = ref<number | null>(null)
const zoom = ref(1)
const index = ref(1)
const count = ref(0)
const fullscreen = ref(false)

const info = computed(() => resolvePreviewKind(props.src))
const kind = computed<PreviewKind | null>(() => props.kind ?? info.value?.kind ?? null)
const label = computed(() => info.value?.label ?? '')
const title = computed(() => props.name || props.src.split('/').pop() || props.src)

const ICONS: Record<string, LucideIcon> = {
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
}
const icon = computed(() => (kind.value ? ICONS[kind.value] : undefined))

/** 导航单位按格式换词,别在 Excel 上说「页」。 */
const unit = computed(() => {
  if (kind.value === 'xlsx') return '工作表'
  if (kind.value === 'pptx') return '幻灯片'
  return '页'
})

/**
 * 总项数会**边渲染边修正**:查看器用渐进布局,先按估算高度给一个数,
 * 真实页测量完再收敛(实测同一份 61 页的 docx 会从 61 收到 32)。
 * 所以这里不锁死第一次拿到的值,而是每次回调都覆盖,并把当前项夹在范围内,
 * 免得收敛之后停在一个不存在的页码上。
 */
function syncCount(next: number) {
  count.value = next
  if (next > 0 && index.value > next) index.value = next
}

/** 只在这三个格式里挑查看器;其余交给上层处理。 */
async function createViewer(
  container: HTMLElement,
  k: PreviewKind,
): Promise<ViewerHandle> {
  const theme = {
    background: 'transparent',
    pageShadow: '0 1px 2px rgb(0 0 0 / 0.06), 0 4px 12px rgb(0 0 0 / 0.06)',
    enableTextSelection: true,
    enableZoom: true,
  }

  if (k === 'xlsx') {
    const { XlsxViewer } = await import('@silurus/ooxml/xlsx')
    // XlsxViewer 自己建 canvas 与底部工作表标签,容器里不放别的东西。
    const v = new XlsxViewer(container, {
      showZoomSlider: false,
      onScaleChange: (s: number) => (zoom.value = s),
      onSheetChange: (i: number) => (index.value = i + 1),
      onReady: (names: string[]) => syncCount(names.length),
      onError: (err: Error) => fail(err),
    })
    syncCount(v.sheetNames?.length ?? 0)
    return {
      destroy: () => v.destroy(),
      load: (s) => v.load(s),
      getScale: () => v.getScale(),
      setScale: (x) => v.setScale(x),
      fitWidth: () => v.fitWidth(),
      fitPage: () => v.fitPage(),
      goTo: (i) => v.goToSheet(i - 1),
      count: () => v.sheetNames?.length ?? 0,
      current: () => index.value,
    }
  }

  if (k === 'pptx') {
    const { PptxScrollViewer } = await import('@silurus/ooxml/pptx')
    const v = new PptxScrollViewer(container, {
      ...theme,
      onScaleChange: (s: number) => (zoom.value = s),
      onVisibleSlideChange: (top: number, total: number) => {
        index.value = top + 1
        syncCount(total)
      },
      onError: (err: Error) => fail(err),
    })
    return {
      destroy: () => v.destroy(),
      load: (s) => v.load(s),
      getScale: () => v.getScale(),
      setScale: (x) => v.setScale(x),
      fitWidth: () => v.fitWidth(),
      fitPage: () => v.fitPage(),
      goTo: (i) => v.scrollToSlide(i - 1),
      count: () => v.slideCount,
      current: () => v.topVisibleSlide + 1,
    }
  }

  const { DocxScrollViewer } = await import('@silurus/ooxml/docx')
  const v = new DocxScrollViewer(container, {
    ...theme,
    onScaleChange: (s: number) => (zoom.value = s),
    onVisiblePageChange: (top: number, total: number) => {
      index.value = top + 1
      syncCount(total)
    },
    onError: (err: Error) => fail(err),
  })
  return {
    destroy: () => v.destroy(),
    load: (s) => v.load(s),
    getScale: () => v.getScale(),
    setScale: (x) => v.setScale(x),
    fitWidth: () => v.fitWidth(),
    fitPage: () => v.fitPage(),
    goTo: (i) => v.scrollToPage(i - 1),
    count: () => v.pageCount,
    current: () => v.topVisiblePage + 1,
  }
}

function fail(err: unknown) {
  status.value = 'error'
  errorMessage.value = describeLoadError(err)
  emit('error', errorMessage.value)
}

let generation = 0

async function mount() {
  const container = host.value
  const k = kind.value
  if (!container || !k) {
    status.value = 'unsupported'
    errorMessage.value = '这个格式不在预览范围内。'
    return
  }

  const gen = ++generation
  status.value = 'loading'
  errorMessage.value = ''
  progress.value = null

  try {
    const v = await createViewer(container, k)
    if (gen !== generation) {
      v.destroy()
      return
    }
    viewer.value = v

    await v.load(props.src)
    if (gen !== generation) return

    // 查看器把总项数报上来之后才谈得上导航;有些格式要等布局完成。
    syncCount(v.count() ?? count.value)
    index.value = v.current?.() ?? 1
    status.value = 'ready'
  } catch (err) {
    if (gen === generation) fail(err)
  }
}

function teardown() {
  generation += 1
  viewer.value?.destroy()
  viewer.value = null
  // 查看器会在容器里留下 canvas 与滚动壳,换文件前清干净。
  if (host.value) host.value.innerHTML = ''
}

onBeforeUnmount(teardown)

// 首次挂载要等 DOM 就位:查看器需要一个真实存在、有尺寸的容器。
// 这里不能用 watch 的 immediate —— immediate 回调在 setup 阶段就跑,
// 那时 ref 还是 null,会误判成「格式不支持」。后续换文件才走 watch。
onMounted(() => {
  void mount()
})

watch(
  () => [props.src, kind.value] as const,
  () => {
    teardown()
    void mount()
  },
  { flush: 'post' },
)

function onZoom(v: number) {
  zoom.value = v
  viewer.value?.setScale(v)
}
function onFitWidth() {
  viewer.value?.fitWidth()
  zoom.value = viewer.value?.getScale() ?? zoom.value
}
function onFitPage() {
  viewer.value?.fitPage()
  zoom.value = viewer.value?.getScale() ?? zoom.value
}
function go(delta: number) {
  const next = index.value + delta
  if (next < 1 || (count.value && next > count.value)) return
  void viewer.value?.goTo(next)
  index.value = next
}
function toggleFullscreen() {
  const el = host.value?.closest('[data-preview-shell]') ?? host.value
  if (!el) return
  if (document.fullscreenElement) void document.exitFullscreen()
  else void el.requestFullscreen?.()
}
function onFullscreenChange() {
  fullscreen.value = !!document.fullscreenElement
}
if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  onBeforeUnmount(() => document.removeEventListener('fullscreenchange', onFullscreenChange))
}
</script>

<template>
  <div
    data-preview-shell
    class="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border"
  >
    <PreviewToolbar
      :title="title"
      :kind-label="label"
      :icon="icon"
      :unit="unit"
      :index="index"
      :count="count"
      :zoom="status === 'ready' ? zoom : null"
      :href="src"
      :fullscreen="fullscreen"
      :actions-disabled="status === 'error'"
      @prev="go(-1)"
      @next="go(1)"
      @update:zoom="onZoom"
      @fit-width="onFitWidth"
      @fit-page="onFitPage"
      @toggle-fullscreen="toggleFullscreen"
    />
    <!--
      容器始终参与布局,不隐藏:查看器挂载时要测量容器尺寸,`display:none`
      会让它拿到 0×0 并算错缩放。加载态与错误态作为覆盖层盖在上面。
    -->
    <div class="relative min-h-0 flex-1">
      <div
        ref="host"
        class="absolute inset-0 overflow-hidden"
        :class="[
          status === 'ready' ? 'preview-ready' : '',
          kind === 'xlsx' ? 'bg-muted/40 p-2' : '',
        ]"
      />
      <PreviewStates
        v-if="status !== 'ready'"
        class="bg-card absolute inset-0 z-10"
        :status="status"
        :message="errorMessage"
        :progress="progress"
        retryable
        @retry="mount"
      />
    </div>
  </div>
</template>
