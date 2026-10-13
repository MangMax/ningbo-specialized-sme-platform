<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FileImage } from '@lucide/vue'
import PreviewStates from '@/components/preview/PreviewStates.vue'
import PreviewToolbar from '@/components/preview/PreviewToolbar.vue'
import { resolvePreviewKind } from '~~/lib/preview'

/**
 * 图片预览。自研,不引第三方查看器 —— 要的东西很少:滚轮缩放、拖拽平移、
 * 旋转、适应窗口,一个 `<img>` 加几个指针事件就够了。
 *
 * 三条约定,和另外两个预览器保持一致:
 *  - 缩放围绕**指针位置**(滚轮)或**视口中心**(按钮),不是围绕左上角,
 *    否则一放大内容就跑出画面。
 *  - 只有图片真的超出容器时才允许平移;没超出就居中,不要能拖动。
 *  - 旋转按 90° 步进;转 90/270 度后「适应」要按交换后的宽高算。
 */
const props = withDefaults(
  defineProps<{
    src: string
    name?: string
    /** 替代文本,默认用文件名。 */
    alt?: string
  }>(),
  { name: '', alt: '' },
)

const info = computed(() => resolvePreviewKind(props.src))
const title = computed(() => props.name || props.src.split('/').pop() || props.src)

const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const viewport = ref<HTMLElement | null>(null)
const img = ref<HTMLImageElement | null>(null)

/** 自然尺寸,load 之后才有。 */
const natural = ref({ w: 0, h: 0 })
const zoom = ref(1)
const rotation = ref(0)
/** 平移量(CSS px),相对居中位置。 */
const pan = ref({ x: 0, y: 0 })
const dragging = ref(false)
const fullscreen = ref(false)

const ZOOM_MIN = 0.25
const ZOOM_MAX = 8
const clampZoom = (v: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))

/** 旋转 90/270 度时,图片占位的宽高互换。 */
const quarterTurned = computed(() => rotation.value % 180 !== 0)
const displayW = computed(() => (quarterTurned.value ? natural.value.h : natural.value.w))
const displayH = computed(() => (quarterTurned.value ? natural.value.w : natural.value.h))

/** 适应窗口的比例(contain),容器没测量出来前按 1 处理。 */
function fitScale(): number {
  const box = viewport.value
  if (!box || !displayW.value || !displayH.value) return 1
  const pad = 32
  const sx = (box.clientWidth - pad) / displayW.value
  const sy = (box.clientHeight - pad) / displayH.value
  return Math.min(sx, sy, ZOOM_MAX)
}

/** 1:1 也要能看:不超过适应比例的 4 倍,免得小图被拉到糊。 */
function fit() {
  zoom.value = clampZoom(fitScale())
  pan.value = { x: 0, y: 0 }
}
function actualSize() {
  zoom.value = 1
  pan.value = { x: 0, y: 0 }
}

function onLoad(e: Event) {
  const el = e.target as HTMLImageElement
  natural.value = { w: el.naturalWidth, h: el.naturalHeight }
  status.value = 'ready'
  fit()
}
function onError() {
  status.value = 'error'
  errorMessage.value = '图片没能加载,文件可能已损坏或路径失效。'
}

/** 滚轮缩放,围绕指针。 */
function onWheel(e: WheelEvent) {
  if (status.value !== 'ready') return
  e.preventDefault()
  const box = viewport.value
  if (!box) return
  const rect = box.getBoundingClientRect()
  // 指针相对容器中心的位置,缩放时按这个偏移补偿平移,视觉上就是「围绕指针」。
  const cx = e.clientX - rect.left - rect.width / 2
  const cy = e.clientY - rect.top - rect.height / 2
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const next = clampZoom(zoom.value * factor)
  const ratio = next / zoom.value
  pan.value = {
    x: cx - (cx - pan.value.x) * ratio,
    y: cy - (cy - pan.value.y) * ratio,
  }
  zoom.value = next
}

