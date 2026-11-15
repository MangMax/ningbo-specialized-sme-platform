// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, onMounted, ref } from 'vue'
import { afterEach, expect, it } from 'vitest'
import DisclosurePanel from '../../../components/DisclosurePanel.vue'

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

it('keeps the accessible trigger and controlled disclosure state in sync', async () => {
  const open = ref(false)
  const host = defineComponent({
    components: { DisclosurePanel },
    setup: () => ({ open }),
    template: '<DisclosurePanel v-model:open="open"><template #title>查询条件</template><p>本次查询内容</p></DisclosurePanel>',
  })
  const wrapper = mount(host)
  mounted.push(wrapper)
  const trigger = wrapper.get('button')
  expect(trigger.text()).toContain('查询条件')
  expect(trigger.attributes('aria-expanded')).toBe('false')
  await trigger.trigger('click')
  await flushPromises()
  expect(open.value).toBe(true)
  expect(trigger.attributes('aria-expanded')).toBe('true')
  const region = wrapper.get(`[id="${trigger.attributes('aria-controls')}"]`)
  expect(region.attributes('role')).toBe('region')
  expect(region.attributes('aria-labelledby')).toBe(trigger.attributes('id'))
  expect(region.text()).toContain('本次查询内容')
  open.value = false
  await flushPromises()
  expect(trigger.attributes('aria-expanded')).toBe('false')
})

it('initializes retained controls once and preserves unsaved input across closing and reopening', async () => {
  let initializations = 0
  const Probe = defineComponent({
    setup() {
      const value = ref('')
      onMounted(() => { initializations++ })
      return () => h('input', { 'aria-label': '尚未提交的条件', value: value.value, onInput: (event: Event) => { value.value = (event.target as HTMLInputElement).value } })
    },
  })
  const wrapper = mount(DisclosurePanel, { props: { keepMounted: true }, slots: { title: '修改来源', default: () => h(Probe) } })
  mounted.push(wrapper)
  await flushPromises()
  expect(initializations).toBe(1)
  expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
  await wrapper.get('button').trigger('click')
  await wrapper.get('input').setValue('2024')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
  expect(wrapper.get('input').element.value).toBe('2024')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.get('input').element.value).toBe('2024')
  expect(initializations).toBe(1)
})

it('page-level panels can add their own heading level without losing the accessible trigger', async () => {
  const open = ref(false)
  const host = defineComponent({
    components: { DisclosurePanel },
    setup: () => ({ open }),
    template: '<DisclosurePanel v-model:open="open" :heading-level="2" title="管理操作授权"><p>正文</p></DisclosurePanel>',
  })
  const wrapper = mount(host)
  mounted.push(wrapper)
  const trigger = wrapper.get('button')
  expect(trigger.text()).toContain('管理操作授权')
  // Level 2 is the heading that **contains** the trigger: the official
  // AccordionHeader carries the level, and the trigger keeps its own button
  // semantics, aria-expanded and id/aria-controls wiring.
  const heading = wrapper.get('h2')
  expect(heading.element.contains(trigger.element)).toBe(true)
  expect(heading.text()).toBe('管理操作授权')
  // A heading inside the button would nest one heading in another.
  expect(trigger.findAll('h1, h2, h3, h4')).toHaveLength(0)
  expect(trigger.attributes('aria-expanded')).toBe('false')
  await trigger.trigger('click')
  await flushPromises()
  expect(trigger.attributes('aria-expanded')).toBe('true')
  expect(wrapper.get(`[id="${trigger.attributes('aria-controls')}"]`).text()).toContain('正文')
})

it('keeps the default heading level at h3, with the trigger inside it', () => {
  const wrapper = mount(DisclosurePanel, { props: { title: '核对信息' }, slots: { default: () => h('p', '正文') } })
  mounted.push(wrapper)
  const trigger = wrapper.get('button')
  const heading = wrapper.get('h3')
  expect(heading.element.contains(trigger.element)).toBe(true)
  expect(heading.text()).toBe('核对信息')
  expect(trigger.findAll('h1, h2, h3, h4')).toHaveLength(0)
})

it('the heading level also applies when the trigger comes from the trigger slot', () => {
  const wrapper = mount(DisclosurePanel, { props: { headingLevel: 2 }, slots: { trigger: () => h('span', '发起新的名录导出') } })
  mounted.push(wrapper)
  const trigger = wrapper.get('button')
  expect(wrapper.get('h2').element.contains(trigger.element)).toBe(true)
  expect(trigger.findAll('h1, h2, h3, h4')).toHaveLength(0)
})

it('keeps shared disclosure focus and chevron feedback without hover underlining across compact controlled and retained uses', async () => {
  for (const props of [{ compact: true }, { open: false, headingLevel: 2 as const }, { keepMounted: true }]) {
    const wrapper = mount(DisclosurePanel, { props: { ...props, title: '来源与记录' }, slots: { default: () => h('p', '完整内容') } })
    mounted.push(wrapper)
    const trigger = wrapper.get('button')
    expect(trigger.classes()).not.toContain('hover:underline')
    expect(trigger.classes()).toContain('focus-visible:ring-3')
    expect(trigger.find('svg').exists()).toBe(true)
    expect(trigger.classes()).toContain('[&[data-state=open]>svg]:rotate-180')
    await trigger.trigger('click'); await flushPromises()
    expect(wrapper.emitted('update:open')).toEqual([[true]])
  }
})
