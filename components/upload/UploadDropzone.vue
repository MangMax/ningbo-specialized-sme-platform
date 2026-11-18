<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { UploadCloud } from '@lucide/vue'
import { Input } from '#core/app/components/ui/input'
import { cn } from '#core/lib/utils'

/**
 * 投放区:拖进来,或点一下选文件。只负责「拿到 File 列表」并交出去,
 * 校验和元数据预填由父组件决定 —— 这里不该知道落位规则。
 *
 * 文件选择用 shadcn 的 `Input type="file"`(项目约定:不裸写原生控件),
 * 隐藏后用整块面接住点击,热区比原生的小按钮大得多。
 */
const props = withDefaults(
  defineProps<{
    /** 不可接收时降级为提示,但保留键盘可达(不用 tabindex=-1 藏掉)。 */
    disabled?: boolean
    /** 空闲时的主文案。 */
    title?: string
    hint?: string
    accept?: string
    multiple?: boolean
  }>(),
  {
    disabled: false,
    title: '把文件拖到这里',
    hint: '或点击选择文件',
    accept: undefined,
    multiple: false,
  },
)

const emit = defineEmits<{
  (e: 'files', files: File[]): void
}>()

/** `Input` 是组件,拿真实元素要经 `$el`。 */
const fileInput = ref<ComponentPublicInstance | null>(null)
const dragging = ref(false)
const interactive = computed(() => !props.disabled)

function openPicker() {
  if (!interactive.value) return
  const el = fileInput.value?.$el as HTMLInputElement | undefined
  el?.click()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  openPicker()
}

function onDragEnter(event: DragEvent) {
  if (!interactive.value) return
  event.preventDefault()
  dragging.value = true
}

function onDragOver(event: DragEvent) {
  if (!interactive.value) return
  // 不 preventDefault 浏览器就会把文件当导航打开。
  event.preventDefault()
  dragging.value = true
}

function onDragLeave(event: DragEvent) {
  // 在子元素之间移动也会触发 dragleave,只有真正离开这块面才收起高亮。
  const zone = event.currentTarget as HTMLElement
  if (event.relatedTarget instanceof Node && zone.contains(event.relatedTarget)) return
  dragging.value = false
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  dragging.value = false
  if (!interactive.value) return
  emit('files', Array.from(event.dataTransfer?.files ?? []))
}

function onChange(event: Event) {
  const el = event.target as HTMLInputElement
  emit('files', Array.from(el.files ?? []))
  // 置空,才能把同一个文件再选一次(比如上一次传失败了)。
  el.value = ''
}
</script>

<template>
  <div
    :class="
      cn(
        'relative flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-5 py-9 text-center',
        'transition-colors duration-150 ease-snap outline-none',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3',
        interactive ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
        dragging ? 'border-primary bg-accent' : interactive && 'border-input hover:bg-accent/60',
      )
    "
    role="button"
    :tabindex="interactive ? 0 : -1"
    :aria-disabled="!interactive"
    @click="openPicker"
    @keydown="onKeydown"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <UploadCloud
      aria-hidden="true"
      class="size-5 transition-colors duration-150"
      :class="dragging ? 'text-primary' : 'text-muted-foreground'"
    />
    <p class="text-sm font-medium">{{ dragging ? '松开即加入队列' : title }}</p>
    <p class="text-muted-foreground text-xs">{{ hint }}</p>

    <!-- 真正的选择器藏在下面,由整块面代点;点它会冒泡回外层,所以停住。 -->
    <Input
      ref="fileInput"
      type="file"
      class="hidden"
      :accept="accept"
      :multiple="multiple"
      :disabled="disabled"
      tabindex="-1"
      aria-hidden="true"
      @click.stop
      @change="onChange"
    />
  </div>
</template>
