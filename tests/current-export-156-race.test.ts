// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { createRouter, createMemoryHistory, RouterLink } from 'vue-router'
import Entry from '../components/CurrentRosterExportEntry.vue'
import { Button } from '../components/ui/button'
import { useCurrentRosterExport } from '../composables/useCurrentRosterExport'
import { TASK_EXPORTS } from '../lib/task-center'

const KEY = 'task-center-export-requests-v1'
const LG_JOB = '01M5BEPVCXD5619ZW4C6CATRET'
const OLD_SME = '01M5BEPVCXD5619ZW4C6CATREV'
const SME_JOB = '01M5BEPVCXD5619ZW4C6CATREW'
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => {
  mounted.splice(0).forEach(w => w.unmount())
  vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear()
})
function deferred() {
  let resolve!: (value: any) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function mockFetch(post: (url: string, init: any) => Promise<any>) {
  const raw = vi.fn(post)
  vi.stubGlobal('$fetch', Object.assign(async (url: string) => {
    if (url.endsWith('/capabilities')) return { exports: TASK_EXPORTS.map(t => ({ ...t, ready: true })) }
    throw new Error('Unexpected read ' + url)
  }, { raw }))
  return raw
}
async function queryEntry() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/current-enterprises', component: { template: '<div />' } },
    { path: '/tasks', component: { template: '<div />' } },
  ] })
  await router.push('/current-enterprises?titleCode=little_giant')
  ;(globalThis as any).__routerBridge = { current: router }
  const wrapper = mount(Entry, { props: { titleCode: 'little_giant' }, global: { plugins: [router], components: { NuxtLink: RouterLink } } })
  mounted.push(wrapper); await flushPromises()
  return { wrapper, router, click: () => wrapper.get('button[aria-label^="导出当前称号名单："]').trigger('click') }
}
async function regeneration() {
  const wrapper = mount(defineComponent({ setup() {
    const { submitExport } = useCurrentRosterExport()
    const result = ref('')
    return () => h('div', [h(Button, { onClick: async () => {
      const receipt = await submitExport('specialized_sme', OLD_SME)
      result.value = receipt && ('jobId' in receipt ? receipt.jobId : receipt.error) || ''
    } }, () => '重新生成'), h('p', { role: 'status' }, result.value)])
  } }))
  mounted.push(wrapper); await flushPromises()
  return { wrapper, click: () => wrapper.get('button').trigger('click') }
}

it('an optional lifecycle reason blocks submission until the current read completes', async () => {
  const raw = mockFetch(async () => ({ status: 202, _data: { jobId: SME_JOB } }))
  const reason = ref('正在读取当前筛选，读完即可操作。')
  const wrapper = mount(defineComponent({ setup() {
    const { submitExport, disabledReason } = useCurrentRosterExport(reason)
    return () => h('div', [h(Button, { onClick: () => submitExport('specialized_sme', OLD_SME) }, () => '重新生成'), h('p', disabledReason('specialized_sme'))])
  } }))
  mounted.push(wrapper); await flushPromises()
  expect(wrapper.get('p').text()).toBe(reason.value)
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(raw).not.toHaveBeenCalled()
  reason.value = ''; await flushPromises()
  expect(wrapper.get('p').text()).toBe('')
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(raw).toHaveBeenCalledTimes(1)
  expect(raw.mock.calls[0]![1].body).toMatchObject({ regenerateOf: OLD_SME })
})

it('delayed initial 202 preserves a newer mounted task regeneration identity through lost receipt and remount', async () => {
  const lg = deferred(), sme = deferred()
  const raw = mockFetch(url => url.endsWith('/little-giant') ? lg.promise : sme.promise)
  const query = await queryEntry()
  await query.click(); query.wrapper.unmount()
  await query.router.push('/tasks?job=user-selected')
  const tasks = await regeneration()
  await tasks.click()
  const identity = raw.mock.calls[1]![1].body.clientRequestId
  lg.resolve({ status: 202, _data: { jobId: LG_JOB } }); await flushPromises()
  expect(JSON.parse(sessionStorage.getItem(KEY)!)[`specialized_sme:${OLD_SME}`]).toEqual({ clientRequestId: identity })
  expect(query.router.currentRoute.value.fullPath).toBe('/tasks?job=user-selected')
  tasks.wrapper.unmount(); sme.reject(new Error('lost regeneration receipt')); await flushPromises()
  raw.mockResolvedValue({ status: 202, _data: { jobId: SME_JOB } })
  const recovered = await regeneration(); await recovered.click(); await flushPromises()
  expect(raw.mock.calls[2]![1].body).toEqual({ clientRequestId: identity, regenerateOf: OLD_SME })
  expect(recovered.wrapper.get('[role="status"]').text()).toBe(SME_JOB)
})

it.each(['unmounted', 'left page', 'left page and returned', 'changed title', 'changed title and returned', 'route title changed and returned before prop render'] as const)('late query acceptance retains recovery without navigation after %s', async change => {
  const receipt = deferred()
  mockFetch(() => receipt.promise)
  const query = await queryEntry()
  await query.click()
  if (change === 'unmounted') query.wrapper.unmount()
  if (change.startsWith('left page')) {
    await query.router.push('/tasks?job=chosen')
    if (change === 'left page and returned') await query.router.push('/current-enterprises?titleCode=little_giant')
  }
  if (change === 'route title changed and returned before prop render') {
    // The mounted entry still has its original prop: route invalidation must
    // independently remember the intervening effective title.
    await query.router.push('/current-enterprises?titleCode=specialized_sme')
    await query.router.push('/current-enterprises?titleCode=little_giant')
    expect(query.wrapper.props('titleCode')).toBe('little_giant')
  }
  if (change.startsWith('changed title')) {
    await query.wrapper.setProps({ titleCode: 'specialized_sme' })
    if (change === 'changed title and returned') await query.wrapper.setProps({ titleCode: 'little_giant' })
  }
  const destination = query.router.currentRoute.value.fullPath
  receipt.resolve({ status: 202, _data: { jobId: LG_JOB } }); await flushPromises()
  expect(query.router.currentRoute.value.fullPath).toBe(destination)
  const recovery = await queryEntry()
  expect(recovery.wrapper.findAll('a').find(a => a.text() === '查看本次导出')?.attributes('href')).toContain(LG_JOB)
})

