<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FileImage } from '@lucide/vue'
import PreviewStates from '@/components/preview/PreviewStates.vue'
import PreviewToolbar from '@/components/preview/PreviewToolbar.vue'
import { fitZoom, nextZoom, resolvePreviewKind, retrySrc, ZOOM_ABS_MAX } from '~~/lib/preview'

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
    /**
     * 隐藏工具栏上的类型名。给的对象是**已经知道这是什么**的调用方:页图库把 PDF 的
     * 某一页喂进来时,工具栏再挂一个「图片」是句废话(既不是另一份文件,也没提供任何
     * 判断依据)—— 独立审查把它读成了孤零零的一个词。默认 `false`,其它调用方不受影响。
     */
    hideKindLabel?: boolean
    /**
     * 缩放**下限**(1 = 100%),默认 25%。
     *
     * **按调用方给**,不是全站一个常数:普通图片与台账「出处」预览 25% 足够,而页图库
     * 在 390px 弹窗里 A4 整页「适应」需要约 19% —— 卡 25% 会「号称适应却横向裁掉一截」,
     * 百分比还写着 25%,与页面实际尺寸对不上。所以 10% 这档**只由页图库显式传进来**
     * (见 `components/preview/PageImageGallery.vue`),其它页面维持原来的 25% 不变。
     *
     * 这个值同时交给工具栏(见模板的 `:zoom-min`):图片的钳制与工具栏按钮的禁用判据
     * 必须是同一个下限,否则「图片缩到 19%、缩小键却是灰的」。
     */
    zoomMin?: number
  }>(),
  { name: '', alt: '', hideKindLabel: false, zoomMin: 0.25 },
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
const viewportRevision = ref(0)

// 上限沿用既有常数;下限分**三层**(见 `lib/preview.ts`)——
//  · **手动**缩放的配置下限:`props.zoomMin`(默认 25%,页图库传 10%);
//  · **自动「适应」**:只受绝对下限约束,**不按手动下限夹** —— 否则超大图放进窄容器
//    (2400×3200 → 390px 弹窗,fit ≈ 13.5%)会被夹到 25%,「适应」反而溢出,而窄屏又把缩放
//    控件隐藏了,用户没法缩回来;
//  · **有效下限**(`effectiveZoomMin`,见下):`min(手动下限, 当前适应比例)`。
//    **判据与执行必须共用它**:fit 落在手动下限之下时,能到的实际最小就是 fit 本身 ——
//    两边不一致会出现「按钮可用却点不动」(能缩的区间被高估)或「能缩却被禁用」(被低估)。
const ZOOM_MAX = ZOOM_ABS_MAX

/** 旋转 90/270 度时,图片占位的宽高互换。 */
const quarterTurned = computed(() => rotation.value % 180 !== 0)
const displayW = computed(() => (quarterTurned.value ? natural.value.h : natural.value.w))
const displayH = computed(() => (quarterTurned.value ? natural.value.w : natural.value.h))

/** 适应窗口的比例(contain),容器没测量出来前按 1 处理。 */
function fitScale(): number {
  viewportRevision.value
  const box = viewport.value
  if (!box || !displayW.value || !displayH.value) return 1
  const pad = 32
  const sx = (box.clientWidth - pad) / displayW.value
  const sy = (box.clientHeight - pad) / displayH.value
  return Math.min(sx, sy, ZOOM_MAX)
}

/**
 * **有效下限**:`min(手动下限, 当前「适应」比例)` —— 这一处是**判据与执行共用的**唯一来源。
 *
 * 为什么不能只给工具栏用:超大图放进窄容器时「适应」落在手动下限**之下**(fit ≈ 13.5% « 25%),
 * 此时能到的实际最小就是 **fit 本身**(再往下没有意义 —— 图已经整页可见)。若判据用有效下限、
 * 执行却仍用 25%:
 *  - 13.5% 时按钮**正确禁用**;
 *  - 但点一次放大到 23.5% 后按钮变可用,再点缩小却**回到 25% 不是 13.5%**(执行被 25% 挡住)——
 *    「可用按钮点了没反应/回不到原位」。
 * 反过来(判据用 25%、执行用有效下限)则会出现「按钮灰着其实能缩」。所以两边都取这一个值。
 *
 * 语义(精确):**`fitScale() ≥ 配置下限`时守配置下限**(普通预览 25%、页图库 10%);
 * **`fitScale() < 配置下限`时有效下限就是 `fitScale()`** —— 能到的最小是「整页可见」。
 * 工具栏收到的 `:zoom-min` 是**派生出来的有效下限**,不是 `props.zoomMin` 原值。
 */
const effectiveZoomMin = computed(() => Math.min(props.zoomMin, fitScale()))

/** 手动缩放(滚轮 / 按钮 / 滑块):下限取**有效下限**,与工具栏判据同源。 */
const clampZoom = (v: number) => nextZoom(v, zoom.value, effectiveZoomMin.value, ZOOM_MAX)

/** 1:1 也要能看:不超过适应比例的 4 倍,免得小图被拉到糊。 */
function fit() {
  userAdjusted.value = false
  if (!viewport.value || viewport.value.clientWidth <= 32 || viewport.value.clientHeight <= 32) return
  // 「适应」按绝对上下限取,不按手动下限 —— 它要能把整页装下(见上面的常量说明)。
  zoom.value = fitZoom(fitScale(), ZOOM_MAX)
  pan.value = { x: 0, y: 0 }
}
function actualSize() {
  userAdjusted.value = true
  zoom.value = 1
  pan.value = { x: 0, y: 0 }
}

