<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { LucideIcon } from '@lucide/vue'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Maximize,
  Minimize,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

/**
 * 预览器的工具栏。Word / Excel / PPT / PDF / 图片共用这一条,
 * 所以导航单位是变量(`页` / `工作表` / `幻灯片` / `张`),而不是写死「页」。
 *
 * 只做一件事:把「这是谁、在第几页、多大、能带走吗」四件事摆在一行里。
 * 每个预览器只传自己支持的那几项,不支持的传 null 就不渲染。
 *
 * **下限判据必须用未取整的 `zoom`**:`zoomMin` 现在可能是「当前适应比例」(如 13.5%),
 * 取整成 14% 再比就会 `14 <= 13.5` 为假 —— 按钮亮着却缩不动(图片已在下限)。
 * 上限那侧(`zoomPercent >= ZOOM_MAX * 100`)沿用**基线**写法,本轮没动它。
 */
const props = withDefaults(
  defineProps<{
    /** 文件名,左端显示。 */
    title: string
    /** 类型名,如「Word 文档」,跟在文件名后面作次级说明。 */
    kindLabel?: string
    icon?: LucideIcon
    /** 导航单位,如「页」「工作表」。传 null 表示这个格式没有可翻的页。 */
    unit?: string | null
    /** 当前序号(1 起)与总数。 */
    index?: number
    count?: number
    /** 当前缩放,1 = 100%。传 null 表示这个格式不支持缩放。 */
    zoom?: number | null
    /**
     * 缩放**下限**(1 = 100%)。默认 25%。
     *
     * 它由**调用方**决定而不是写死:同一个工具栏既服务普通图片/出处预览(25% 够用),
     * 也服务页图库 —— 后者在 390px 弹窗里 A4 整页「适应」需要约 19%,卡 25% 会
     * 「号称适应却横向裁掉一截」。**缩放按钮与禁用判据必须与图片实例用同一个下限**,
     * 否则会出现「图片已经缩到 19%,缩小键却是灰的」这种自相矛盾(见 ImagePreview 的同名 prop)。
     */
    zoomMin?: number
    /** 有没有旋转控制(图片用)。 */
    rotatable?: boolean
    /** 当前旋转角度(度)。 */
    rotation?: number
    /** 「适应」两个按钮的文案。文档说「适宽/适页」,图片没有页,说「适宽/实际大小」。 */
    fitWidthLabel?: string
    fitPageLabel?: string
    /** 文件地址,用于下载与「新标签打开」;不传则隐藏这两个动作。 */
    href?: string | null
    fullscreen?: boolean
    /** 出错时禁用下载与外部打开 —— 点了只会存下/打开一个错误页。 */
    actionsDisabled?: boolean
    /**
     * 窄屏下,百分比按钮点一下是**回「适应」**(发 `fit-width`)而不是回 100%。
     *
     * **必须显式 opt-in**,默认 `false`。这颗按钮的语义由**调用方的 `fit-width` 决定**:
     * 图片预览把「适应」实现为「整页可见」,而 Office 预览把它实现为**适宽**(Office 自己的
     * `viewer.fitWidth()`,与 100% 不是一回事)。若工具栏自作主张在窄屏都发 `fit-width`,
     * Office 的窄屏行为就被悄悄改了 —— 那是**同票外的行为回归**。
     * 所以只由**需要这条恢复路径**的调用方(图片预览)打开;其余(含 Office)保持「回 100%」。
     */
    resetToFitOnNarrow?: boolean
  }>(),
  {
    kindLabel: '',
    icon: undefined,
    unit: '页',
    index: 1,
    count: 0,
    zoom: null,
    zoomMin: 0.25,
    rotatable: false,
    rotation: 0,
    fitWidthLabel: '适宽',
    fitPageLabel: '适页',
    href: null,
    fullscreen: false,
    actionsDisabled: false,
    resetToFitOnNarrow: false,
  },
)

const emit = defineEmits<{
  prev: []
  next: []
  'update:zoom': [value: number]
  'fit-width': []
  'fit-page': []
  rotate: [delta: number]
  'toggle-fullscreen': []
}>()

/** 显示用:取整成整数百分比。文本用它;**下限判据不能用它**(见下面的说明)。 */
const zoomPercent = computed(() => Math.round((props.zoom ?? 1) * 100))

