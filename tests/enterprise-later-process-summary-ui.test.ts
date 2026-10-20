// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import EnterpriseLaterProcesses from '../components/record-correspondence/EnterpriseLaterProcesses.vue'

const rows = [
  { id: 10, type: 'later_process', role: 'followup_update', status: 'confirmed', revision: 2, requiresRevalidation: true, eventId: null, predecessorEventId: 7, relationId: 31, exportRowId: null, enterpriseId: 42, titleCode: 'specialized_sme' },
  { id: 11, type: 'later_process', role: 'followup_review', status: 'candidate', revision: 1, requiresRevalidation: false, eventId: null, predecessorEventId: 8, relationId: null, exportRowId: 51, enterpriseId: 42, titleCode: 'specialized_sme' },
]
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount(); vi.unstubAllGlobals() })

it('requests summary for later processes and retains both relationship states and event links', async () => {
  const fetch = vi.fn(async () => ({ rows, total: 2, page: 1, pageSize: 25 }))
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(EnterpriseLaterProcesses, { props: { enterpriseId: 42, returnTo: '/comparison?mode=record' }, global: { stubs: {
    NuxtLink: { props: ['to'], template: '<a :href="to.path"><slot /></a>' },
    SourceReader: true,
    Dialog: { template: '<div><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' }, DialogHeader: true, DialogTitle: true, DialogDescription: true,
  } } })
  mounted.push(wrapper)
  await flushPromises()
  expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences', { query: { enterpriseId: 42, type: 'later_process', view: 'summary', page: 1, pageSize: 25 } })
  expect(wrapper.findAll('[data-correspondence-id]').map(item => item.attributes('data-correspondence-id'))).toEqual(['10', '11'])
  expect(wrapper.text()).toContain('待重新核验')
  expect(wrapper.text()).toContain('候选 · 待确认')
  expect(wrapper.findAll('a').map(link => link.attributes('href'))).toEqual(['/enterprises/42', '/enterprises/42'])
  expect(wrapper.text()).not.toContain('未提供')
})

it('opens the full source only when the evidence action is selected', async () => {
  const fetch = vi.fn(async () => ({ rows, total: 2, page: 1, pageSize: 25 }))
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(EnterpriseLaterProcesses, { props: { enterpriseId: 42 }, global: { stubs: {
    NuxtLink: true,
    SourceReader: { name: 'SourceReader', props: ['kind', 'id'], template: '<div data-testid="full-source">{{ kind }}:{{ id }}</div>' },
    Dialog: { template: '<div><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' }, DialogHeader: true, DialogTitle: true, DialogDescription: true,
  } } })
  mounted.push(wrapper)
  await flushPromises()
  expect(wrapper.find('[data-testid="full-source"]').exists()).toBe(false)
  const actions = wrapper.findAll('button').filter(button => button.text().includes('查看原始记录'))
  expect(actions).toHaveLength(2)
  await actions[0]!.trigger('click')
  expect(wrapper.get('[data-testid="full-source"]').text()).toBe('relation:31')
  await actions[1]!.trigger('click')
  expect(wrapper.get('[data-testid="full-source"]').text()).toBe('export_row:51')
  expect(fetch).toHaveBeenCalledTimes(1)
})
