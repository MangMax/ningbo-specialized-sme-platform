<script lang="ts" setup>
import type { CalendarRootEmits, CalendarRootProps, DateValue } from 'reka-ui'
import type { HTMLAttributes, Ref } from 'vue'
import type { LayoutTypes } from '.'
import { endOfYear, getLocalTimeZone, startOfYear, today } from '@internationalized/date'
import { createReusableTemplate, reactiveOmit, useVModel } from '@vueuse/core'
import { CalendarRoot, useDateFormatter, useForwardPropsEmits } from 'reka-ui'
import { toDate } from 'reka-ui/date'
import { computed, nextTick, ref, shallowRef } from 'vue'
import { Button } from '#core/app/components/ui/button'
import { cn } from '#core/lib/utils'
import {
  CalendarCell, CalendarCellTrigger, CalendarGrid, CalendarGridBody, CalendarGridHead, CalendarGridRow,
  CalendarHeadCell, CalendarHeader, CalendarHeading, CalendarNextButton, CalendarPrevButton,
} from '.'
import CalendarPeriodPicker from './CalendarPeriodPicker.vue'

type View = 'days' | 'months' | 'years'

const props = withDefaults(defineProps<CalendarRootProps & {
  class?: HTMLAttributes['class']
  layout?: LayoutTypes
  yearRange?: DateValue[]
}>(), { modelValue: undefined })
const emits = defineEmits<CalendarRootEmits>()

const delegatedProps = reactiveOmit(props, 'class', 'layout', 'placeholder', 'yearRange')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
const localToday = today(getLocalTimeZone())
const selectedDates = computed(() => Array.isArray(props.modelValue) ? props.modelValue : props.modelValue ? [props.modelValue] : [])
const placeholder = useVModel(props, 'placeholder', emits, {
  passive: true,
  defaultValue: props.defaultPlaceholder ?? selectedDates.value[0] ?? localToday,
}) as Ref<DateValue>

const view = ref<View>('days')
const viewHost = ref<HTMLElement>()
const periodAnchor = shallowRef(placeholder.value)
const canChooseMonth = computed(() => props.layout === 'month-and-year' || props.layout === 'month-only')
const canChooseYear = computed(() => props.layout === 'month-and-year' || props.layout === 'year-only')
const referenceYear = props.defaultPlaceholder ?? localToday
const yearBounds = computed(() => {
  const allowed = props.yearRange?.length
    ? props.yearRange
    : [referenceYear.cycle('year', -100), referenceYear.cycle('year', 10)]
  const ordered = [...allowed, ...selectedDates.value, periodAnchor.value, placeholder.value]
    .sort((a, b) => a.compare(b))
  return {
    min: props.minValue ?? startOfYear(ordered[0]!),
    max: props.maxValue ?? endOfYear(ordered[ordered.length - 1]!),
  }
})
const isYearDisabled = (date: DateValue) => (
  Boolean(props.yearRange?.length)
  && ![...(props.yearRange ?? []), ...selectedDates.value, placeholder.value].some(value => value.year === date.year && value.era === date.era)
)

const formatter = useDateFormatter(props.locale ?? 'en')
const monthLabel = (date: DateValue) => formatter.custom(toDate(date), { month: 'short' })
const yearLabel = (date: DateValue) => formatter.custom(toDate(date), { year: 'numeric' })

function clampDate(date: DateValue) {
  if (props.minValue && date.compare(props.minValue) < 0) return props.minValue
  if (props.maxValue && date.compare(props.maxValue) > 0) return props.maxValue
  return date
}

async function showView(next: View, anchor = placeholder.value) {
  if (next === view.value) return
  periodAnchor.value = clampDate(anchor)
  view.value = next
  await nextTick()
  const panel = viewHost.value?.querySelector(`[data-calendar-view="${next}"]:not([inert])`)
  const focusTarget = panel?.querySelector<HTMLElement>('button[tabindex="0"]:not([aria-disabled="true"])')
    ?? panel?.querySelector<HTMLElement>('button:not([disabled]):not([aria-disabled="true"])')
  focusTarget?.focus({ preventScroll: true })
}

function selectPeriod(date: DateValue) {
  const selectingYear = view.value === 'years'
  placeholder.value = clampDate(placeholder.value.set(
    selectingYear ? { year: date.year, era: date.era } : { year: date.year, era: date.era, month: date.month },
  ))
  void showView(selectingYear && canChooseMonth.value ? 'months' : 'days')
}

const [DefineMonthButton, ReuseMonthButton] = createReusableTemplate<{ date: DateValue }>()
const [DefineYearButton, ReuseYearButton] = createReusableTemplate<{ date: DateValue }>()
</script>

