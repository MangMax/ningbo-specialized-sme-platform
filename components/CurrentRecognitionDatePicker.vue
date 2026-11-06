<script setup lang="ts">
import { computed, ref } from 'vue'
import { CalendarIcon } from '@lucide/vue'
import { parseDate, type DateValue } from '@internationalized/date'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const props = defineProps<{ id: string; label: string; modelValue: string }>()
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
      <Button :id="id" variant="outline" size="sm" class="w-40 justify-between" :aria-label="label">
        <span>{{ modelValue || '选择日期' }}</span><CalendarIcon data-icon="inline-end" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-auto p-0" :aria-label="label">
      <Calendar layout="month-and-year" :model-value="value" locale="zh-CN" :calendar-label="label" :week-starts-on="1" :prevent-deselect="true" @update:model-value="selectDate" />
    </PopoverContent>
  </Popover>
</template>