/** 按钮缩放,围绕视口中心。 */
function zoomBy(factor: number) {
  const next = clampZoom(zoom.value * factor)
  const ratio = next / zoom.value
  pan.value = { x: pan.value.x * ratio, y: pan.value.y * ratio }
  zoom.value = next
}
function onZoomModel(v: number) {
  const ratio = v / zoom.value
  pan.value = { x: pan.value.x * ratio, y: pan.value.y * ratio }
  zoom.value = clampZoom(v)
}

/** 只有内容超出容器时才允许拖,否则光标和手感都是错的。 */
const canPan = computed(() => {
  const box = viewport.value
  if (!box || status.value !== 'ready') return false
  return displayW.value * zoom.value > box.clientWidth || displayH.value * zoom.value > box.clientHeight
})

let dragStart = { x: 0, y: 0, px: 0, py: 0 }
function onPointerDown(e: PointerEvent) {
  if (!canPan.value || e.button !== 0) return
  dragging.value = true
  dragStart = { x: e.clientX, y: e.clientY, px: pan.value.x, py: pan.value.y }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  pan.value = {
    x: dragStart.px + (e.clientX - dragStart.x),
    y: dragStart.py + (e.clientY - dragStart.y),
  }
}
function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
}

function rotate(delta: number) {
  rotation.value = (rotation.value + delta + 360) % 360
  pan.value = { x: 0, y: 0 }
  // 转完宽高可能互换,重新适应一次,免得转出画面。
  fit()
}

function toggleFullscreen() {
  const el = viewport.value?.closest('[data-preview-shell]') ?? viewport.value
  if (!el) return
  if (document.fullscreenElement) void document.exitFullscreen()
  else void el.requestFullscreen?.()
}
function onFullscreenChange() {
  fullscreen.value = !!document.fullscreenElement
  if (fullscreen.value) fit()
}

/** 容器尺寸变化后重新适应(只在「未手动缩放过」时,避免打断用户的调整)。 */
let ro: ResizeObserver | null = null
const userAdjusted = ref(false)
onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  if (viewport.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (status.value === 'ready' && !userAdjusted.value) fit()
    })
    ro.observe(viewport.value)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  ro?.disconnect()
})

// 手动调整过之后,窗口变化不再自动覆盖用户的缩放。
watch(zoom, () => {
  if (status.value === 'ready') userAdjusted.value = true
})
watch(
  () => props.src,
  () => {
    status.value = 'loading'
    errorMessage.value = ''
    rotation.value = 0
    pan.value = { x: 0, y: 0 }
    userAdjusted.value = false
  },
)

const imgStyle = computed(() => ({
  width: natural.value.w ? `${natural.value.w * zoom.value}px` : undefined,
  height: natural.value.h ? `${natural.value.h * zoom.value}px` : undefined,
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) rotate(${rotation.value}deg)`,
  transition: dragging.value ? 'none' : 'transform 120ms var(--ease-snap)',
}))
</script>

<template>
  <div
    data-preview-shell
    class="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border"
  >
    <PreviewToolbar
      :title="title"
      :kind-label="info?.label ?? '图片'"
      :icon="FileImage"
      :unit="null"
      :zoom="status === 'ready' ? zoom : null"
      rotatable
      :rotation="rotation"
      :href="src"
      :actions-disabled="status === 'error'"
      :fullscreen="fullscreen"
      @update:zoom="onZoomModel"
      fit-width-label="适宽"
      fit-page-label="实际大小"
      @fit-width="fit"
      @fit-page="actualSize"
      @rotate="rotate"
      @toggle-fullscreen="toggleFullscreen"
    />

    <div
      ref="viewport"
      class="relative min-h-0 flex-1 overflow-hidden"
      :class="canPan ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="actualSize"
    >
      <PreviewStates
        v-if="status !== 'ready'"
        class="absolute inset-0"
        :status="status"
        :message="errorMessage"
        retryable
        @retry="status = 'loading'"
      />
      <div class="absolute inset-0 flex items-center justify-center">
        <img
          ref="img"
          :src="src"
          :alt="alt || title"
          :style="imgStyle"
          draggable="false"
          class="max-w-none shrink-0 select-none rounded-sm shadow-sm"
          :class="status === 'ready' ? 'preview-ready' : 'opacity-0'"
          @load="onLoad"
          @error="onError"
        />
      </div>
    </div>
  </div>
</template>
