<script setup lang="ts">
import { computed } from 'vue'
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
  }>(),
  {
    kindLabel: '',
    icon: undefined,
    unit: '页',
    index: 1,
    count: 0,
    zoom: null,
    rotatable: false,
    rotation: 0,
    fitWidthLabel: '适宽',
    fitPageLabel: '适页',
    href: null,
    fullscreen: false,
    actionsDisabled: false,
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

const zoomPercent = computed(() => Math.round((props.zoom ?? 1) * 100))
const canPrev = computed(() => props.index > 1)
const canNext = computed(() => props.index < props.count)
const hasNav = computed(() => props.unit !== null && props.count > 0)

/** 缩放步进:细到能微调,又不至于点很多下。 */
const ZOOM_STEP = 0.1
const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
const clampZoom = (v: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))

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
        :disabled="zoomPercent <= ZOOM_MIN * 100"
        aria-label="缩小"
        @click="emit('update:zoom', clampZoom((zoom ?? 1) - ZOOM_STEP))"
      >
        <ZoomOut />
      </Button>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-11 shrink-0 rounded-sm text-center text-xs tabular-nums transition-colors focus-visible:ring-3 focus-visible:outline-none"
        title="恢复 100%"
        @click="emit('update:zoom', 1)"
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
