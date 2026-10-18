// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useEnterpriseCorrespondences } from '../composables/useEnterpriseCorrespondences'

const Harness = defineComponent({
  props: { id: { type: Number, default: null } },
  setup(props) { return useEnterpriseCorrespondences(() => props.id) },
  template: '<div><span data-testid="loading">{{ loading }}</span><span data-testid="error">{{ error }}</span><span data-testid="rows">{{ rows.map(row => row.id).join(",") }}</span><button @click="reload">重试</button></div>',
})
let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })

it('reads every correspondence page instead of silently truncating after twenty pages', async () => {
  const fetch = vi.fn(async (_url: string, { query }: { query: { page: number; pageSize: number } }) => ({
    rows: Array.from({ length: Math.min(200, 4001 - (query.page - 1) * 200) }, (_, index) => ({ id: (query.page - 1) * 200 + index + 1 })),
    total: 4001, ...query,
  }))
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(Harness, { props: { id: 1 } })
  await flushPromises()
  expect(fetch).toHaveBeenCalledTimes(21)
  expect(wrapper.get('[data-testid="rows"]').text().split(',')).toHaveLength(4001)
  expect(wrapper.get('[data-testid="rows"]').text()).toMatch(/,4001$/)
  expect(wrapper.get('[data-testid="error"]').text()).toBe('false')
})

it('retains the last complete result when pagination cannot prove the new result complete', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ rows: [{ id: 999 }], page: 1, pageSize: 200, total: 1 })
    .mockResolvedValueOnce({ rows: Array.from({ length: 200 }, (_, index) => ({ id: index + 1 })), page: 1, pageSize: 200, total: 201 })
    .mockResolvedValueOnce({ rows: [{ id: 201 }], page: 1, pageSize: 200, total: 201 })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(Harness, { props: { id: 1 } })
  await flushPromises()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-testid="error"]').text()).toBe('true')
  expect(wrapper.get('[data-testid="rows"]').text()).toBe('999')
  expect(fetch).toHaveBeenLastCalledWith('/api/roster/correspondences', { query: { enterpriseId: 1, page: 2, pageSize: 200 } })
})

it('invalidates pending rows when the enterprise changes or is cleared', async () => {
  let old!: (value: unknown) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { old = resolve }))
    .mockResolvedValue({ rows: [{ id: 202 }], page: 1, pageSize: 200, total: 1 })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(Harness, { props: { id: 1 } })
  await wrapper.setProps({ id: null })
  old({ rows: [{ id: 101 }], page: 1, pageSize: 200, total: 1 })
  await flushPromises()
  expect(wrapper.get('[data-testid="rows"]').text()).toBe('')
  expect(wrapper.get('[data-testid="loading"]').text()).toBe('false')
  await wrapper.setProps({ id: 2 })
  await flushPromises()
  expect(wrapper.get('[data-testid="rows"]').text()).toBe('202')
})
