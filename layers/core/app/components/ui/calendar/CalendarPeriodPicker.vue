<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { CalendarDays, ChevronLeft, ChevronRight } from '@lucide/vue'
import { startOfMonth, startOfYear } from '@internationalized/date'
import {
  MonthPickerRoot, MonthPickerHeading, MonthPickerPrev, MonthPickerNext,
  MonthPickerGrid, MonthPickerGridBody, MonthPickerGridRow, MonthPickerCell, MonthPickerCellTrigger,
  YearPickerRoot, YearPickerHeading, YearPickerPrev, YearPickerNext,
  YearPickerGrid, YearPickerGridBody, YearPickerGridRow, YearPickerCell, YearPickerCellTrigger,
  type CalendarRootProps, type DateValue,
} from 'reka-ui'
import { Button, buttonVariants } from '#core/app/components/ui/button'
import { cn } from '#core/lib/utils'

const props = defineProps<{
  period: 'months' | 'years'
  anchor: DateValue
  locale?: string
  dir?: CalendarRootProps['dir']
  minValue?: DateValue
  maxValue?: DateValue
  disabled?: boolean
  allowYearView?: boolean
  isYearDisabled?: (date: DateValue) => boolean
}>()

const emit = defineEmits<{
  select: [date: DateValue]
  'show-years': [date: DateValue]
  back: []
}>()

const monthPicker = {
  root: MonthPickerRoot, heading: MonthPickerHeading, prev: MonthPickerPrev, next: MonthPickerNext,
  grid: MonthPickerGrid, body: MonthPickerGridBody, row: MonthPickerGridRow,
  cell: MonthPickerCell, trigger: MonthPickerCellTrigger,
}

const yearPicker = {
  root: YearPickerRoot, heading: YearPickerHeading, prev: YearPickerPrev, next: YearPickerNext,
  grid: YearPickerGrid, body: YearPickerGridBody, row: YearPickerGridRow,
  cell: YearPickerCell, trigger: YearPickerCellTrigger,
}

const isMonth = computed(() => props.period === 'months')
const picker = computed(() => isMonth.value ? monthPicker : yearPicker)
const cursor = shallowRef(isMonth.value ? startOfMonth(props.anchor) : startOfYear(props.anchor))
const selection = cursor.value
const arrowClass = cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'size-8 shrink-0 shadow-none')
const optionClass = cn(
  buttonVariants({ variant: 'ghost' }),
  'h-12 w-full px-1 tabular-nums',
  'data-[today]:border-border border border-transparent',
  'data-[selected]:bg-primary data-[selected]:text-primary-foreground data-[selected]:hover:bg-primary data-[selected]:hover:text-primary-foreground',
  'aria-disabled:pointer-events-none aria-disabled:opacity-45',
)

function select(value: DateValue | DateValue[] | undefined) {
  if (value && !Array.isArray(value)) emit('select', value)
}
</script>

<template>
  <component
    :is="picker.root"
    v-slot="{ grid }"
    v-model:placeholder="cursor"
    :model-value="selection"
    :calendar-label="isMonth ? '选择月份' : '选择年份'"
    :locale="locale"
    :dir="dir"
    :min-value="minValue"
    :max-value="maxValue"
    :disabled="disabled"
    v-bind="isMonth ? {} : { isYearDisabled }"
    prevent-deselect
    class="flex flex-1 flex-col"
    @update:model-value="select"
  >
    <div class="flex h-8 items-center justify-between gap-2">
      <component
        :is="picker.prev"
        as="button"
        :aria-label="isMonth ? '上一年' : '上一组年份'"
        :class="arrowClass"
      >
        <ChevronLeft data-icon="inline-start" />
      </component>
      <div class="flex items-center justify-center gap-1">
        <component :is="picker.heading" class="text-center text-sm font-medium">
          <template v-if="isMonth && allowYearView" #default="{ headingValue }">
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="shadow-none"
              :aria-label="`选择年份：${headingValue}`"
              data-slot="calendar-choose-year"
              @click="emit('show-years', cursor)"
            >{{ headingValue }}</Button>
          </template>
        </component>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="返回日历"
          title="返回日历"
          @click="emit('back')"
        >
          <CalendarDays />
        </Button>
      </div>
      <component
        :is="picker.next"
        as="button"
        :aria-label="isMonth ? '下一年' : '下一组年份'"
        :class="arrowClass"
      >
        <ChevronRight data-icon="inline-end" />
      </component>
    </div>

    <component :is="picker.grid" class="mt-4 flex flex-1">
      <component :is="picker.body" class="grid flex-1 grid-rows-3 gap-2">
        <component :is="picker.row" v-for="(row, index) in grid.rows" :key="index" class="grid grid-cols-4 gap-1">
          <component
            :is="picker.cell"
            v-for="(date, column) in row"
            :key="column"
            :date="date"
            class="flex min-w-0 items-center p-0"
          >
            <component
              :is="picker.trigger"
              as="button"
              type="button"
              :data-slot="isMonth ? 'calendar-month-option' : 'calendar-year-option'"
              :aria-pressed="date.year === selection.year && date.era === selection.era && (!isMonth || date.month === selection.month)"
              v-bind="isMonth ? { month: date } : { year: date }"
              :class="optionClass"
            />
          </component>
        </component>
      </component>
    </component>
  </component>
</template>
