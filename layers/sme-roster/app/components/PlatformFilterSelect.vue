<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'

const props = defineProps<{
  class?: HTMLAttributes['class']
  modelValue: string
  options: readonly (string | number)[]
  label: string
  placeholder: string
  disabled?: boolean
  formatLabel?: (value: string) => string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const text = (value: string | number) => props.formatLabel?.(String(value)) ?? String(value)
const selected = computed(() => props.modelValue ? `value:${props.modelValue}` : 'all')
const summary = computed(() => props.modelValue ? text(props.modelValue) : props.options.length || props.disabled ? props.placeholder : `暂无${props.label}`)
function select(value: unknown) {
  emit('update:modelValue', value === 'all' ? '' : String(value).slice('value:'.length))
}
</script>

<template>
  <Select :model-value="selected" @update:model-value="select">
    <SelectTrigger size="sm" :class="['bg-card w-full', props.class]" :aria-label="label" :title="summary" :disabled="disabled || (!options.length && !modelValue)">
      <SelectValue class="min-w-0 flex-1 truncate text-left">{{ summary }}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        <SelectItem value="all">{{ placeholder }}</SelectItem>
        <SelectItem class="whitespace-normal break-words" v-for="option in options" :key="String(option)" :value="`value:${option}`">{{ text(option) }}</SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
</template>
