// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createRouter, createMemoryHistory, RouterLink } from 'vue-router'
import Page from '../../../pages/current-enterprises.vue'
import { TASK_EXPORTS } from '../../../lib/task-center'
import { Select } from '../../../components/ui/select'

const JOB = '01M5BEPVCXD5619ZW4C6CATRET'
const KEY = 'task-center-export-requests-v1'
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(w => w.unmount()); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function setup(options: { title?: string; defaultUrl?: boolean; capability?: 'failed' | 'missing'; post?: () => Promise<unknown> } = {}) {
  const calls: { url: string; options: any }[] = []
  const fetcher = Object.assign(async (url: string, init: any = {}) => {
    calls.push({ url, options: init })
    if (url.endsWith('/capabilities')) {
      if (options.capability === 'failed') throw new Error('offline')
      return { exports: options.capability === 'missing' ? [] : TASK_EXPORTS.map(t => ({ ...t, ready: true })) }
    }
    if (url === '/api/roster/current-enterprises') return { rows: [], total: 0, page: 3, pageSize: 25 }
    throw new Error('Unexpected read ' + url)
  }, { raw: vi.fn(async (url: string, init: any) => {
    calls.push({ url, options: init })
    // The intent must be durable before the public POST is attempted.
    expect(JSON.parse(sessionStorage.getItem(KEY)!)[`${options.title ?? 'little_giant'}:initial`].clientRequestId).toBe(init.body.clientRequestId)
    return options.post ? options.post() : { status: 202, _data: { jobId: JOB } }
  }) })
  vi.stubGlobal('$fetch', fetcher)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/current-enterprises', component: Page }, { path: '/tasks', component: { template: '<div>后台任务</div>' } }] })
  await router.push(options.defaultUrl ? '/current-enterprises' : { path: '/current-enterprises', query: { titleCode: options.title ?? 'little_giant', q: '旧名', district: '鄞州区', page: '3', pageSize: '25', validYear: '2026', maintenanceYear: '2025' } })
  ;(globalThis as any).__routerBridge = { current: router }
  const wrapper = mount(Page, { global: { plugins: [createPinia(), PiniaColada, router], components: { NuxtLink: RouterLink } } })
  mounted.push(wrapper)
  await flushPromises()
  const submit = () => wrapper.get('button[aria-label^="导出当前称号名单："]')
  return { wrapper, router, calls, submit, fetcher }
}

it.each(['q', 'district'] as const)('default URL pending export keeps failure visible after first same-title %s update', async filter => {
  let reject!: (reason: Error) => void
  const { wrapper, router, submit, fetcher } = await setup({ defaultUrl: true, post: () => new Promise((_, no) => { reject = no }) })
  expect(router.currentRoute.value.fullPath).toBe('/current-enterprises')
  expect(submit().attributes('aria-label')).toBe('导出当前称号名单：专精特新“小巨人”')
  await submit().trigger('click')
  const body = fetcher.raw.mock.calls[0]![1].body
  if (filter === 'q') await wrapper.get('input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]').setValue('宁波')
  else wrapper.findAllComponents(Select).find(select => select.find('[aria-label="按区县筛选"]').exists())!.vm.$emit('update:modelValue', '鄞州区')
  await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ titleCode: 'little_giant', [filter]: filter === 'q' ? '宁波' : '鄞州区' }))
  reject(new Error('lost export receipt')); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('提交尚未确认')
  expect(wrapper.get('[role="alert"]').text()).toContain('请求标识已保留，重提沿用同一标识')
  expect(submit().attributes('disabled')).toBeUndefined()
  expect(router.currentRoute.value.path).toBe('/current-enterprises')
  expect(JSON.parse(sessionStorage.getItem(KEY)!)['little_giant:initial']).toEqual(body)
  expect(fetcher.raw).toHaveBeenCalledTimes(1)
})

it.each(['q', 'district'] as const)('default URL pending export opens accepted task after first same-title %s update', async filter => {
  let resolve!: (value: unknown) => void
  const { wrapper, router, submit, fetcher } = await setup({ defaultUrl: true, post: () => new Promise(yes => { resolve = yes }) })
  expect(router.currentRoute.value.fullPath).toBe('/current-enterprises')
  expect(submit().attributes('aria-label')).toBe('导出当前称号名单：专精特新“小巨人”')
  await submit().trigger('click')
  if (filter === 'q') await wrapper.get('input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]').setValue('宁波')
  else wrapper.findAllComponents(Select).find(select => select.find('[aria-label="按区县筛选"]').exists())!.vm.$emit('update:modelValue', '鄞州区')
  await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ titleCode: 'little_giant', [filter]: filter === 'q' ? '宁波' : '鄞州区' }))
  resolve({ status: 202, _data: { jobId: JOB } }); await flushPromises()
  expect(router.currentRoute.value).toMatchObject({ path: '/tasks', query: { tab: 'export', titleCode: 'little_giant', page: '1', job: JOB } })
  expect(fetcher.raw).toHaveBeenCalledTimes(1)
  expect(fetcher.raw.mock.calls[0]![0]).toBe('/api/roster/exports/current/little-giant')
  expect(fetcher.raw.mock.calls[0]![1].body).toEqual({ clientRequestId: expect.any(String) })
})