/**
 * 是不是窄屏(< 640px,与 Tailwind 的 `sm` 同一断点)。
 *
 * 用 `matchMedia` 而不是量容器:与那几颗被 `sm:` / `lg:` 收起的按钮必须**同一个依据**,
 * 否则两者会在断点附近打架。
 */
const NARROW_QUERY = '(max-width: 639.98px)'
const isNarrow = ref(false)
if (typeof window !== 'undefined') {
  const mq = window.matchMedia(NARROW_QUERY)
  isNarrow.value = mq.matches
  const onChange = (e: MediaQueryListEvent) => (isNarrow.value = e.matches)
  mq.addEventListener('change', onChange)
  onBeforeUnmount(() => mq.removeEventListener('change', onChange))
}

/**
 * 窄屏下这颗按钮是不是**回「适应」**。两件事同时成立才算:
 * 调用方**显式 opt-in**(`resetToFitOnNarrow`)、且当前**确实是窄屏**。
 *
 * 窄屏时 ± 与「适宽/实际大小」都被 `sm:` / `lg:` 收起,百分比按钮是唯一留在视野里的缩放
 * 控件 —— 对**图片预览**它得承担「回到整页可见」这条恢复路径(100% 对超大图 = 放大到原尺寸,
 * 在 390px 里只剩局部)。但 Office 预览的 `fit-width` 是**适宽**、不是 100%,
 * 所以那一路**不 opt-in**,窄屏仍回 100%。
 */
const resetToFit = computed(() => props.resetToFitOnNarrow && isNarrow.value)
const canPrev = computed(() => props.index > 1)
const canNext = computed(() => props.index < props.count)
const hasNav = computed(() => props.unit !== null && props.count > 0)

/** 缩放步进:细到能微调,又不至于点很多下。 */
const ZOOM_STEP = 0.1
const ZOOM_MAX = 4
const clampZoom = (v: number) => Math.min(ZOOM_MAX, Math.max(props.zoomMin, v))

/**
 * 百分比按钮的可访问名保留可见百分比,并说明点下去的动作。
 *
 * 这样既符合 Label in Name,语音控制可以按屏幕上的百分比定位,读屏也能听出窄屏
 * 「适应页面」与宽屏「恢复到 100%」的区别。`:title` 与可访问名共用同一文本。
 */
const zoomResetLabel = computed(
  () => `${zoomPercent.value}% · ${resetToFit.value ? '适应页面(整页可见)' : '恢复到 100%'}`,
)

const ACTION_BTN = 'text-muted-foreground hover:text-foreground'
</script>

