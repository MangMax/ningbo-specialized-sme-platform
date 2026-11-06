// @vitest-environment happy-dom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it } from 'vitest'
import CurrentRecognitionDatePicker from '../components/CurrentRecognitionDatePicker.vue'

let view: ReturnType<typeof mount>
afterEach(() => { view?.unmount(); document.body.innerHTML = '' })
async function open(value = '2024-01-31', label = '认定时间起') {
  view = mount(CurrentRecognitionDatePicker, { props: { id: 'date', label, modelValue: value }, attachTo: document.body })
  await view.get('#date').trigger('click'); await flushPromises()
}
const select = (name: string) => new DOMWrapper(document.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!)
async function navigate(year: string, month: string) {
  await select('年份').setValue(year); await select('月份').setValue(month); await flushPromises()
}
it.each(['认定时间起', '认定时间止'])('%s navigates real controls to leap day and commits only the clicked day', async label => {
  await open('2026-01-31', label)
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
  expect((select('年份').element as HTMLSelectElement).value).toBe('2024')
  expect((select('月份').element as HTMLSelectElement).value).toBe('1')
})
it('opens empty at today without filling a value and handles non-leap month ends', async () => {
  await open('')
  expect((select('年份').element as HTMLSelectElement).value).toBe(String(new Date().getFullYear()))
  expect((select('月份').element as HTMLSelectElement).value).toBe(String(new Date().getMonth() + 1))
  expect(view.emitted('update:modelValue')).toBeUndefined()
  await navigate('2023', '2')
  expect(document.querySelector('[data-value="2023-02-29"]')).toBeNull()
  document.querySelector<HTMLElement>('[data-value="2023-02-28"]')!.click()
  await flushPromises()
  expect(view.emitted('update:modelValue')).toEqual([['2023-02-28']])
})
it('preserves an existing year outside the default range and keeps month arrows', async () => {
  await open('1900-12-31')
  expect((select('年份').element as HTMLSelectElement).value).toBe('1900')
  const next = document.querySelector<HTMLButtonElement>('[data-slot="calendar-next-button"]')!
  next.click(); await flushPromises()
  expect((select('年份').element as HTMLSelectElement).value).toBe('1901')
  expect((select('月份').element as HTMLSelectElement).value).toBe('1')
  expect(view.emitted('update:modelValue')).toBeUndefined()
})
