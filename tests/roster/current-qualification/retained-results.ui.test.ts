// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterLink, useRoute, useRouter } from 'vue-router'
import CurrentPage from '../../../layers/sme-roster/app/pages/current-enterprises.vue'

const views: ReturnType<typeof mount>[] = []
afterEach(() => { views.forEach(view => view.unmount()); views.length = 0; vi.unstubAllGlobals() })
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function setup() {
  const requests: { query: any; result: ReturnType<typeof deferred> }[] = []
  vi.stubGlobal('$fetch', vi.fn((url, options) => {
    // The integrated export header discovers read-only capabilities independently.
    if (url === '/api/roster/exports/current/capabilities') return Promise.resolve({ exports: [] })
    if (url === '/api/task-center') return Promise.resolve({ authorized: false })
    const result = deferred(); requests.push({ query: options.query, result }); return result.promise
  }))
  vi.stubGlobal('useRoute', useRoute); vi.stubGlobal('useRouter', useRouter); vi.stubGlobal('useHead', () => {})
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/current-enterprises', component: CurrentPage }, { path: '/enterprises/:id', component: { template: '<p>企业详情</p>' } }] })
  await router.push('/current-enterprises?titleCode=little_giant&q=甲&district=鄞州区&page=2&pageSize=1&sort=name_desc')
  const view = mount(CurrentPage, { global: { plugins: [router, createPinia(), PiniaColada], components: { NuxtLink: RouterLink } } })
  views.push(view); await flushPromises()
  return { view, router, requests }
}
const success = (name = '甲企业', total = 3) => ({ rows: [{ enterpriseId: 154, name, aliases: [], notes: [], publishedNames: [], publication: '本称号正式依据' }], total, page: 2, pageSize: 1 })

it('does not invent an initial zero count through failure and retry and shows a settled empty count', async () => {
  const { view, requests } = await setup()
  expect(view.text()).not.toContain('共 0')
  expect(view.find('[data-slot="skeleton"]').exists()).toBe(true)
  expect(view.find('[data-testid="current-mobile-loading"] [data-slot="skeleton"]').exists()).toBe(true)
  expect(view.find('[data-table-pagination]').exists()).toBe(false)
  requests[0]!.result.reject(new Error('initial read unavailable')); await flushPromises()
  expect(view.text()).toContain('企业资格查询失败')
  expect(view.find('[data-testid="current-mobile-loading"]').exists()).toBe(false)
  expect(view.find('[data-table-pagination]').exists()).toBe(false)
  await view.findAll('button').find(button => button.text().includes('重新加载'))!.trigger('click'); await flushPromises()
  expect(view.text()).not.toContain('共 0')
  expect(view.find('[data-testid="current-mobile-loading"]').exists()).toBe(true)
  requests.at(-1)!.result.resolve({ rows: [], total: 0, page: 2, pageSize: 1 }); await flushPromises()
  expect(view.text()).toContain('共 0 家企业')
  expect(view.findAll('[data-slot="empty-title"]').map(title => title.text())).toEqual(['没有符合条件的企业', '没有符合条件的企业'])
  expect(view.find('[data-testid="current-mobile-loading"]').exists()).toBe(false)
})

it('identifies retained title filters and page and returns detail to the displayed request after target failure', async () => {
  const { view, router, requests } = await setup()
  requests[0]!.result.resolve(success()); await flushPromises()
  await view.get('[role="tab"][data-state="inactive"]').trigger('click'); await flushPromises()
  // Change filters while the other title request is still in flight.
  await router.replace('/current-enterprises?titleCode=specialized_sme&q=乙&district=海曙区'); await flushPromises()
  requests.at(-1)!.result.reject(new Error('synthetic read unavailable')); await flushPromises()
  expect(view.text()).toContain('当前显示：专精特新“小巨人”')
  expect(view.text()).toContain('搜索：甲')
  expect(view.text()).toContain('区县：鄞州区')
  expect(view.text()).toContain('第 2 页')
  expect(view.text()).toContain('请求目标：专精特新中小企业')
  expect(view.text()).toContain('搜索：乙')
  const link = view.findAll('a').find(a => a.text() === '查看详情与出处')!
  const back = new URL(link.attributes('href')!, 'http://localhost').searchParams.get('currentBack')!
  expect(Object.fromEntries(new URLSearchParams(back))).toEqual({ titleCode: 'little_giant', status: 'effective', q: '甲', district: '鄞州区', sort: 'name_desc', page: '2', pageSize: '1' })
  await link.trigger('click'); await flushPromises()
  expect(router.currentRoute.value.path).toBe('/enterprises/154')
  await router.push('/current-enterprises?' + back); await flushPromises()
  expect(router.currentRoute.value.query.titleCode).toBe('little_giant')
  expect(router.currentRoute.value.query.status).toBe('effective')
})

it('keeps retained table rows stable while loading and ignores an out of order response', async () => {
  const { view, router, requests } = await setup()
  requests[0]!.result.resolve(success()); await flushPromises()
  await router.replace('/current-enterprises?titleCode=specialized_sme'); await flushPromises()
  expect(view.findAll('tbody tr')).toHaveLength(1)
  expect(view.find('[data-slot="skeleton"]').exists()).toBe(false)
  const slow = requests.at(-1)!
  await router.replace('/current-enterprises?titleCode=innovative_sme'); await flushPromises()
  requests.at(-1)!.result.resolve(success('创新企业', 1)); await flushPromises()
  slow.result.resolve(success('迟到企业', 8)); await flushPromises()
  expect(view.text()).toContain('创新企业')
  expect(view.text()).not.toContain('迟到企业')
  expect(view.text()).not.toContain('甲企业')
})

it('retains a successful empty result without replacing it with a skeleton during retry', async () => {
  const { view, router, requests } = await setup()
  requests[0]!.result.resolve({ rows: [], total: 0, page: 2, pageSize: 1 }); await flushPromises()
  await router.replace('/current-enterprises?titleCode=specialized_sme'); await flushPromises()
  expect(view.findAll('[data-slot="empty-title"]').map(title => title.text())).toEqual(['没有符合条件的企业', '没有符合条件的企业'])
  expect(view.findAll('tbody tr')).toHaveLength(1)
  expect(view.find('[data-slot="skeleton"]').exists()).toBe(false)
  expect(view.text()).toContain('共 0 家企业')
})