for (const entry of TASK_EXPORTS) it(`${entry.titleCode}: filtered query submits only a durable request identity to its dedicated route and opens unified task`, async () => {
  const { wrapper, router, calls, submit } = await setup({ title: entry.titleCode })
  expect(submit()).toBeTruthy()
  expect(submit().text()).toBe('导出当前称号名单')
  expect(submit().attributes('aria-label')).toBe(`导出当前称号名单：${entry.label}`)
  expect(submit().attributes('aria-describedby')).toBeUndefined()
  const actions = wrapper.get('header').text()
  expect(actions).not.toMatch(/导出范围|导出说明|忽略搜索|产物保留|工作表|数据快照/)
  expect(wrapper.get('header').findAll('button')).toHaveLength(1)
  await submit().trigger('click'); await flushPromises()
  const posts = calls.filter(c => c.options.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(posts[0]!.url).toBe(entry.path)
  expect(posts[0]!.options).toMatchObject({ headers: { 'x-task-center-browser': '1' }, retry: 0 })
  expect(Object.keys(posts[0]!.options.body)).toEqual(['clientRequestId'])
  expect(posts[0]!.options.query).toBeUndefined()
  expect(JSON.stringify(posts[0])).not.toMatch(/旧名|鄞州|validYear|maintenanceYear|pageSize|authorization/i)
  expect(router.currentRoute.value).toMatchObject({ path: '/tasks', query: { tab: 'export', titleCode: entry.titleCode, job: JOB } })
})

it('lost acceptance survives leaving and remounting; retry and accepted-task recovery reuse the same identity', async () => {
  const first = await setup({ post: async () => { throw new Error('lost 202') } })
  await first.submit().trigger('click'); await flushPromises()
  expect(first.wrapper.text()).toContain('提交尚未确认')
  const intent = JSON.parse(sessionStorage.getItem(KEY)!)['little_giant:initial']
  expect(intent.jobId).toBeUndefined()
  first.wrapper.unmount()
  const second = await setup()
  await second.submit().trigger('click'); await flushPromises()
  expect(second.fetcher.raw.mock.calls[0]![1].body).toEqual({ clientRequestId: intent.clientRequestId })
  second.wrapper.unmount()
  const restored = await setup()
  const link = restored.wrapper.findAll('a').find(a => a.text().includes('查看本次导出'))!
  expect(link.attributes('href')).toContain(JOB)
  await restored.submit().trigger('click'); await flushPromises()
  expect(restored.fetcher.raw.mock.calls[0]![1].body).toEqual({ clientRequestId: intent.clientRequestId })
})

it('same-identity 202 corrects a stale task link after returning and remounting the query page', async () => {
  const clientRequestId = '20600000-0000-4000-8000-000000000001'
  const staleJob = '01M5BEPVCXD5619ZW4C6CATREV'
  sessionStorage.setItem(KEY, JSON.stringify({ 'little_giant:initial': { clientRequestId, jobId: staleJob } }))
  let resolve!: (receipt: unknown) => void
  const first = await setup({ post: () => new Promise(yes => { resolve = yes }) })
  await first.submit().trigger('click')
  expect(first.fetcher.raw.mock.calls[0]![1].body).toEqual({ clientRequestId })
  expect(first.wrapper.findAll('a').find(a => a.text() === '查看本次导出')!.attributes('href')).toContain(staleJob)
  resolve({ status: 202, _data: { jobId: JOB } }); await flushPromises()
  expect(first.router.currentRoute.value.query.job).toBe(JOB)
  first.wrapper.unmount()
  const returned = await setup()
  const link = returned.wrapper.findAll('a').find(a => a.text() === '查看本次导出')!
  expect(link.attributes('href')).toContain(JOB)
  expect(link.attributes('href')).not.toContain(staleJob)
  await link.trigger('click'); await flushPromises()
  expect(returned.router.currentRoute.value.query.job).toBe(JOB)
})

it.each([
  { name: 'non-202', status: 200, jobId: JOB },
  { name: 'invalid job', status: 202, jobId: 'not-a-job' },
])('unconfirmed $name keeps the saved identity and task link for retry', async receipt => {
  const clientRequestId = '20600000-0000-4000-8000-000000000001'
  const staleJob = '01M5BEPVCXD5619ZW4C6CATREV'
  sessionStorage.setItem(KEY, JSON.stringify({ 'little_giant:initial': { clientRequestId, jobId: staleJob } }))
  const first = await setup({ post: async () => ({ status: receipt.status, _data: { jobId: receipt.jobId } }) })
  await first.submit().trigger('click'); await flushPromises()
  expect(first.wrapper.get('[role="alert"]').text()).toContain('提交尚未确认')
  expect(first.router.currentRoute.value.path).toBe('/current-enterprises')
  first.wrapper.unmount()
  const retry = await setup()
  expect(retry.wrapper.findAll('a').find(a => a.text() === '查看本次导出')!.attributes('href')).toContain(staleJob)
  await retry.submit().trigger('click'); await flushPromises()
  expect(retry.fetcher.raw.mock.calls[0]![1].body).toEqual({ clientRequestId })
  expect(retry.router.currentRoute.value.query.job).toBe(JOB)
})

it('double click while acceptance is pending sends one POST', async () => {
  let resolve!: (value: unknown) => void
  const { submit, fetcher } = await setup({ post: () => new Promise(r => { resolve = r }) })
  await submit().trigger('click'); await submit().trigger('click')
  expect(submit().text()).toBe('正在提交…')
  expect(submit().attributes('disabled')).toBeDefined()
  expect(fetcher.raw).toHaveBeenCalledTimes(1)
  resolve({ status: 202, _data: { jobId: JOB } }); await flushPromises()
})

it('exports without probing task-list authorization', async () => {
  const { submit, calls, fetcher } = await setup()
  expect(submit().attributes('disabled')).toBeUndefined()
  await submit().trigger('click'); await flushPromises()
  expect(fetcher.raw).toHaveBeenCalledTimes(1)
  expect(calls.some(call => call.url === '/api/task-center')).toBe(false)
})

for (const options of [{ capability: 'failed' as const }, { capability: 'missing' as const }]) it(`unconfirmed export route capability disables export: ${JSON.stringify(options)}`, async () => {
  const { wrapper, submit, fetcher } = await setup(options)
  expect(submit().attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toMatch(/未开放|未确认|尚未上线/)
  await submit().trigger('click')
  expect(fetcher.raw).not.toHaveBeenCalled()
})

it('storage failure prevents POST and explains that no request was sent', async () => {
  const { wrapper, submit, fetcher } = await setup()
  const storage = sessionStorage
  vi.stubGlobal('sessionStorage', {
    getItem: storage.getItem.bind(storage), clear: storage.clear.bind(storage),
    setItem: () => { throw new Error('unavailable') },
  })
  await submit().trigger('click'); await flushPromises()
  expect(fetcher.raw).not.toHaveBeenCalled()
  expect(wrapper.text()).toContain('无法保存请求标识')
})

it('a non-202 response never claims acceptance or navigates away', async () => {
  const { wrapper, router, submit } = await setup({ post: async () => ({ status: 200, _data: { jobId: JOB } }) })
  await submit().trigger('click'); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('提交尚未确认')
  expect(router.currentRoute.value.path).toBe('/current-enterprises')
  expect(JSON.parse(sessionStorage.getItem(KEY)!)['little_giant:initial'].jobId).toBeUndefined()
})

it('capability discovery can be retried before export without clearing query filters', async () => {
  const options = { capability: 'failed' as 'failed' | undefined }
  const { wrapper, submit, router } = await setup(options)
  expect(submit().attributes('disabled')).toBeDefined()
  options.capability = undefined
  await wrapper.findAll('button').find(b => b.text() === '重新发现导出能力')!.trigger('click'); await flushPromises()
  expect(submit().attributes('disabled')).toBeUndefined()
  expect(router.currentRoute.value.query.q).toBe('旧名')
})

it('updates the export accessible name when the selected title changes', async () => {
  const { submit, fetcher, router } = await setup()
  expect(submit().attributes('aria-label')).toBe('导出当前称号名单：专精特新“小巨人”')
  await router.push({ path: '/current-enterprises', query: { ...router.currentRoute.value.query, titleCode: 'specialized_sme' } })
  await flushPromises()
  expect(submit().attributes('aria-label')).toBe('导出当前称号名单：专精特新中小企业')
  expect(submit().text()).toBe('导出当前称号名单')
  expect(fetcher.raw).not.toHaveBeenCalled()
})
