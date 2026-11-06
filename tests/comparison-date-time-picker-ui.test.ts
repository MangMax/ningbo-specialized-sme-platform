// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { CalendarDate } from '@internationalized/date'
import { TimeFieldRoot } from 'reka-ui'
import { Calendar } from '../components/ui/calendar'
import ComparisonDateTimePicker from '../components/record-correspondence/ComparisonDateTimePicker.vue'

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
  // Temporary native-select lookup until #505 supplies Chinese accessible names.
  const selects = document.querySelectorAll('select')
  expect(selects).toHaveLength(2)
  for (const [select, next] of [[selects[1], year], [selects[0], month]] as const) {
    select!.value = next
    select!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
  }
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
  const selects = document.querySelectorAll('select')
  expect(selects[0]!.value).toBe('1')
  expect(selects[1]!.value).toBe('2024')
  await navigate('2024', '4')
  await clickDay('2024-04-30')
  expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['2024-04-30T23:59:58.987'])
})

it('opens empty at the local current month without filling and selects midnight through a real day', async () => {
  const view = await start('')
  const now = new Date()
  const selects = document.querySelectorAll('select')
  expect(selects[0]!.value).toBe(String(now.getMonth() + 1))
  expect(selects[1]!.value).toBe(String(now.getFullYear()))
  expect(view.emitted('update:modelValue')).toBeUndefined()
  await navigate('2024', '2')
  await clickDay('2024-02-29')
  expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['2024-02-29T00:00:00'])
})

it('keeps an old selected year and supports adjacent-month arrows and day selection', async () => {
  const view = await start('1800-12-31T12:34:56.789')
  expect(document.querySelectorAll('select')[1]!.value).toBe('1800')
  document.querySelector<HTMLButtonElement>('[aria-label="下一月"]')!.click(); await flushPromises()
  expect(document.querySelectorAll('select')[0]!.value).toBe('1')
  expect(document.querySelectorAll('select')[1]!.value).toBe('1801')
  expect(view.emitted('update:modelValue')).toBeUndefined()
  const day = document.querySelector<HTMLElement>('[data-value="1801-01-31"]')!
  day.click()
  await flushPromises()
  expect(view.emitted('update:modelValue')?.at(-1)).toEqual(['1801-01-31T12:34:56.789'])
})