<template>
  <div
    class="bg-card flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1"
    role="toolbar"
    aria-label="预览工具"
  >
    <!--
      文件名与类型名成组。
      宽屏:整组吃剩余空间,文件名过长时省略;类型名贴着文件名,不被推到右边。
      窄屏:容器 flex-wrap,文件名**独占一行**——390px 下右侧控件占掉大半宽度,
      挤在同一行只能截成「入…」,等于没有。折行保住完整文件名,代价是工具栏高一档。
    -->
    <span class="flex min-w-0 basis-full items-center gap-2 sm:w-auto sm:basis-auto sm:flex-1">
      <component :is="icon" v-if="icon" class="text-muted-foreground size-4 shrink-0" />
      <span class="min-w-0 truncate text-xs font-medium" :title="title">{{ title }}</span>
      <span v-if="kindLabel" class="text-muted-foreground hidden shrink-0 text-xs sm:inline">
        {{ kindLabel }}
      </span>
    </span>

    <!-- 页码:数字等宽,翻页时不跳动 -->
    <div v-if="hasNav" class="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        :class="ACTION_BTN"
        :disabled="!canPrev"
        aria-label="上一项"
        @click="emit('prev')"
      >
        <ChevronLeft />
      </Button>
      <span class="text-muted-foreground w-20 text-center text-xs tabular-nums sm:w-24">
        {{ unit }} <span class="text-foreground font-medium">{{ index }}</span> / {{ count }}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        :class="ACTION_BTN"
        :disabled="!canNext"
        aria-label="下一项"
        @click="emit('next')"
      >
        <ChevronRight />
      </Button>
    </div>

    <div v-if="rotatable" class="hidden shrink-0 items-center gap-0.5 sm:flex">
      <Button
        variant="ghost"
        size="icon-sm"
        :class="ACTION_BTN"
        aria-label="逆时针旋转 90 度"
        @click="emit('rotate', -90)"
      >
        <RotateCcw />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        :class="ACTION_BTN"
        aria-label="顺时针旋转 90 度"
        @click="emit('rotate', 90)"
      >
        <RotateCw />
      </Button>
      <Separator orientation="vertical" class="mx-0.5 h-4" />
    </div>

    <div v-if="zoom !== null" class="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        :class="cn(ACTION_BTN, 'hidden sm:inline-flex')"
        :disabled="(zoom ?? 1) <= props.zoomMin"
        aria-label="缩小"
        @click="emit('update:zoom', clampZoom((zoom ?? 1) - ZOOM_STEP))"
      >
        <ZoomOut />
      </Button>
      <!--
        百分比按钮:平时点一下回 100%(原行为)。**只有 `resetToFitOnNarrow` 的调用方**
        (图片预览)在窄屏点一下回「适应」——100% 对超大图意味着**放大到原尺寸**,2400 px 宽的图
        在 390 px 弹窗里只剩局部,而窄屏把「适宽/实际大小」与 ± 都收进了 `sm:` / `lg:`,
        **没有任何回到全图的手段**(点图 / 滚轮也不生效),只能去全屏或关掉重开。
        为什么是 opt-in 而不是工具栏自己按断点分叉:`fit-width` 的语义由**调用方**定 ——
        Office 预览把它实现为**适宽**(不是 100%),替它发 `fit-width` 等于改了它的窄屏行为。
        宽度是**内容自适应 + `px-1`**(宽屏才钉 `sm:w-11`),让「100%」这类三位数也排得下。
        高度取 `min-h-8`(32px):这颗按钮在窄屏是**唯一**的缩放控件,得能被手指点到 ——
        只按 `text-xs` 的行高算,可点框只有 **16px 高**(实测 34×16),比旁边的 ± / 关闭
        (`icon-sm` = 32×32)矮一半。`flex items-center justify-center` 只为把这行字在 32px 里居中。
      -->
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-8 shrink-0 items-center justify-center rounded-sm px-1 text-center text-xs tabular-nums transition-colors focus-visible:ring-3 focus-visible:outline-none sm:w-11"
        :aria-label="zoomResetLabel"
        :title="zoomResetLabel"
        @click="resetToFit ? emit('fit-width') : emit('update:zoom', 1)"
      >
        {{ zoomPercent }}%
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        :class="cn(ACTION_BTN, 'hidden sm:inline-flex')"
        :disabled="zoomPercent >= ZOOM_MAX * 100"
        aria-label="放大"
        @click="emit('update:zoom', clampZoom((zoom ?? 1) + ZOOM_STEP))"
      >
        <ZoomIn />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        :class="cn(ACTION_BTN, 'hidden px-1.5 text-xs lg:inline-flex')"
        :title="fitWidthLabel"
        @click="emit('fit-width')"
      >
        {{ fitWidthLabel }}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        :class="cn(ACTION_BTN, 'hidden px-1.5 text-xs lg:inline-flex')"
        :title="fitPageLabel"
        @click="emit('fit-page')"
      >
        {{ fitPageLabel }}
      </Button>
      <Separator orientation="vertical" class="mx-0.5 hidden h-4 sm:block" />
    </div>

    <div class="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        :class="ACTION_BTN"
        :aria-label="fullscreen ? '退出全屏' : '全屏'"
        :title="fullscreen ? '退出全屏' : '全屏'"
        @click="emit('toggle-fullscreen')"
      >
        <Minimize v-if="fullscreen" />
        <Maximize v-else />
      </Button>
      <Button
        v-if="href"
        as-child
        variant="ghost"
        size="icon-sm"
        :class="cn(ACTION_BTN, 'hidden sm:inline-flex', actionsDisabled && 'pointer-events-none opacity-40')"
        :tabindex="actionsDisabled ? -1 : undefined"
        :aria-disabled="actionsDisabled"
        title="在新标签页打开"
      >
        <a :href="actionsDisabled ? undefined : href" target="_blank" rel="noopener"><ExternalLink /></a>
      </Button>
      <Button
        v-if="href"
        as-child
        variant="ghost"
        size="icon-sm"
        :class="cn(ACTION_BTN, actionsDisabled && 'pointer-events-none opacity-40')"
        :tabindex="actionsDisabled ? -1 : undefined"
        :aria-disabled="actionsDisabled"
        title="下载"
      >
        <a :href="actionsDisabled ? undefined : href" download><Download /></a>
      </Button>
    </div>
  </div>
</template>
