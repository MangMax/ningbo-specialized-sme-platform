// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { CalendarDate } from '@internationalized/date'
import { TimeFieldRoot } from 'reka-ui'
import { calendarSelectValue, calendarYearOptions, chooseCalendarSelect } from '../../support/calendar-select'
import { Calendar } from '../../../components/ui/calendar'
import ComparisonDateTimePicker from '../../../components/record-correspondence/ComparisonDateTimePicker.vue'

let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = '' })
async function start(modelValue: string) {
  wrapper = mount(ComparisonDateTimePicker, { props: { id: 'cutoff', modelValue }, attachTo: document.body })
  await wrapper.get('#cutoff').trigger('click')
  await flushPromises()
  return wrapper
}

describe('comparison calendar and segmented time picker', () => {
  it('uses the shared calendar and edits dates without changing local time or milliseconds', async () => {
    const view = await start('2026-10-18T18:04:05.123')
    expect(view.find('input[type="datetime-local"]').exists()).toBe(false)
    expect(view.findComponent(Calendar).exists()).toBe(true)
    expect(view.emitted('update:modelValue')).toBeUndefined()
    view.findComponent(Calendar).vm.$emit('update:modelValue', new CalendarDate(2026, 10, 19))
    expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['2026-10-19T18:04:05.123'])
  })

  it('edits the minute segment by keyboard and reports partial time separately from an empty cutoff', async () => {
    const view = await start('2026-10-18T18:04:05.123')
    const minute = document.querySelector<HTMLElement>('[data-reka-time-field-segment="minute"]')!
    minute.focus()
    minute.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['2026-10-18T18:05:05.123'])
    minute.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(view.emitted('validity-change')?.at(-1)).toEqual([false])
    expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['2026-10-18T18:05:05.123'])
  })

  it('supports an optional empty cutoff, selecting a date at midnight and explicitly clearing it', async () => {
    const view = await start('')
    expect(view.findComponent(TimeFieldRoot).props('disabled')).toBe(true)
    view.findComponent(Calendar).vm.$emit('update:modelValue', new CalendarDate(2026, 10, 18))
    expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['2026-10-18T00:00:00'])
    await view.setProps({ modelValue: '2026-10-18T00:00:00' })
    expect(view.findComponent(TimeFieldRoot).props('disabled')).toBe(false)
    const clear = [...document.querySelectorAll('button')].find(button => button.textContent === '清除截止时点')!
    clear.click()
    await flushPromises()
    expect(view.emitted('update:modelValue')?.at(-1)).toEqual([''])
    expect(view.emitted('validity-change')?.at(-1)).toEqual([true])
  })
})

async function navigate(year: string, month: string) {
  await chooseCalendarSelect('年份', year)
  await chooseCalendarSelect('月份', month)
}
async function clickDay(day: string) {
  const cell = document.querySelector<HTMLElement>(`[data-value="${day}"]`)
  expect(cell, day).not.toBeNull()
  cell!.click()
  await flushPromises()
}

it('jumps years and months without committing, then selects a leap day preserving fractions', async () => {
  const view = await start('2026-10-18T18:04:05.123')
  await navigate('2024', '2')
  expect(view.emitted('update:modelValue')).toBeUndefined()
  await clickDay('2024-02-29')
  expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['2024-02-29T18:04:05.123'])
})

it('discards month-only browsing on close and reopens at the selected month end', async () => {
  const view = await start('2024-01-31T23:59:58.987')
  await navigate('2023', '2')
  expect(document.querySelector('[data-value="2023-02-29"]')).toBeNull()
  const done = [...document.querySelectorAll('button')].find(button => button.textContent === '完成')!
  done.click(); await flushPromises()
  expect(view.emitted('update:modelValue')).toBeUndefined()
  await view.get('#cutoff').trigger('click'); await flushPromises()
  expect(calendarSelectValue('月份')).toBe('1')
  expect(calendarSelectValue('年份')).toBe('2024')
  await navigate('2024', '4')
  await clickDay('2024-04-30')
  expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['2024-04-30T23:59:58.987'])
})

