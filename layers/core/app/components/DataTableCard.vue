<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '#core/lib/utils'
import { Card } from './ui/card'

/**
 * 列表结果卡：筛选工具栏 + 结果正文 + 分页，四周共用一张 Card。
 *
 * - 有 `sidebar` 插槽时，宽屏排成「目录栏 | 结果卡」双栏；窄屏自动叠成单栏。
 * - 工具栏固定在卡顶部，正文（`default`）在剩余高度里滚动，
 *   分页放进 `footer` 插槽，始终在滚动区外。
 * - 只提供骨架，不接管滚动容器；表格本身仍用 `.data-table-scroll`。
 */
const props = withDefaults(
  defineProps<{
    /** 工具栏的可访问名称，如「企业列表筛选与操作」。 */
    toolbarLabel?: string
    /** 工具栏在窄屏/低高度时会滚动，需要可聚焦的区域语义时开启。 */
    filterScroll?: boolean
    /** 正文请求进行中。 */
    bodyBusy?: boolean
    class?: HTMLAttributes['class']
    toolbarClass?: HTMLAttributes['class']
    bodyClass?: HTMLAttributes['class']
  }>(),
  { filterScroll: false },
)

defineSlots<{
  sidebar?(): unknown
  toolbar?(): unknown
  status?(): unknown
  default?(): unknown
  footer?(): unknown
}>()
</script>

<template>
  <div
    :class="
      cn(
        'min-h-0 min-w-0 flex-1',
        $slots.sidebar
          ? 'grid grid-rows-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)]'
          : 'flex flex-col',
        props.class,
      )
    "
  >
    <div
      v-if="$slots.sidebar"
      class="min-h-0 min-w-0 overflow-y-auto overscroll-contain"
    >
      <slot name="sidebar" />
    </div>

    <Card
      class="paginated-table-card relative flex min-h-0 min-w-0 flex-1 flex-col gap-0 overflow-hidden py-0 shadow-none"
    >
      <div
        v-if="$slots.toolbar || props.toolbarLabel"
        :role="props.toolbarLabel ? 'region' : undefined"
        :aria-label="props.toolbarLabel"
        :tabindex="props.filterScroll ? 0 : undefined"
        :class="
          cn(
            'table-toolbar flex flex-col gap-2.5',
            props.filterScroll && 'workspace-list-filter',
            props.toolbarClass,
          )
        "
      >
        <slot name="toolbar" />
      </div>

      <div
        :class="cn('paginated-table-body relative flex min-h-0 flex-1 flex-col', props.bodyClass)"
        :aria-busy="props.bodyBusy ? 'true' : undefined"
      >
        <slot name="status" />
        <slot />
      </div>

      <div v-if="$slots.footer" class="shrink-0">
        <slot name="footer" />
      </div>
    </Card>
  </div>
</template>