async function onLoad(e: Event) {
  const el = e.target as HTMLImageElement
  natural.value = { w: el.naturalWidth, h: el.naturalHeight }
  status.value = 'ready'
  // Ready controls can wrap onto another toolbar row. Measure after that layout,
  // and never let a duplicate load override a zoom performed in the meantime.
  await nextTick()
  if (el === img.value && !userAdjusted.value) fit()
}
function onError() {
  status.value = 'error'
  errorMessage.value = '图片没能加载,文件可能已损坏或路径失效。'
}

/**
 * 重试次数。
 *
 * **旧实现的问题不是「浏览器不肯重发」,而是压根没让它重发**:重试只改了一个 UI 状态,
 * `src` 与元素都没动,Vue 不触发任何加载,`<img>` 停在失败态,界面永久卡在
 * 「正在读取文件…」。(独立实验:真的重新赋值同一个 `src`、或重建元素,Chrome 都照发。)
 * 所以重试要做的第一件事是**发起一次新的加载**,这个计数就是那个动作:
 * 挂到 `<img>` 的 `:key` 上 → 换新元素;经 `imgSrc` 拼进地址 → 连 URL 也是新的
 * (`blob:` / `data:` 不能加参数,就只靠换元素那一半)。
 */
const retryAttempt = ref(0)

/** 图片地址:没重试过时就是 `props.src` **原样**,既有行为一个字节不变。 */
const imgSrc = computed(() => retrySrc(props.src, retryAttempt.value))

/** 重试:清掉错误、回到加载中,并真的产生一次新的加载尝试。 */
function retry() {
  if (status.value !== 'error') return
  errorMessage.value = ''
  status.value = 'loading'
  retryAttempt.value += 1
}

/** 滚轮缩放,围绕指针。 */
function onWheel(e: WheelEvent) {
  if (status.value !== 'ready') return
  e.preventDefault()
  const box = viewport.value
  if (!box) return
  userAdjusted.value = true
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
  userAdjusted.value = true
  const next = clampZoom(zoom.value * factor)
  const ratio = next / zoom.value
  pan.value = { x: pan.value.x * ratio, y: pan.value.y * ratio }
  zoom.value = next
}
function onZoomModel(v: number) {
  userAdjusted.value = true
  const next = clampZoom(v)
  const ratio = next / zoom.value
  pan.value = { x: pan.value.x * ratio, y: pan.value.y * ratio }
  zoom.value = next
}

/** 只有内容超出容器时才允许拖,否则光标和手感都是错的。 */
const canPan = computed(() => {
  viewportRevision.value
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
      viewportRevision.value++
      if (status.value === 'ready' && !userAdjusted.value) fit()
    })
    ro.observe(viewport.value)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  ro?.disconnect()
})

watch(
  () => props.src,
  () => {
    status.value = 'loading'
    errorMessage.value = ''
    // 换图就重新计次:新图要从**原地址**开始,不该继承上一张的重试标记
    // (页图库换页时用的是同一个组件实例,不重置就会把 `retry=N` 带到下一张上)。
    retryAttempt.value = 0
    rotation.value = 0
    pan.value = { x: 0, y: 0 }
    userAdjusted.value = false
  },
)

/**
 * 对外露出缩放。**只加不减**:`defineExpose` 不改任何既有渲染,现有调用方(台账 /
 * 详情页的出处预览)完全不受影响;页图库的窄屏工具栏靠它驱动(见 R1)。
 */
defineExpose({
  zoomBy,
  fit,
  zoom,
  /**
   * **有效下限** = `min(手动下限, 当前适应比例)` —— 见上面的同名 computed。
   * 外部(页图库的窄屏控件)要判「还能不能再缩小」时必须用它,而不是各自的配置下限:
   * 否则会出现「按钮灰着其实还能缩」(fit 落在配置下限之下时,能到的最小是 fit)。
   */
  effectiveZoomMin,
})

const imgStyle = computed(() => ({
  width: natural.value.w ? `${natural.value.w}px` : undefined,
  height: natural.value.h ? `${natural.value.h}px` : undefined,
  // Scale and pointer compensation must change in one frame. Animating only the
  // translation makes the image jump to its new size before its anchor catches up.
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) rotate(${rotation.value}deg) scale(${zoom.value})`,
  transition: 'none',
}))
</script>

<template>
  <div
    data-preview-shell
    class="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border"
  >
    <PreviewToolbar
      :title="title"
      :kind-label="hideKindLabel ? '' : (info?.label ?? '图片')"
      :icon="FileImage"
      :unit="null"
      :zoom="status === 'ready' ? zoom : null"
      :zoom-min="effectiveZoomMin"
      :reset-to-fit-on-narrow="true"
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
        @retry="retry"
      />
      <!--
        图片层:**没显示出可用图片时一律不接指针事件**。

        它是状态层(`PreviewStates`,里面有「重试」按钮)的**后置兄弟**,两者都是
        `absolute inset-0`。后置的兄弟在绘制与命中上都压在上面 —— 于是这一层会盖住
        重试按钮、把鼠标点击吞掉(`elementFromPoint` 命中它而不是按钮);而键盘 Tab/Enter
        不经过命中测试,所以**只坏鼠标**,表现成「按钮看得见、点不动」。

        用 `pointer-events` 而不是 z-index:它不依赖绘制顺序(以后再有人给图片层或夹层加
        z-index 也不会把这个洞捅回来),而且语义正好是我们要的那句 —— 「一张还没显示出来
        的图,不该接任何指针事件」。`status === 'ready'` 时**不加**这个类,图片层的指针
        事件与拖拽/缩放/手势完全保持原样。
      -->
      <div
        class="absolute inset-0 flex items-center justify-center"
        :class="status === 'ready' ? '' : 'pointer-events-none'"
      >
        <img
          ref="img"
          :key="retryAttempt"
          :src="imgSrc"
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