<template>
  <DefineMonthButton v-slot="{ date }">
    <Button
      type="button"
      variant="outline"
      size="sm"
      class="shadow-none"
      :aria-label="`选择月份：${monthLabel(date)}`"
      :disabled="disabled"
      data-slot="calendar-choose-month"
      @click="showView('months')"
    >{{ monthLabel(date) }}</Button>
  </DefineMonthButton>
  <DefineYearButton v-slot="{ date }">
    <Button
      type="button"
      variant="outline"
      size="sm"
      class="shadow-none"
      :aria-label="`选择年份：${yearLabel(date)}`"
      :disabled="disabled"
      data-slot="calendar-choose-year"
      @click="showView('years')"
    >{{ yearLabel(date) }}</Button>
  </DefineYearButton>

  <CalendarRoot
    v-slot="{ grid, weekDays, date }"
    v-bind="forwarded"
    v-model:placeholder="placeholder"
    :fixed-weeks="layout ? true : fixedWeeks"
    data-slot="calendar"
    :class="cn('p-3', layout && (numberOfMonths ?? 1) === 1 && 'w-69 max-w-full', props.class)"
  >
    <div ref="viewHost" class="isolate grid" :class="{ 'min-h-[19.5rem]': layout }">
      <Transition
        enter-active-class="relative z-10 transition-[opacity,translate,scale] duration-200 ease-snap motion-reduce:duration-0 motion-reduce:transition-none"
        leave-active-class="pointer-events-none transition-[opacity,translate,scale] duration-150 ease-snap motion-reduce:hidden motion-reduce:duration-0 motion-reduce:transition-none"
        enter-from-class="motion-safe:translate-y-1 motion-safe:scale-[0.98] motion-safe:opacity-0"
        leave-to-class="motion-safe:-translate-y-1 motion-safe:scale-[0.98] motion-safe:opacity-0"
        @before-leave="element => { (element as HTMLElement).inert = true }"
      >
        <div v-if="view === 'days'" key="days" data-calendar-view="days" class="col-start-1 row-start-1">
          <CalendarHeader class="min-h-8 pt-0">
            <slot name="calendar-heading" :date="date" :month="ReuseMonthButton" :year="ReuseYearButton">
              <div v-if="layout" class="flex items-center justify-center gap-1 text-sm font-medium">
                <ReuseYearButton v-if="canChooseYear" :date="date" />
                <span v-else>{{ yearLabel(date) }}</span>
                <ReuseMonthButton v-if="canChooseMonth" :date="date" />
                <span v-else>{{ monthLabel(date) }}</span>
              </div>
              <CalendarHeading v-else />
            </slot>

            <nav class="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-1">
              <CalendarPrevButton class="size-8 opacity-100 shadow-none">
                <slot name="calendar-prev-icon" />
              </CalendarPrevButton>
              <CalendarNextButton class="size-8 opacity-100 shadow-none">
                <slot name="calendar-next-icon" />
              </CalendarNextButton>
            </nav>
          </CalendarHeader>

          <div class="mt-4 flex flex-col gap-y-4 sm:flex-row sm:gap-x-4 sm:gap-y-0">
            <CalendarGrid v-for="month in grid" :key="month.value.toString()">
              <CalendarGridHead>
                <CalendarGridRow>
                  <CalendarHeadCell v-for="day in weekDays" :key="day">
                    {{ day }}
                  </CalendarHeadCell>
                </CalendarGridRow>
              </CalendarGridHead>
              <CalendarGridBody>
                <CalendarGridRow v-for="(weekDates, index) in month.rows" :key="index" class="mt-2 w-full">
                  <CalendarCell v-for="weekDate in weekDates" :key="weekDate.toString()" :date="weekDate">
                    <CalendarCellTrigger :day="weekDate" :month="month.value" type="button" />
                  </CalendarCell>
                </CalendarGridRow>
              </CalendarGridBody>
            </CalendarGrid>
          </div>
        </div>

        <div v-else :key="view" :data-calendar-view="view" class="col-start-1 row-start-1 flex min-w-[14rem] flex-col">
          <CalendarPeriodPicker
            :period="view"
            :anchor="periodAnchor"
            :locale="locale"
            :dir="dir"
            :min-value="view === 'years' ? yearBounds.min : minValue"
            :max-value="view === 'years' ? yearBounds.max : maxValue"
            :disabled="disabled"
            :allow-year-view="canChooseYear"
            :is-year-disabled="isYearDisabled"
            @show-years="showView('years', $event)"
            @back="showView('days')"
            @select="selectPeriod"
          />
        </div>
      </Transition>
    </div>
  </CalendarRoot>
</template>
