<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import { FileText } from '@lucide/vue'
import { pageLabel } from '#core/lib/page-gallery'
import { STATE_WORD, type PageReviewState } from '#core/lib/ocr-workbench'

/**
 * 页面导航里的一格：物理页号 + 页图缩略图 + 三档校对状态。
 *
 * 缩略图只在滚到附近时才挂 `<img>` —— 97 页的默认动作必须是「列出页」而不是
 * 「下载 97 张大图」。没有页图的页不是禁用项：OCR 文本仍然值得对照，
 * 这一格照样可选，用虚线占位说明「这一页还没有页图」。
 */
const props = defineProps<{
  page: number
  imageUrl: string
  state: PageReviewState
  current: boolean
  /** 草稿/写入在飞时仍可浏览与聚焦，但不接受跳转。 */
  disabled: boolean
  /** 网格的 roving tabindex：只有当前格进 Tab 顺序。 */
  roving: boolean
  total: number
}>()

const emit = defineEmits<{
  select: [page: number]
  focusCell: [page: number]
}>()

const root = useTemplateRef<HTMLButtonElement>('root')
const renderImage = ref(false)
const imageFailed = ref(false)
let observer: IntersectionObserver | null = null

onMounted(() => {
  if (!props.imageUrl) return
  // jsdom / 老浏览器没有 IntersectionObserver：直接显示（测试里不会真的取图）。
  if (typeof IntersectionObserver === 'undefined') {
    renderImage.value = true
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      renderImage.value = true
      observer?.disconnect()
      observer = null
    },
    { rootMargin: '80px' },
  )
  if (root.value) observer.observe(root.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

const stateLine = computed(
  () =>
    ({
      text: 'border-foreground',
      empty: 'border-muted-foreground',
      none: 'border-dashed border-muted-foreground/70',
    })[props.state],
)
const label = computed(
  () =>
    `${pageLabel(props.page)}，共 ${props.total} 页，${STATE_WORD[props.state]}${props.current ? '，当前页' : ''}`,
)

function select() {
  if (props.disabled) return
  emit('select', props.page)
}
</script>

<template>
  <button
    ref="root"
    type="button"
    data-ocr-page-cell
    :data-page="page"
    :tabindex="roving ? 0 : -1"
    :aria-label="label"
    :aria-current="current ? 'page' : undefined"
    :aria-disabled="disabled ? 'true' : undefined"
    :title="label"
    class="bg-card group flex min-w-0 flex-col overflow-hidden rounded-sm border text-left transition-[border-color,box-shadow] duration-150 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 motion-reduce:transition-none"
    :class="[
      current
        ? 'border-primary/70 shadow-sm ring-2 ring-primary/20'
        : 'hover:border-ring/60 hover:shadow-sm',
      disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
    ]"
    @click="select"
    @focus="emit('focusCell', page)"
  >
    <span class="bg-muted/40 relative block aspect-[3/4] w-full overflow-hidden">
      <img
        v-if="renderImage && !imageFailed"
        :src="imageUrl"
        alt=""
        loading="lazy"
        decoding="async"
        class="size-full object-cover object-top"
        @error="imageFailed = true"
      />
      <span
        v-else
        class="text-muted-foreground flex size-full flex-col items-center justify-center gap-1"
      >
        <FileText class="size-4" :class="imageUrl ? 'opacity-40' : ''" />
        <span v-if="!imageUrl" class="text-[10px] leading-none">无页图</span>
      </span>
      <span
        class="bg-background/90 absolute right-1 bottom-1 rounded-sm px-1 text-[11px] leading-4 font-medium tabular-nums shadow-xs"
        >{{ page }}</span
      >
    </span>
    <span
      class="text-muted-foreground flex h-5 shrink-0 items-center gap-1 px-1 text-[11px] leading-none"
      :class="current ? 'text-foreground' : ''"
    >
      <span
        class="h-0 w-2.5 shrink-0 border-t-2"
        :class="stateLine"
        aria-hidden="true"
      />
      <span class="truncate">{{ STATE_WORD[state] }}</span>
    </span>
  </button>
</template>
