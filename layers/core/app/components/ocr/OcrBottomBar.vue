<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ChevronLeft, ChevronRight, Loader2, Pencil, Save, X } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'

/**
 * 唯一逻辑翻页控制器。
 *
 * 顶部只显示页身份/跳转，不再放第二套「上一处/下一处」；桌面与移动端都从
 * 这一条固定底栏翻页。阅读态这里同时是唯一 filled「编辑」的入口，编辑态
 * 变成「保存 / 取消」——两条高频动作因此始终在首屏可达。
 */
const props = defineProps<{
  currentPage: number | null
  pages: number[]
  editing: boolean
  dirty: boolean
  pending: boolean
  /** 写入中 / 读不到 / 未就绪。 */
  disabled: boolean
  canEdit: boolean
  editLabel: string
}>()

const emit = defineEmits<{
  navigate: [page: number]
  edit: []
  save: []
  cancel: []
}>()

const editButton = ref<{ $el?: HTMLButtonElement } | null>(null)
const bar = ref<HTMLElement | null>(null)
const index = computed(() =>
  props.currentPage === null ? -1 : props.pages.indexOf(props.currentPage),
)
const canPrev = computed(
  () => !props.disabled && index.value > 0 && !props.editing,
)
const canNext = computed(
  () =>
    !props.disabled &&
    index.value >= 0 &&
    index.value < props.pages.length - 1 &&
    !props.editing,
)

function prev() {
  if (!canPrev.value) return
  emit('navigate', props.pages[index.value - 1]!)
}
function next() {
  if (!canNext.value) return
  emit('navigate', props.pages[index.value + 1]!)
}

async function focusEdit() {
  await nextTick()
  editButton.value?.$el?.focus()
}

async function focusBar() {
  await nextTick()
  bar.value?.focus()
}

defineExpose({ focusEdit, focusBar })
</script>

<template>
  <footer
    ref="bar"
    tabindex="-1"
    aria-label="翻页与页操作"
    class="ocr-bottombar bg-card flex h-14 shrink-0 items-center gap-2 rounded-md border px-2.5 sm:px-3"
  >
    <Button
      variant="outline"
      size="sm"
      :disabled="!canPrev"
      aria-label="上一页"
      title="上一页（键盘 ←）"
      @click="prev"
    >
      <ChevronLeft />
      <span>上一页</span>
    </Button>
    <Button
      variant="outline"
      size="sm"
      :disabled="!canNext"
      aria-label="下一页"
      title="下一页（键盘 →）"
      @click="next"
    >
      <span>下一页</span>
      <ChevronRight />
    </Button>

    <!-- 这里只说明键盘有翻页；不再画一对带边框的 kbd 方块，免得被看成第二套翻页按钮。 -->
    <span
      class="text-muted-foreground ml-1 hidden text-[11px] lg:inline"
      title="键盘 ← → 翻页；输入或编辑时不触发"
      >键盘 ← / → 翻页</span
    >

    <div class="ml-auto flex items-center gap-2">
      <span
        v-if="editing && dirty"
        class="text-muted-foreground hidden text-xs sm:inline"
        >未保存</span
      >
      <template v-if="editing">
        <Button
          variant="ghost"
          size="sm"
          :disabled="pending"
          @click="emit('cancel')"
        >
          <X />
          取消
        </Button>
        <Button size="sm" :disabled="pending || disabled" @click="emit('save')">
          <Loader2
            v-if="pending"
            class="animate-spin motion-reduce:animate-none"
          />
          <Save v-else />
          {{ pending ? '保存中…' : '保存' }}
        </Button>
      </template>
      <Button
        v-else
        ref="editButton"
        size="sm"
        :disabled="!canEdit || pending || disabled"
        :aria-label="editLabel"
        @click="emit('edit')"
      >
        <Pencil />
        {{ editLabel }}
      </Button>
    </div>
  </footer>
</template>
