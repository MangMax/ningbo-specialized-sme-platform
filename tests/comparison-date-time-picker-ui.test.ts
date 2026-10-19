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
    view.findComponent(TimeFieldRoot).vm.$emit('update:modelValue', undefined)
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
