<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CalendarIcon } from '@lucide/vue'
import { getLocalTimeZone, today, parseDateTime, Time, toCalendarDate, toCalendarDateTime, type DateValue } from '@internationalized/date'
import { TimeFieldInput, TimeFieldRoot } from 'reka-ui'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const props = withDefaults(defineProps<{ id: string; modelValue: string; label?: string }>(), { label: '截止日期和时间' })
const emit = defineEmits<{ 'update:modelValue': [value: string]; 'validity-change': [valid: boolean] }>()
const open = ref(false)
const value = computed(() => {
  try { return props.modelValue ? parseDateTime(props.modelValue) : undefined } catch { return undefined }
})
const date = computed(() => value.value ? toCalendarDate(value.value) : undefined)
const placeholder = ref<DateValue>(today(getLocalTimeZone()))
watch(open, (isOpen) => {
  if (isOpen) placeholder.value = date.value ?? today(getLocalTimeZone())
})
const time = ref<Time>()
watch(() => props.modelValue, () => {
  time.value = value.value ? new Time(value.value.hour, value.value.minute, value.value.second, value.value.millisecond) : undefined
  emit('validity-change', true)
}, { immediate: true })
const pad = (number: number) => String(number).padStart(2, '0')
const display = computed(() => value.value
  ? `${value.value.year}年${value.value.month}月${value.value.day}日 ${pad(value.value.hour)}:${pad(value.value.minute)}:${pad(value.value.second)}`
  : '选择日期和时间')
function selectDate(next: DateValue | undefined) {
  if (!next) return
  const updated = value.value
    ? value.value.set({ year: next.year, month: next.month, day: next.day })
    : toCalendarDateTime(next, new Time())
  emit('update:modelValue', updated.toString())
}
function selectTime(next: { hour: number; minute: number; second: number; millisecond: number } | undefined) {
  time.value = next ? new Time(next.hour, next.minute, next.second, next.millisecond) : undefined
  emit('validity-change', !!next)
  if (!next || !value.value) return
  emit('update:modelValue', value.value.set({ hour: next.hour, minute: next.minute, second: next.second, millisecond: next.millisecond }).toString())
}
function clear() { emit('validity-change', true); emit('update:modelValue', ''); open.value = false }
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button :id="id" type="button" variant="outline" class="w-full justify-between" :aria-label="`选择${label}`">
        <span>{{ display }}</span><CalendarIcon data-icon="inline-end" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-auto p-0" :aria-label="label">
      <Calendar v-model:placeholder="placeholder" layout="month-and-year" :model-value="date" locale="zh-CN" :calendar-label="label" :week-starts-on="1" :prevent-deselect="true" @update:model-value="selectDate" />
      <div class="flex flex-col gap-2 border-t p-3">
        <Label :for="`${id}-time`">本地时间（时:分:秒）</Label>
        <TimeFieldRoot :id="`${id}-time`" v-slot="{ segments }" :model-value="time" :disabled="!value" locale="zh-CN" :hour-cycle="24" granularity="second" class="border-input flex h-9 items-center gap-1 rounded-md border px-3 text-sm" @update:model-value="selectTime">
          <TimeFieldInput v-for="(segment, index) in segments" :key="index" :part="segment.part" class="rounded-sm px-0.5 outline-none focus:bg-accent focus:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring" :aria-label="segment.part === 'hour' ? '小时' : segment.part === 'minute' ? '分钟' : segment.part === 'second' ? '秒钟' : undefined">{{ segment.value }}</TimeFieldInput>
        </TimeFieldRoot>
        <div class="flex justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" :disabled="!modelValue" @click="clear">清除{{ label === '截止日期和时间' ? '截止时点' : label }}</Button>
          <Button type="button" size="sm" @click="open = false">完成</Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
