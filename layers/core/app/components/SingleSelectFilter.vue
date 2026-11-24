<script setup lang="ts">
import { computed } from 'vue'
import type { HTMLAttributes } from 'vue'
import { cn } from '#core/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'

/**
 * 单值筛选：包一层 shadcn Select，与 MultiSelectFilter 成对使用。
 *
 * Reka 的 SelectItem 不接受空字符串，所以「不筛选」用哨兵值 `all` 表示；
 * 调用方收到 `all` 就当作清空该条件。触发按钮在有值时高亮（data-active），
 * 不打开下拉也能看出这一项正生效。
 */
const ALL = 'all'

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: readonly { value: string; label: string }[]
    /** 未筛选时按钮上的文案，如「全部称号」。 */
    placeholder: string
    ariaLabel: string
    /** 有值时加在值前面的字段名，如「称号」。 */
    summaryPrefix?: string
    disabled?: boolean
    class?: HTMLAttributes['class']
  }>(),
  { summaryPrefix: '' },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const active = computed(() => Boolean(props.modelValue) && props.modelValue !== ALL)

const display = computed(() => {
  if (!active.value) return props.placeholder
  const label = props.options.find((option) => option.value === props.modelValue)?.label
    ?? props.modelValue
  return props.summaryPrefix ? `${props.summaryPrefix}：${label}` : label
})
</script>

<template>
  <Select
    :model-value="props.modelValue || ALL"
    :disabled="props.disabled"
    @update:model-value="(value: unknown) => emit('update:modelValue', String(value))"
  >
    <SelectTrigger
      size="sm"
      :data-active="active"
      :aria-label="props.ariaLabel"
      :class="
        cn(
          'bg-card justify-between gap-1.5 font-normal shadow-none transition-colors',
          'data-[active=true]:border-primary/45 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground data-[active=true]:font-medium',
          props.class,
        )
      "
    >
      <SelectValue>{{ display }}</SelectValue>
    </SelectTrigger>
    <SelectContent align="start" class="shadow-none">
      <SelectItem :value="ALL">{{ props.placeholder }}</SelectItem>
      <SelectItem v-for="option in props.options" :key="option.value" :value="option.value">
        {{ option.label }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
