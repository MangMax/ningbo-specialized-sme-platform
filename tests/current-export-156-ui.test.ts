// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createRouter, createMemoryHistory, RouterLink } from 'vue-router'
import Page from '../pages/current-enterprises.vue'
import { TASK_EXPORTS } from '../lib/task-center'
import { Select } from '../components/ui/select'

const JOB = '01M5BEPVCXD5619ZW4C6CATRET'
const KEY = 'task-center-export-requests-v1'
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(w => w.unmount()); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function setup(options: { title?: string; defaultUrl?: boolean; authorized?: boolean; capability?: 'failed' | 'missing'; post?: () => Promise<unknown> } = {}) {
  const calls: { url: string; options: any }[] = []
  const fetcher = Object.assign(async (url: string, init: any = {}) => {
    calls.push({ url, options: init })
    if (url.endsWith('/capabilities')) {
      if (options.capability === 'failed') throw new Error('offline')
      return { exports: options.capability === 'missing' ? [] : TASK_EXPORTS.map(t => ({ ...t, ready: true })) }
    }
    if (url === '/api/task-center') return { authorized: options.authorized !== false }
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
  const submit = () => wrapper.get('button[aria-describedby="current-export-scope current-export-reason"]')
  return { wrapper, router, calls, submit, fetcher }
}

it.each(['q', 'district'] as const)('default URL pending export keeps failure visible after first same-title %s update', async filter => {
  let reject!: (reason: Error) => void
  const { wrapper, router, submit, fetcher } = await setup({ defaultUrl: true, post: () => new Promise((_, no) => { reject = no }) })
  expect(router.currentRoute.value.fullPath).toBe('/current-enterprises')
  expect(wrapper.text()).toContain('导出范围：专精特新“小巨人”')
  await submit().trigger('click')
  const body = fetcher.raw.mock.calls[0]![1].body
  if (filter === 'q') await wrapper.get('input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]').setValue('宁波')
  else wrapper.findComponent(Select).vm.$emit('update:modelValue', '鄞州区')
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
  expect(wrapper.text()).toContain('导出范围：专精特新“小巨人”')
  await submit().trigger('click')
  if (filter === 'q') await wrapper.get('input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]').setValue('宁波')
  else wrapper.findComponent(Select).vm.$emit('update:modelValue', '鄞州区')
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
  expect(wrapper.text()).toContain(`导出范围：${entry.label}`)
  expect(wrapper.get('#current-export-scope').text()).toContain('导出该称号全部企业，忽略搜索、筛选及分页。')
  expect(wrapper.text()).toContain('后台任务查看、取消及下载，产物保留 7 天')
  const explanation = wrapper.findAll('button').find(button => button.text() === '导出说明')!
  expect(explanation.attributes('aria-expanded')).toBe('false')
  await explanation.trigger('click'); await flushPromises()
  expect(explanation.attributes('aria-expanded')).toBe('true')
  expect(wrapper.text()).toContain('有效企业、待确认、排除明细、口径说明')
  expect(wrapper.text()).toContain('与页面查询可能存在时间差')
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

it('double click while acceptance is pending sends one POST', async () => {
  let resolve!: (value: unknown) => void
  const { submit, fetcher } = await setup({ post: () => new Promise(r => { resolve = r }) })
  await submit().trigger('click'); await submit().trigger('click')
  expect(fetcher.raw).toHaveBeenCalledTimes(1)
  resolve({ status: 202, _data: { jobId: JOB } }); await flushPromises()
})

for (const options of [{ authorized: false }, { capability: 'failed' as const }, { capability: 'missing' as const }]) it(`unconfirmed capability or authorization disables export: ${JSON.stringify(options)}`, async () => {
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

it('updates the export scope beside the action when the selected title changes', async () => {
  const { wrapper, fetcher, router } = await setup()
  expect(wrapper.text()).toContain('导出范围：专精特新“小巨人”')
  await router.push({ path: '/current-enterprises', query: { ...router.currentRoute.value.query, titleCode: 'specialized_sme' } })
  await flushPromises()
  expect(wrapper.text()).toContain('导出范围：专精特新中小企业')
  expect(wrapper.text()).not.toContain('导出范围：专精特新“小巨人”')
  expect(fetcher.raw).not.toHaveBeenCalled()
})
