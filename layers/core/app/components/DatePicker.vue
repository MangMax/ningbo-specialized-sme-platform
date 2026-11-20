<script setup lang="ts">
import { computed, ref, type HTMLAttributes } from 'vue'
import { CalendarIcon } from '@lucide/vue'
import { parseDate, type DateValue } from '@internationalized/date'
import { Button } from '#core/app/components/ui/button'
import { Calendar } from '#core/app/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '#core/app/components/ui/popover'
import { cn } from '#core/lib/utils'

const props = withDefaults(defineProps<{
  id: string
  label: string
  modelValue: string
  class?: HTMLAttributes['class']
  size?: 'sm' | 'default'
}>(), { size: 'sm' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const open = ref(false)
const value = computed(() => {
  try { return props.modelValue ? parseDate(props.modelValue) : undefined } catch { return undefined }
})
function selectDate(next: DateValue | undefined) {
  if (!next) return
  emit('update:modelValue', next.toString())
  open.value = false
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button :id="id" type="button" variant="outline" :size="size" :class="cn('w-40 justify-between', props.class)" :aria-label="label">
        <span>{{ modelValue || '选择日期' }}</span><CalendarIcon data-icon="inline-end" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" :collision-padding="8" class="max-h-(--reka-popover-content-available-height) w-auto overflow-y-auto overscroll-contain p-0" :aria-label="label">
      <Calendar layout="month-and-year" :model-value="value" locale="zh-CN" :calendar-label="label" :week-starts-on="1" :prevent-deselect="true" @update:model-value="selectDate" />
    </PopoverContent>
  </Popover>
</template>
