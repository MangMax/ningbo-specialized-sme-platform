// @vitest-environment jsdom
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import PdfPreview from '../../../layers/core/app/components/preview/PdfPreview.vue'

const attempts: unknown[] = []
const Engine = defineComponent({
  name: 'PdfEngine',
  props: ['src'],
  emits: ['ready', 'position', 'error'],
  setup(_, { expose }) {
    expose({ navigate: (position: unknown) => attempts.push(position) })
    return () => h('div', { 'data-engine': '' })
  },
})
function reader(targetPage?: number) {
  attempts.length = 0
  return mount(PdfPreview, { props: { src: '/a.pdf', name: '材料 A.pdf', targetPage }, global: { stubs: { PdfEngine: Engine } } })
}

describe('shared PDF reader public navigation', () => {
  it('queues the newest target until layout ready and reports only the visible page', async () => {
    const wrapper = reader(4)
    await wrapper.setProps({ targetPage: 7 })
    expect(attempts).toEqual([])
    const engine = wrapper.findComponent(Engine)
    expect(engine.exists()).toBe(true)
    engine.vm.$emit('ready', { totalPages: 12 })
    await wrapper.vm.$nextTick()
    expect(attempts).toEqual([{ page: 7 }])
    expect(wrapper.emitted('position-change')).toBeUndefined()
    engine.vm.$emit('position', { page: 7, point: { x: 0, y: 35 } })
    await wrapper.vm.$nextTick()
    expect((wrapper.get('input[aria-label="跳转页码"]').element as HTMLInputElement).value).toBe('7')
    expect(wrapper.emitted('position-change')?.at(-1)).toEqual([{ src: '/a.pdf', page: 7, point: { x: 0, y: 35 } }])
    wrapper.unmount()
  })
})

it('rejects invalid physical pages without moving or reporting success', async () => {
  const wrapper = reader()
  wrapper.findComponent(Engine).vm.$emit('ready', { totalPages: 12 })
  wrapper.findComponent(Engine).vm.$emit('position', { page: 3 })
  await wrapper.vm.$nextTick()
  for (const value of ['', '2.5', '0', '13', '-1', 'abc']) {
    await wrapper.get('input[aria-label="跳转页码"]').setValue(value)
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('1 至 12')
  }
  expect(attempts).toEqual([])
  expect(wrapper.emitted('position-change')).toHaveLength(1)
  await wrapper.get('input[aria-label="跳转页码"]').setValue('12')
  await wrapper.get('form').trigger('submit')
  expect(attempts).toEqual([{ page: 12 }])
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  wrapper.unmount()
})

it('retries the most recent requested position after a loading failure', async () => {
  const wrapper = reader(4)
  let engine = wrapper.findComponent(Engine)
  engine.vm.$emit('ready', { totalPages: 12 })
  await wrapper.vm.$nextTick()
  await wrapper.get('input[aria-label="跳转页码"]').setValue('9')
  await wrapper.get('form').trigger('submit')
  engine.vm.$emit('error', '文件读取失败')
  await wrapper.vm.$nextTick()
  const retry = wrapper.findAll('button').find(b => b.text() === '重试读取 PDF')!
  await retry.trigger('click')
  engine = wrapper.findComponent(Engine)
  engine.vm.$emit('ready', { totalPages: 12 })
  await wrapper.vm.$nextTick()
  expect(attempts.at(-1)).toEqual({ page: 9 })
  wrapper.unmount()
})

it('isolates late events and clears the previous document on replacement', async () => {
  const wrapper = reader(8)
  const old = wrapper.findComponent(Engine)
  old.vm.$emit('ready', { totalPages: 20 })
  old.vm.$emit('position', { page: 8 })
  await wrapper.vm.$nextTick()
  await wrapper.setProps({ src: '/b.pdf', targetPage: 2 })
  old.vm.$emit('ready', { totalPages: 999 })
  old.vm.$emit('position', { page: 19 })
  old.vm.$emit('error', 'stale failure')
  await wrapper.vm.$nextTick()
  expect(wrapper.text()).not.toContain('stale failure')
  expect(wrapper.get('input').attributes('disabled')).toBeDefined()
  const fresh = wrapper.findComponent(Engine)
  fresh.vm.$emit('ready', { totalPages: 3 })
  await wrapper.vm.$nextTick()
  expect(attempts.at(-1)).toEqual({ page: 2 })
  fresh.vm.$emit('position', { page: 2 })
  await wrapper.vm.$nextTick()
  expect(wrapper.emitted('ready')?.at(-1)).toEqual([{ src: '/b.pdf', totalPages: 3 }])
  expect(wrapper.emitted('position-change')?.at(-1)).toEqual([{ src: '/b.pdf', page: 2 }])
  wrapper.unmount()
})

