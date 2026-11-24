<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { ref } from "vue"
import { cn } from "#core/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()

const containerRef = ref<HTMLElement | null>(null)
const hoverRect = ref<{ top: number; height: number; visible: boolean }>({
  top: 0,
  height: 0,
  visible: false,
})

/**
 * Fluid Functionalism 风格的行跟随悬停层：
 * 鼠标在表体行间移动时，用单层滑块平滑跟随当前行（top / height 过渡），
 * 减少逐行闪烁感；在 prefers-reduced-motion 下由 CSS 自动关闭过渡。
 */
function onPointerMove(event: PointerEvent) {
  if (event.pointerType === "touch") return
  const container = containerRef.value
  if (!container) return
  const target = event.target as HTMLElement | null
  const row = target?.closest<HTMLTableRowElement>('tbody > tr[data-slot="table-row"]')
  if (!row || !container.contains(row) || row.hasAttribute("aria-hidden")) {
    if (hoverRect.value.visible) hoverRect.value.visible = false
    return
  }
  const containerRect = container.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  const top = rowRect.top - containerRect.top + container.scrollTop
  const height = rowRect.height
  if (
    hoverRect.value.visible
    && Math.abs(hoverRect.value.top - top) < 0.5
    && Math.abs(hoverRect.value.height - height) < 0.5
  ) {
    return
  }
  hoverRect.value = { top, height, visible: true }
}

function onPointerLeave() {
  if (hoverRect.value.visible) hoverRect.value.visible = false
}
</script>

<template>
  <div
    ref="containerRef"
    data-slot="table-container"
    class="relative w-full overflow-auto"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <div
      aria-hidden="true"
      data-slot="table-fluid-hover"
      class="table-fluid-hover pointer-events-none absolute right-0 left-0 z-0"
      :style="{
        transform: `translate3d(0, ${hoverRect.top}px, 0)`,
        height: `${hoverRect.height}px`,
        opacity: hoverRect.visible ? 1 : 0,
      }"
    />
    <table data-slot="table" :class="cn('text-table relative z-1 w-full caption-bottom', props.class)">
      <slot />
    </table>
  </div>
</template>
