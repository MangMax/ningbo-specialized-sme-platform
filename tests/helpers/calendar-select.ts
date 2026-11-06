import { flushPromises } from '@vue/test-utils'
import { expect } from 'vitest'

export function calendarSelectValue(label: '年份' | '月份') {
  const trigger = document.querySelector<HTMLButtonElement>(`button[role="combobox"][aria-label="${label}"]`)
  expect(trigger, label).not.toBeNull()
  return trigger!.textContent!.replace(/\D/g, '')
}

async function openCalendarSelect(label: '年份' | '月份') {
  const trigger = document.querySelector<HTMLButtonElement>(`button[role="combobox"][aria-label="${label}"]`)
  expect(trigger, label).not.toBeNull()
  trigger!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }))
  await flushPromises()
  const options = [...document.querySelectorAll<HTMLElement>('[data-slot="select-content"] [role="option"]')]
  expect(options.length).toBeGreaterThan(0)
  return options
}

export async function chooseCalendarSelect(label: '年份' | '月份', value: string) {
  const options = await openCalendarSelect(label)
  const option = options.find(option => option.textContent!.replace(/\D/g, '') === value)
  expect(option, `${label}: ${value}`).toBeDefined()
  option!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await flushPromises()
  expect(calendarSelectValue(label)).toBe(value)
}

export async function calendarYearOptions() {
  const options = await openCalendarSelect('年份')
  const values = options.map(option => option.textContent!.replace(/\D/g, ''))
  document.querySelector<HTMLElement>('[data-slot="select-content"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flushPromises()
  return values
}
