import { flushPromises } from '@vue/test-utils'
import { expect } from 'vitest'

type Period = '年份' | '月份'

const slots = { 年份: 'year', 月份: 'month' }
const views = { 年份: 'years', 月份: 'months' }

export function calendarPeriodValue(label: Period) {
  const trigger = document.querySelector<HTMLButtonElement>(`[data-calendar-view]:not([inert]) [data-slot="calendar-choose-${slots[label]}"]`)
  expect(trigger, label).not.toBeNull()
  return trigger!.textContent!.replace(/\D/g, '')
}

export async function openCalendarPeriod(label: Period) {
  const selector = `[data-calendar-view="${views[label]}"]:not([inert])`
  if (!document.querySelector(selector)) {
    const trigger = document.querySelector<HTMLButtonElement>(`[data-calendar-view]:not([inert]) [data-slot="calendar-choose-${slots[label]}"]`)
    expect(trigger, label).not.toBeNull()
    trigger!.click()
    await flushPromises()
  }
  const panel = document.querySelector<HTMLElement>(selector)
  expect(panel, label).not.toBeNull()
  return panel!
}

function periodOptions(panel: HTMLElement, label: Period) {
  return [...panel.querySelectorAll<HTMLButtonElement>(`[data-slot="calendar-${slots[label]}-option"]`)]
}

function optionValue(option: HTMLButtonElement) {
  return option.textContent!.replace(/\D/g, '')
}

export async function chooseCalendarPeriod(label: Period, value: string) {
  const panel = await openCalendarPeriod(label)
  let options = periodOptions(panel, label)
  if (label === '年份') {
    while (!options.some(option => optionValue(option) === value)) {
      const previous = Number(value) < Number(optionValue(options[0]!))
      const arrow = panel.querySelector<HTMLButtonElement>(`[aria-label="${previous ? '上一组年份' : '下一组年份'}"]`)
      expect(arrow?.disabled, `年份 ${value} 应可翻页到达`).toBe(false)
      const before = optionValue(options[0]!)
      arrow!.click()
      await flushPromises()
      options = periodOptions(panel, label)
      expect(optionValue(options[0]!)).not.toBe(before)
    }
  }
  const option = options.find(option => optionValue(option) === value)
  expect(option, `${label} ${value}`).toBeDefined()
  expect(option!.getAttribute('aria-disabled')).not.toBe('true')
  option!.click()
  await flushPromises()
}

export async function calendarYearOptions() {
  const panel = await openCalendarPeriod('年份')
  const values = periodOptions(panel, '年份')
    .filter(option => option.getAttribute('aria-disabled') !== 'true')
    .map(optionValue)
  const back = panel.querySelector<HTMLButtonElement>('[aria-label="返回日历"]')
  expect(back).not.toBeNull()
  back!.click()
  await flushPromises()
  return values
}
