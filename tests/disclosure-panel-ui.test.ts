// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, onMounted, ref } from 'vue'
import { afterEach, expect, it } from 'vitest'
import DisclosurePanel from '../components/DisclosurePanel.vue'

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
