<script setup lang="ts">
import { computed } from 'vue'
import { Button } from './ui/button'
import FilterChip from './FilterChip.vue'

/**
 * 已生效筛选的统一展示：一行可单独撤掉的 FilterChip，外加一个整体的
 * 「清除筛选」。没有生效条件时整条不占位。
 *
 * `items` 里的 `label` 已是「键：值」格式（如「称号：小巨人」），
 * 组件不猜业务字段名。
 */
const props = withDefaults(
  defineProps<{
    items: readonly { key: string; label: string }[]
    clearLabel?: string
    /** 生效条件达到这个数量才出现整体清除按钮。 */
    showClearMin?: number
    ariaLabel?: string
    disabled?: boolean
  }>(),
  { clearLabel: '清除筛选', showClearMin: 1, ariaLabel: '已应用筛选' },
)

const emit = defineEmits<{
  remove: [key: string]
  clear: []
}>()

const showClear = computed(() => props.items.length >= props.showClearMin)
</script>

<template>
  <div
    v-if="items.length"
    role="group"
    :aria-label="ariaLabel"
    class="flex min-w-0 flex-wrap items-center gap-1.5"
  >
    <TransitionGroup
      tag="div"
      class="flex min-w-0 flex-wrap items-center gap-1.5"
      enter-active-class="transition duration-150 ease-snap motion-reduce:transition-none"
      enter-from-class="scale-90 opacity-0"
      leave-active-class="transition duration-100 ease-snap motion-reduce:transition-none"
      leave-to-class="scale-90 opacity-0"
      move-class="transition duration-150 ease-snap motion-reduce:transition-none"
    >
      <FilterChip
        v-for="item in items"
        :key="item.key"
        :label="item.label"
        :disabled="disabled"
        @remove="emit('remove', item.key)"
      />
    </TransitionGroup>
    <Button
      v-if="showClear"
      variant="ghost"
      size="sm"
      class="text-muted-foreground h-7 px-2 text-xs"
      :disabled="disabled"
      @click="emit('clear')"
    >
      {{ clearLabel }}
    </Button>
  </div>
</template>
