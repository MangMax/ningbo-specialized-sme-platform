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
    if (url === '/api/task-center') return { authorized: true }
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
  return { wrapper, router, click: () => wrapper.get('button[aria-describedby]').trigger('click') }
}
async function regeneration() {
  const wrapper = mount(defineComponent({ setup() {
    const { submitExport } = useCurrentRosterExport(ref(''))
    const result = ref('')
    return () => h('div', [h(Button, { onClick: async () => {
      const receipt = await submitExport('specialized_sme', OLD_SME)
      result.value = receipt && ('jobId' in receipt ? receipt.jobId : receipt.error) || ''
    } }, () => '重新生成'), h('p', { role: 'status' }, result.value)])
  } }))
  mounted.push(wrapper); await flushPromises()
  return { wrapper, click: () => wrapper.get('button').trigger('click') }
}

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

it.each(['unmounted', 'left page', 'changed title', 'changed title and returned'] as const)('late query acceptance retains recovery without navigation after %s', async change => {
  const receipt = deferred()
  mockFetch(() => receipt.promise)
  const query = await queryEntry()
  await query.click()
  if (change === 'unmounted') query.wrapper.unmount()
  if (change === 'left page') await query.router.push('/tasks?job=chosen')
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