it('does not pull manual reading back to an old initialization target', async () => {
  const wrapper = reader(4)
  const engine = wrapper.findComponent(Engine)
  engine.vm.$emit('ready', { totalPages: 12 })
  await wrapper.vm.$nextTick()
  engine.vm.$emit('position', { page: 4 })
  engine.vm.$emit('position', { page: 6, point: { x: 0, y: 80 } })
  engine.vm.$emit('ready', { totalPages: 12 })
  await wrapper.vm.$nextTick()
  expect(attempts).toEqual([{ page: 4 }])
  expect(wrapper.emitted('position-change')?.at(-1)).toEqual([{ src: '/a.pdf', page: 6, point: { x: 0, y: 80 } }])
  wrapper.unmount()
})

it('keeps primary navigation reachable and leaves editing and Escape keys alone', async () => {
  const wrapper = reader()
  const engine = wrapper.findComponent(Engine)
  const surface = wrapper.get('[data-engine]').element
  engine.vm.$emit('ready', { totalPages: 12 })
  engine.vm.$emit('position', { page: 5 })
  await wrapper.vm.$nextTick()
  const byName = (name: string) => wrapper.get(`button[aria-label="${name}"]`)
  await byName('末页').trigger('click')
  await byName('首页').trigger('click')
  await byName('下一页').trigger('click')
  await byName('上一页').trigger('click')
  expect(attempts).toEqual([{ page: 12 }, { page: 1 }, { page: 6 }, { page: 4 }])
  attempts.length = 0
  await wrapper.get('input').trigger('keydown', { key: 'End' })
  await wrapper.get('section').trigger('keydown', { key: 'Escape' })
  expect(attempts).toEqual([])
  await wrapper.get('section').trigger('keydown', { key: 'End' })
  expect(attempts).toEqual([{ page: 12 }])
  await byName('阅读工具').trigger('click')
  expect(wrapper.get('[data-engine]').element).toBe(surface)
  wrapper.unmount()
})

it('keeps the last visible page explicit while another page is requested', async () => {
  const wrapper = reader()
  const engine = wrapper.findComponent(Engine)
  engine.vm.$emit('ready', { totalPages: 12 })
  engine.vm.$emit('position', { page: 3 })
  await wrapper.vm.$nextTick()
  await wrapper.get('input').setValue('9')
  await wrapper.get('form').trigger('submit')
  expect(wrapper.get('output[aria-label="当前实际页"]').text()).toBe('3 / 12')
  engine.vm.$emit('position', { page: 9 })
  await wrapper.vm.$nextTick()
  expect(wrapper.get('output[aria-label="当前实际页"]').text()).toBe('9 / 12')
  wrapper.unmount()
})

it('ignores late ready and position events after a failed engine is released', async () => {
  const wrapper = reader()
  const engine = wrapper.findComponent(Engine)
  engine.vm.$emit('ready', { totalPages: 12 })
  engine.vm.$emit('position', { page: 3 })
  engine.vm.$emit('error', 'PDF 读取失败')
  await wrapper.vm.$nextTick()
  engine.vm.$emit('ready', { totalPages: 12 })
  engine.vm.$emit('position', { page: 8 })
  await wrapper.vm.$nextTick()
  expect(wrapper.findAll('button').some(b => b.text() === '重试读取 PDF')).toBe(true)
  expect(wrapper.emitted('position-change')).toEqual([[{ src: '/a.pdf', page: 3 }]])
  wrapper.unmount()
})

it('revisits explicit reading locations with anchors without recording scroll or external restores', async () => {
  const wrapper = reader(3)
  const engine = wrapper.findComponent(Engine)
  engine.vm.$emit('ready', { totalPages: 12 })
  await wrapper.vm.$nextTick()
  engine.vm.$emit('position', { page: 3, point: { x: 0, y: 90 } })
  engine.vm.$emit('position', { page: 4, point: { x: 0, y: 60 } })
  await wrapper.vm.$nextTick()
  const back = () => wrapper.get('button[aria-label="阅读位置后退"]')
  const forward = () => wrapper.get('button[aria-label="阅读位置前进"]')
  expect(back().attributes('disabled')).toBeDefined()
  await wrapper.get('input').setValue('9')
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('navigation-request')?.at(-1)).toEqual([{ src: '/a.pdf', page: 9, reason: 'explicit' }])
  expect(back().attributes('disabled')).toBeDefined()
  engine.vm.$emit('position', { page: 9 })
  await wrapper.vm.$nextTick()
  await back().trigger('click')
  expect(attempts.at(-1)).toEqual({ page: 4, point: { x: 0, y: 60 } })
  engine.vm.$emit('position', { page: 4, point: { x: 0, y: 60 } })
  await wrapper.vm.$nextTick()
  await forward().trigger('click')
  expect(attempts.at(-1)).toEqual({ page: 9 })
  engine.vm.$emit('position', { page: 9 })
  await wrapper.vm.$nextTick()
  await wrapper.setProps({ targetPosition: { page: 2 } })
  engine.vm.$emit('position', { page: 2 })
  await wrapper.vm.$nextTick()
  await back().trigger('click')
  expect(attempts.at(-1)).toEqual({ page: 4, point: { x: 0, y: 60 } })
  await wrapper.setProps({ src: '/b.pdf' })
  expect(back().attributes('disabled')).toBeDefined()
  expect(forward().attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
