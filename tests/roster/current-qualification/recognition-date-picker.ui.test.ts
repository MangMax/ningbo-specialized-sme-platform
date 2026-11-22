// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it } from 'vitest'
import { calendarPeriodValue, chooseCalendarPeriod, openCalendarPeriod } from '../../support/calendar-period'
import DatePicker from '../../../layers/core/app/components/DatePicker.vue'

let view: ReturnType<typeof mount>
afterEach(() => { view?.unmount(); document.body.innerHTML = '' })
async function open(value = '2024-01-31', label = '认定时间起') {
  view = mount(DatePicker, { props: { id: 'date', label, modelValue: value }, attachTo: document.body })
  await view.get('#date').trigger('click'); await flushPromises()
}
async function navigate(year: string, month: string) {
  await chooseCalendarPeriod('年份', year); await chooseCalendarPeriod('月份', month); await flushPromises()
}
it.each(['认定时间起', '认定时间止'])('%s navigates real controls to leap day and commits only the clicked day', async label => {
  await open('2026-01-31', label)
  expect(document.querySelector('select')).toBeNull()
  expect(document.querySelector('[data-slot="calendar"] [role="combobox"]')).toBeNull()
  const years = await openCalendarPeriod('年份')
  expect(years.querySelectorAll('[data-slot="calendar-year-option"]')).toHaveLength(12)
  await navigate('2024', '2')
  expect(view.emitted('update:modelValue')).toBeUndefined()
  const day = document.querySelector<HTMLElement>('[data-value="2024-02-29"]')!
  expect(day).not.toBeNull()
  day.click(); await flushPromises()
  expect(view.emitted('update:modelValue')).toEqual([['2024-02-29']])
  expect(document.querySelector('select')).toBeNull()
})
it('cancels navigation and reopens at the selected month', async () => {
  await open()
  await navigate('2020', '2')
  document.querySelector<HTMLElement>('[data-slot="popover-content"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flushPromises()
  expect(view.emitted('update:modelValue')).toBeUndefined()
  await view.get('#date').trigger('click'); await flushPromises()
  expect(calendarPeriodValue('年份')).toBe('2024')
  expect(calendarPeriodValue('月份')).toBe('1')
})
it('opens empty at today without filling a value and handles non-leap month ends', async () => {
  await open('')
  expect(calendarPeriodValue('年份')).toBe(String(new Date().getFullYear()))
  expect(calendarPeriodValue('月份')).toBe(String(new Date().getMonth() + 1))
  expect(view.emitted('update:modelValue')).toBeUndefined()
  await navigate('2023', '2')
  expect(document.querySelector('[data-value="2023-02-29"]')).toBeNull()
  document.querySelector<HTMLElement>('[data-value="2023-02-28"]')!.click()
  await flushPromises()
  expect(view.emitted('update:modelValue')).toEqual([['2023-02-28']])
})
it('preserves an existing year outside the default range and keeps month arrows', async () => {
  await open('1900-12-31')
  expect(calendarPeriodValue('年份')).toBe('1900')
  const next = document.querySelector<HTMLButtonElement>('[data-slot="calendar-next-button"]')!
  next.click(); await flushPromises()
  expect(calendarPeriodValue('年份')).toBe('1901')
  expect(calendarPeriodValue('月份')).toBe('1')
  expect(view.emitted('update:modelValue')).toBeUndefined()
})

it('opens the month grid directly and moves keyboard focus before any day is selected', async () => {
  await open()
  const months = await openCalendarPeriod('月份')
  expect(months.querySelectorAll('[data-slot="calendar-month-option"]')).toHaveLength(12)
  const focusedMonth = document.activeElement as HTMLButtonElement
  expect(focusedMonth.dataset.value).toBe('2024-01-01')
  focusedMonth.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }))
  await flushPromises()
  const february = document.activeElement as HTMLButtonElement
  expect(february.dataset.value).toBe('2024-02-01')
  february.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  expect(calendarPeriodValue('月份')).toBe('2')
  expect(view.emitted('update:modelValue')).toBeUndefined()
})
