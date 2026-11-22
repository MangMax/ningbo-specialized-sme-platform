// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import PlatformQueryEvidence from '../../../layers/sme-roster/app/components/PlatformQueryEvidence.vue'

const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.unstubAllGlobals()
})

const row = {
  query: { id: 7, interface: 'business_list', relationCount: 1 },
  relations: [{ id: 71, queryId: 7, sequenceNo: 2, nameRaw: '测试企业', sourcePage: 3, status: '终审通过', rawFields: { unknown: '离线字段' } }],
}

it('requests extracted records only after disclosure and reuses the successful result', async () => {
  const fetch = vi.fn().mockResolvedValue({ rows: [row] })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(PlatformQueryEvidence, { props: { queryId: 7 } })
  wrappers.push(wrapper)
  expect(fetch).not.toHaveBeenCalled()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/platform/queries', expect.objectContaining({ query: { queryId: 7, view: 'full' } }))
  expect(wrapper.text()).toContain('测试企业')
  expect(wrapper.text()).toContain('记录 #71 · 原行 2 · 来源页 3')
  expect(wrapper.text()).toContain('终审通过')
  expect(wrapper.text()).not.toContain('离线字段')
  await wrapper.get('button').trigger('click')
  await wrapper.get('button').trigger('click')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('keeps a mismatched query hidden and retries the selected query by ID', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce({ rows: [{ ...row, query: { ...row.query, id: 8 } }] })
    .mockResolvedValueOnce({ rows: [row] })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(PlatformQueryEvidence, { props: { queryId: 7 } })
  wrappers.push(wrapper)
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('查询记录加载失败')
  expect(wrapper.text()).not.toContain('测试企业')
  await wrapper.get('[data-testid="table-retry"]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls.map(([, request]) => request.query.queryId)).toEqual([7, 7])
  expect(wrapper.text()).toContain('测试企业')
})
