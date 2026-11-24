<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "#core/lib/utils"

const props = withDefaults(defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  class?: HTMLAttributes["class"]
  /** 列表工具栏搜索框用 `sm`（32px 等高）；表单/弹窗内保持默认 36px。 */
  size?: "default" | "sm"
}>(), {
  size: "default",
})

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})
</script>

<template>
  <input
    v-model="modelValue"
    data-slot="input"
    :data-size="props.size"
    :class="cn(
      'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input w-full min-w-0 rounded-md border bg-transparent px-3 py-1 shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
      props.size === 'sm' ? 'h-8 text-xs' : 'h-9 text-table',
      'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3',
      'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
      props.class,
    )"
  >
</template>
