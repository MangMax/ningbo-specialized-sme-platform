// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useEnterpriseCorrespondences } from '../../../composables/useEnterpriseCorrespondences'

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
  expect(fetch).toHaveBeenLastCalledWith('/api/roster/correspondences', { query: { enterpriseId: 1, view: 'summary', page: 2, pageSize: 200 } })
})

it('loads full correspondence points only for an expanded event and preserves all selected edges', async () => {
  const summary = [
    { id: 11, eventId: 7, type: 'event_process', status: 'confirmed', revision: 2, relationId: 31, exportRowId: null, requiresRevalidation: false },
    { id: 12, eventId: 7, type: 'event_process', status: 'candidate', revision: 1, relationId: 32, exportRowId: null, requiresRevalidation: false },
  ]
  const fetch = vi.fn(async (url: string) => url === '/api/roster/correspondences'
    ? { rows: summary, page: 1, pageSize: 200, total: 2 }
    : { ...summary.find(row => url.endsWith(`/${row.id}`)), relation: { nameRaw: '完整原行' } })
  vi.stubGlobal('$fetch', fetch)
  const Expanded = defineComponent({
    setup() { return useEnterpriseCorrespondences(() => 42) },
    template: '<div><span data-testid="state">{{ detailsForEvent(7)?.map(row => row.id).join(",") ?? "pending" }}</span><button @click="loadEvent(7)">展开</button></div>',
  })
  wrapper = mount(Expanded)
  await flushPromises()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences', { query: { enterpriseId: 42, view: 'summary', page: 1, pageSize: 200 } })
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/roster/correspondences', '/api/roster/correspondences/11', '/api/roster/correspondences/12'])
  expect(wrapper.get('[data-testid="state"]').text()).toBe('11,12')
})

it('rejects a late point response from an older revision and retries the current row', async () => {
  const row = (revision: number) => ({ id: 11, eventId: 7, type: 'event_process', status: 'confirmed', revision, relationId: 31, exportRowId: null, requiresRevalidation: revision === 3 })
  let resolveOld!: (value: unknown) => void
  let listRevision = 2
  const fetch = vi.fn((url: string) => url === '/api/roster/correspondences'
    ? Promise.resolve({ rows: [row(listRevision)], page: 1, pageSize: 200, total: 1 })
    : listRevision === 2 ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(row(3)))
  vi.stubGlobal('$fetch', fetch)
  const Expanded = defineComponent({
    setup() { return useEnterpriseCorrespondences(() => 42) },
    template: '<div><span data-testid="revision">{{ detailsForEvent(7)?.[0]?.revision ?? "pending" }}</span><button data-testid="expand" @click="loadEvent(7)">展开</button><button data-testid="refresh" @click="reload">刷新</button></div>',
  })
  wrapper = mount(Expanded)
  await flushPromises()
  await wrapper.get('[data-testid="expand"]').trigger('click')
  listRevision = 3
  await wrapper.get('[data-testid="refresh"]').trigger('click')
  await flushPromises()
  await wrapper.get('[data-testid="expand"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-testid="revision"]').text()).toBe('3')
  resolveOld(row(2))
  await flushPromises()
  expect(wrapper.get('[data-testid="revision"]').text()).toBe('3')
})

it('keeps a failed expanded source unknown and retries its exact point', async () => {
  const summary = { id: 5, eventId: 9, type: 'event_process', status: 'candidate', revision: 1, relationId: 33, exportRowId: null, requiresRevalidation: false }
  const fetch = vi.fn().mockResolvedValueOnce({ rows: [summary], page: 1, pageSize: 200, total: 1 })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ rows: [summary], page: 1, pageSize: 200, total: 1 })
    .mockResolvedValueOnce({ ...summary, relation: { id: 33, nameRaw: '完整原行' } })
  vi.stubGlobal('$fetch', fetch)
  const Expanded = defineComponent({
    setup() { return useEnterpriseCorrespondences(() => 42) },
    template: '<div><span data-testid="detail">{{ detailsForEvent(9)?.[0]?.relation?.nameRaw ?? "unknown" }}</span><span data-testid="error">{{ detailErrorForEvent(9) }}</span><button data-testid="expand" @click="loadEvent(9)">展开</button><button data-testid="retry" @click="loadEvent(9, true)">重试</button></div>',
  })
  wrapper = mount(Expanded)
  await flushPromises()
  await wrapper.get('[data-testid="expand"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-testid="detail"]').text()).toBe('unknown')
  expect(wrapper.get('[data-testid="error"]').text()).toBe('true')
  await wrapper.get('[data-testid="retry"]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/roster/correspondences', '/api/roster/correspondences/5', '/api/roster/correspondences', '/api/roster/correspondences/5'])
  expect(wrapper.get('[data-testid="detail"]').text()).toBe('完整原行')
  expect(wrapper.get('[data-testid="error"]').text()).toBe('false')
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