it.each(['q', 'district'] as const)('pending export failure shows recovery notice after same-title %s change', async filter => {
  const receipt = deferred()
  mockFetch(() => receipt.promise)
  const query = await queryEntry()
  await query.click()
  await query.router.push({ path: '/current-enterprises', query: { titleCode: 'little_giant', [filter]: filter === 'q' ? '宁波' : '鄞州区' } })
  receipt.reject(new Error('lost export receipt')); await flushPromises()
  expect(query.wrapper.get('[role="alert"]').text()).toContain('提交尚未确认')
  expect(query.wrapper.get('[role="alert"]').text()).toContain('请求标识已保留，重提沿用同一标识')
  expect(query.wrapper.get('button[aria-label^="导出当前称号名单："]').attributes('disabled')).toBeUndefined()
  expect(query.router.currentRoute.value.path).toBe('/current-enterprises')
})

it.each(['q', 'district'] as const)('pending export acceptance navigates to its task after same-title %s change', async filter => {
  const receipt = deferred()
  const raw = mockFetch(() => receipt.promise)
  const query = await queryEntry()
  await query.click()
  await query.router.push({ path: '/current-enterprises', query: { titleCode: 'little_giant', [filter]: filter === 'q' ? '宁波' : '鄞州区' } })
  receipt.resolve({ status: 202, _data: { jobId: LG_JOB } }); await flushPromises()
  expect(query.router.currentRoute.value.path).toBe('/tasks')
  expect(query.router.currentRoute.value.query).toEqual({ tab: 'export', titleCode: 'little_giant', page: '1', job: LG_JOB })
  expect(raw).toHaveBeenCalledTimes(1)
  expect(raw.mock.calls[0]![0]).toBe('/api/roster/exports/current/little-giant')
  expect(raw.mock.calls[0]![1].body).toEqual({ clientRequestId: expect.any(String) })
})

it('accepted regeneration keeps its UUID when forget persistence fails and retry does not create a second request', async () => {
  const receipt = deferred()
  const raw = mockFetch(() => receipt.promise)
  const tasks = await regeneration()
  await tasks.click()
  const original = raw.mock.calls[0]![1].body
  const storage = sessionStorage
  vi.stubGlobal('sessionStorage', {
    getItem: storage.getItem.bind(storage),
    setItem: () => { throw new Error('quota during forget') },
  })
  receipt.resolve({ status: 202, _data: { jobId: SME_JOB } }); await flushPromises()
  expect(tasks.wrapper.get('[role="status"]').text()).toBe(SME_JOB)
  expect(tasks.wrapper.text()).not.toContain('没有拿到完整的 202')
  vi.stubGlobal('sessionStorage', storage)
  raw.mockResolvedValue({ status: 202, _data: { jobId: SME_JOB } })
  await tasks.click(); await flushPromises()
  expect(raw.mock.calls[1]![1].body).toEqual(original)
  expect(JSON.parse(storage.getItem(KEY)!)[`specialized_sme:${OLD_SME}`]).toBeUndefined()
  // Successful cleanup still permits an explicitly new regeneration afterwards.
  await tasks.click(); await flushPromises()
  expect(raw.mock.calls[2]![1].body.clientRequestId).not.toBe(original.clientRequestId)
})

it('unreadable storage fails closed before POST even if writing would succeed', async () => {
  const raw = mockFetch(async () => ({ status: 202, _data: { jobId: LG_JOB } }))
  const query = await queryEntry()
  const setItem = vi.fn()
  vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('read unavailable') }, setItem })
  await query.click(); await flushPromises()
  expect(raw).not.toHaveBeenCalled()
  expect(setItem).not.toHaveBeenCalled()
  expect(query.wrapper.get('[role="alert"]').text()).toContain('本次未发送')
})

it('a mounted stale task instance reuses the latest same-key UUID and its late forget preserves the next regeneration', async () => {
  const first = deferred(), second = deferred(), next = deferred()
  const raw = mockFetch(() => first.promise)
  // Both logs exist before either submits, as on overlapping page transitions.
  const stale = await regeneration(), current = await regeneration()
  await current.click()
  raw.mockImplementationOnce(() => second.promise)
  await stale.click()
  const original = raw.mock.calls[0]![1].body.clientRequestId
  expect(raw.mock.calls[1]![1].body.clientRequestId).toBe(original)
  second.resolve({ status: 202, _data: { jobId: SME_JOB } }); await flushPromises()
  raw.mockImplementationOnce(() => next.promise)
  await stale.click()
  const latest = raw.mock.calls[2]![1].body.clientRequestId
  expect(latest).not.toBe(original)
  first.resolve({ status: 202, _data: { jobId: SME_JOB } }); await flushPromises()
  expect(JSON.parse(sessionStorage.getItem(KEY)!)[`specialized_sme:${OLD_SME}`]).toEqual({ clientRequestId: latest })
  next.reject(new Error('lost newer receipt')); await flushPromises()
  const recovered = await regeneration()
  raw.mockResolvedValue({ status: 202, _data: { jobId: SME_JOB } })
  await recovered.click(); await flushPromises()
  expect(raw.mock.calls[3]![1].body.clientRequestId).toBe(latest)
})
