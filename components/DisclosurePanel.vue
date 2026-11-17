<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'

/**
 * 全站唯一的折叠面板。
 *
 * 由官方 shadcn-vue Accordion（Reka 高度测量动画）组合而成：右侧 chevron、
 * 字体与 padding、focus ring 和开合高度动画都来自 `components/ui/accordion`，
 * 页面不再各写一套 grid/transition。
 *
 * - `keepMounted`：关闭后保留子树（隐藏为 `until-found`，不占位、不可聚焦），
 *   供需要保持表单实例/初始化回调的折叠使用。
 * - `instant`：仅供程序化收起（如点「开始对比」）跳过动画；手动开合仍有完整动画。
 * - `compact`：唯一的紧凑层级；两档之外不再有页面级折叠样式。
 * - `#chevron`：可选的自定义展开图标槽。传了就完全替换默认 chevron（不附加旋转）；
 *   日志配置页用它固定朝右的 `lucide:chevron-right`。不传时保持全站默认行为。
 * - `headingLevel`：触发器**所在容器**的标题层级，默认 3（Accordion 官方默认，
 *   全站不变）。层级落在包住触发器的那个标题元素上（`h2 > button`），按钮里
 *   不再套标题 —— 按钮里的标题会被读屏念成“标题里的标题”。
 *   页面**直接挂在 h1 下面**的折叠传 2：那时折叠标题就是该 h2 区块里的 h3，
 *   而 Reka 的默认 h3 会与页面的 h2 同层，读屏按标题导航时看不出从属关系。
 *   只扩这一层语义，不改 Reka 的键盘、`aria-expanded` 与高度动画。
 */

const ITEM_VALUE = 'body'

const props = withDefaults(defineProps<{
  /** 传 `null`/不传 = 非受控；传 boolean = 受控。 */
  open?: boolean | null
  keepMounted?: boolean
  compact?: boolean
  instant?: boolean
  collapsible?: boolean
  /** 常开、不可收起的区域不显示 chevron（仍保留右侧占位，标题不跳）。 */
  showIcon?: boolean
  /** 触发器所在容器已带边框时，给 trigger 补统一的内边距。 */
  padded?: boolean
  title?: string
  description?: string
  class?: string
  itemClass?: string
  triggerClass?: string
  contentClass?: string
  headingLevel?: 2 | 3 | 4
}>(), {
  open: null,
  keepMounted: false,
  compact: false,
  instant: false,
  collapsible: true,
  showIcon: true,
  padded: false,
  headingLevel: 3,
})

/** Reka 的 AccordionHeader 接受 `as`，默认 h3。层级落在**包住触发器的那个标题
 *  容器**上，按钮里不再套标题。 */
const headerAs = computed(() => `h${props.headingLevel}` as 'h2' | 'h3' | 'h4')

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const uncontrolledOpen = ref(false)
const resolvedOpen = computed(() => props.open ?? uncontrolledOpen.value)

const triggerClasses = computed(() => [
  props.compact ? 'py-2 text-table' : 'py-4 text-sm',
  props.padded && 'px-3',
  props.triggerClass,
])

const contentClasses = computed(() => [
  props.compact ? 'pb-3' : 'pb-4',
  props.contentClass,
])

function onUpdate(value: string | string[] | undefined) {
  const open = Array.isArray(value) ? value.includes(ITEM_VALUE) : value === ITEM_VALUE
  if (props.open === null) uncontrolledOpen.value = open
  emit('update:open', open)
}
</script>

<template>
  <Accordion
    type="single"
    :collapsible="collapsible"
    :model-value="resolvedOpen ? ITEM_VALUE : undefined"
    :unmount-on-hide="!keepMounted"
    :class="['disclosure-panel', instant && 'disclosure-instant', props.class]"
    @update:model-value="onUpdate"
  >
    <AccordionItem :value="ITEM_VALUE" :class="['border-0', itemClass]">
      <slot name="header" />
      <AccordionTrigger :class="triggerClasses" :header-as="headerAs">
        <span class="flex min-w-0 flex-1 items-center gap-2">
          <slot name="trigger">
            <slot name="title">
              <span class="min-w-0 flex-1 text-left">{{ title }}</span>
            </slot>
            <span v-if="description" class="text-muted-foreground text-table font-normal">{{ description }}</span>
          </slot>
        </span>
        <template v-if="$slots.chevron" #icon>
          <slot name="chevron" />
        </template>
        <template v-else-if="!showIcon" #icon>
          <span class="size-4 shrink-0" aria-hidden="true" />
        </template>
      </AccordionTrigger>
      <AccordionContent :class="contentClasses">
        <slot />
      </AccordionContent>
    </AccordionItem>
  </Accordion>
</template>

<style scoped>
/* 程序化收起（开始对比）直接用最终高度定位，不播放高度动画。 */
.disclosure-instant :deep([data-slot='accordion-content']) {
  animation: none !important;
}
</style>
