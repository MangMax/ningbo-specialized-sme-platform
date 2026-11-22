// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import { createMemoryHistory, createRouter, RouterLink } from 'vue-router'
import DictionaryDirectory from '../../../app/components/DictionaryDirectory.vue'

it('finds and opens a dictionary beyond the first screen of a long catalog', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/dictionaries', component: { template: '<div />' } }],
  })
  await router.push('/dictionaries?kind=dictionary-1')

  const directory = mount(DictionaryDirectory, {
    props: {
      active: 'dictionary-1',
      modelValue: '',
      'onUpdate:modelValue': value => directory.setProps({ modelValue: value }),
      groups: [
        { label: '业务字典', items: Array.from({ length: 40 }, (_, index) => ({
          id: `dictionary-${index + 1}`,
          label: `业务字典 ${index + 1}`,
        })) },
        { label: '标准字典', items: [{ id: 'industries', label: '行业分类' }] },
      ],
    },
    global: { plugins: [router], components: { NuxtLink: RouterLink } },
  })

  try {
    expect(directory.get('[aria-current="page"]').text()).toBe('业务字典 1')
    expect(directory.findAll('nav a')).toHaveLength(41)
    const search = directory.get('input[aria-label="搜索字典"]')
    await search.setValue('业务字典 ４０')
    await flushPromises()
    expect(directory.findAll('nav a')).toHaveLength(1)
    const match = directory.get('nav a')
    expect(match.text()).toBe('业务字典 40')
    await match.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.kind).toBe('dictionary-40')

    await search.setValue('无此字典')
    await flushPromises()
    expect(directory.get('[role="status"]').text()).toBe('没有匹配的字典')
  } finally {
    directory.unmount()
  }
})