it('reconciles revision two with revision three and a new current edge before an explicit evidence retry', async () => {
  const old = { id: 11, eventId: 7, type: 'event_process', status: 'confirmed', revision: 2, relationId: 31, exportRowId: null, requiresRevalidation: false }
  const current = { ...old, revision: 3, status: 'unlinked' }
  const newEdge = { ...old, id: 12, revision: 1, type: 'event_recognized', role: 'current_context', relationId: 32 }
  let listCalls = 0
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/roster/correspondences') return { rows: ++listCalls === 1 ? [old] : [current, newEdge], total: listCalls === 1 ? 1 : 2, page: 1, pageSize: 200 }
    return { ...(url.endsWith('/11') ? current : newEdge), relation: { nameRaw: url.endsWith('/11') ? '旧出处已解除' : '新当前参考' } }
  })
  vi.stubGlobal('$fetch', fetch)
  const Expanded = defineComponent({
    setup() { return useEnterpriseCorrespondences(() => 42) },
    template: '<div><span data-testid="detail">{{ detailsForEvent(7)?.map(row => `${row.id}:${row.revision}:${row.relation?.nameRaw}`).join(",") ?? "unknown" }}</span><span data-testid="error">{{ detailErrorForEvent(7) }}</span><button data-testid="expand" @click="loadEvent(7)">展开</button><button data-testid="retry" @click="loadEvent(7, true)">重试出处</button></div>',
  })
  wrapper = mount(Expanded)
  await flushPromises()
  await wrapper.get('[data-testid="expand"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-testid="detail"]').text()).toBe('unknown')
  expect(wrapper.get('[data-testid="error"]').text()).toBe('true')
  expect(listCalls).toBe(1) // drift stays explicit; no automatic retry loop
  await wrapper.get('[data-testid="retry"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-testid="detail"]').text()).toBe('11:3:旧出处已解除,12:1:新当前参考')
  expect(wrapper.get('[data-testid="error"]').text()).toBe('false')
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/roster/correspondences', '/api/roster/correspondences/11', '/api/roster/correspondences', '/api/roster/correspondences/11', '/api/roster/correspondences/12'])
})


it('retains unknown evidence and the last complete summary when an explicit retry cannot refresh all pages', async () => {
  const old = { id: 11, eventId: 7, type: 'event_process', status: 'confirmed', revision: 2, relationId: 31, exportRowId: null, requiresRevalidation: false }
  let listCalls = 0
  const fetch = vi.fn(async (url: string) => {
    if (url !== '/api/roster/correspondences') return { ...old, revision: 3 }
    if (++listCalls === 1) return { rows: [old], total: 1, page: 1, pageSize: 200 }
    if (listCalls === 2) return { rows: Array.from({ length: 200 }, (_, i) => ({ ...old, id: i + 11, revision: 3 })), total: 201, page: 1, pageSize: 200 }
    throw new Error('second summary page offline')
  })
  vi.stubGlobal('$fetch', fetch)
  const Expanded = defineComponent({
    setup() { return useEnterpriseCorrespondences(() => 42) },
    template: '<div><span data-testid="detail">{{ detailsForEvent(7) === null ? "unknown" : "known" }}</span><span data-testid="rows">{{ rows.map(row => `${row.id}:${row.revision}`).join(",") }}</span><span data-testid="error">{{ detailErrorForEvent(7) }}</span><button data-testid="expand" @click="loadEvent(7)">展开</button><button data-testid="retry" @click="loadEvent(7, true)">重试</button></div>',
  })
  wrapper = mount(Expanded)
  await flushPromises()
  await wrapper.get('[data-testid="expand"]').trigger('click')
  await flushPromises()
  await wrapper.get('[data-testid="retry"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-testid="detail"]').text()).toBe('unknown')
  expect(wrapper.get('[data-testid="error"]').text()).toBe('true')
  expect(wrapper.get('[data-testid="rows"]').text()).toBe('11:2')
  expect(fetch.mock.calls.filter(call => call[0].endsWith('/11'))).toHaveLength(1)
  expect(listCalls).toBe(3)
})