it('opens empty at the local current month without filling and selects midnight through a real day', async () => {
  const view = await start('')
  const now = new Date()
  expect(calendarSelectValue('月份')).toBe(String(now.getMonth() + 1))
  expect(calendarSelectValue('年份')).toBe(String(now.getFullYear()))
  expect(view.emitted('update:modelValue')).toBeUndefined()
  await navigate('2024', '2')
  await clickDay('2024-02-29')
  expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['2024-02-29T00:00:00'])
})

it('keeps an old selected year and supports adjacent-month arrows and day selection', async () => {
  const view = await start('1800-12-31T12:34:56.789')
  expect(calendarSelectValue('年份')).toBe('1800')
  document.querySelector<HTMLButtonElement>('[aria-label="下一月"]')!.click(); await flushPromises()
  expect(calendarSelectValue('月份')).toBe('1')
  expect(calendarSelectValue('年份')).toBe('1801')
  expect(view.emitted('update:modelValue')).toBeUndefined()
  const day = document.querySelector<HTMLElement>('[data-value="1801-01-31"]')!
  day.click()
  await flushPromises()
  expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['1801-01-31T12:34:56.789'])
})

it.each(['', '1800-12-31T12:34:56.789'])('keeps default years reachable while browsing from cutoff %s', async cutoff => {
  const view = await start(cutoff)
  const currentYear = new Date().getFullYear()
  const earliestYear = String(currentYear - 100)
  const latestYear = String(currentYear + 10)
  const options = calendarYearOptions
  expect(await options()).toContain(earliestYear)
  expect(await options()).toContain(latestYear)
  if (cutoff) expect(calendarSelectValue('年份')).toBe('1800')
  await navigate(earliestYear, '1')
  expect(calendarSelectValue('年份')).toBe(earliestYear)
  expect(await options()).toContain(latestYear)
  await navigate(latestYear, '12')
  expect(calendarSelectValue('年份')).toBe(latestYear)
  expect(await options()).toContain(earliestYear)
  if (cutoff) {
    expect(await options()).toContain('1800')
    await navigate('1800', '12')
    expect(calendarSelectValue('年份')).toBe('1800')
  }
  expect(view.emitted('update:modelValue')).toBeUndefined()
})

it.each([false, true])('preserves caller date limits with custom year range %s', async customRange => {
  wrapper = mount(Calendar, {
    props: {
      layout: 'month-and-year', locale: 'zh-CN',
      defaultPlaceholder: new CalendarDate(2024, 2, 29),
      minValue: new CalendarDate(2024, 2, 10),
      maxValue: new CalendarDate(2024, 3, 20),
      ...(customRange ? { yearRange: [new CalendarDate(2023, 1, 1), new CalendarDate(2024, 1, 1), new CalendarDate(2025, 1, 1)] } : {}),
    },
    attachTo: document.body,
  })
  await flushPromises()
  const years = calendarYearOptions
  const expectedYears = customRange ? ['2023', '2024', '2025'] : ['2024']
  expect(await years()).toEqual(expectedYears)
  await navigate('2024', '3')
  expect(await years()).toEqual(expectedYears)
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  expect(document.querySelector('[data-value="2024-03-21"]')!.hasAttribute('data-disabled')).toBe(true)
  await clickDay('2024-03-21')
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  await clickDay('2024-03-20')
  expect(String(wrapper.emitted('update:modelValue')?.at(-1)?.[0])).toBe('2024-03-20')
  await navigate('2024', '2')
  expect(document.querySelector('[data-value="2024-02-09"]')!.hasAttribute('data-disabled')).toBe(true)
  await clickDay('2024-02-09')
  expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
  await clickDay('2024-02-10')
  expect(String(wrapper.emitted('update:modelValue')?.at(-1)?.[0])).toBe('2024-02-10')
})
