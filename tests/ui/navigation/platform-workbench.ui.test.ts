// @vitest-environment happy-dom
import { PiniaColada, useQueryCache } from '@pinia/colada'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterLink } from 'vue-router'
import * as registry from '../../../lib/app-modules'
import * as dashboard from '../../../lib/dashboard-card-components'
import Workbench from '../../../pages/index.vue'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openWorkbench(path: string, api: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('$fetch', api)
  vi.stubGlobal('useHead', vi.fn())
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push(path)
  const pinia = createPinia()
  const page = mount(Workbench, {
    global: { plugins: [pinia, PiniaColada, router], components: { NuxtLink: RouterLink } },
  })
  return { page, router, pinia }
}

it('shows the roster entry and both statistics on the workbench', async () => {
  const api = vi.fn().mockResolvedValue({ totalRecords: 10501, totalEnterprises: 7352 })
  const { page, router } = await openWorkbench('/', api)

  try {
    expect(page.get('h1').text()).toBe('平台工作台')
    expect(page.get('h2').text()).toBe('优质中小企业')
    expect(page.text()).toContain('查询企业称号、历年认定记录与有效资格。')
    expect(page.get('a').attributes('href')).toBe('/roster')
    await vi.waitFor(() => expect(page.text()).toMatch(/名录记录\s*10,501 个企业×称号\s*·\s*7,352 家有称号企业/))
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/stats')
    expect(page.text()).not.toContain('平台底座')

    await page.get('a').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/roster')
  } finally {
    page.unmount()
  }
})

it('keeps the workbench and a successful card visible when roster statistics fail and are retried', async () => {
  const [core, roster] = registry.getAppModules()
  const getComponent = dashboard.getDashboardCardComponent
  vi.spyOn(dashboard, 'getDashboardCardComponent')
    .mockImplementation(id => id === 'ready-card' ? { template: '<p>服务可用</p>' } : getComponent(id))
  vi.spyOn(registry, 'getAppModules').mockReturnValue([core, {
    ...roster,
    dashboard: [
      ...roster.dashboard ?? [],
      {
        id: 'ready-card',
        title: '服务状态',
      },
    ],
  }])
  const unavailable = new Error('statistics unavailable')
  const api = vi.fn()
    .mockRejectedValueOnce(unavailable)
    .mockResolvedValueOnce({ totalRecords: 0, totalEnterprises: 0 })
    .mockRejectedValueOnce(unavailable)
    .mockResolvedValueOnce({ totalRecords: 3, totalEnterprises: 2 })
  const { page, router, pinia } = await openWorkbench('/?q=旧列表筛选&expand=91', api)

  try {
    expect(page.get('h1').text()).toBe('平台工作台')
    expect(router.currentRoute.value.path).toBe('/')
    expect(page.get('a').attributes('href')).toBe('/roster')
    await vi.waitFor(() => {
      expect(page.get('[role="status"]').text()).toContain('名录统计加载失败')
      expect(page.text()).toContain('服务可用')
    })
    const retry = () => page.get('[role="status"] button')
    expect(retry().text()).toBe('重新加载')
    await retry().trigger('click')
    await vi.waitFor(() => expect(page.text()).toContain('0 家有称号企业'))
    expect(page.text()).not.toContain('名录统计加载失败')
    expect(page.text()).toContain('服务可用')

    await expect(useQueryCache(pinia).invalidateQueries({ key: ['stats'] })).rejects.toBe(unavailable)
    await vi.waitFor(() => expect(page.text()).toContain('显示的是上次加载的统计。'))
    expect(page.text()).toContain('0 家有称号企业')
    expect(page.text()).toContain('服务可用')
    await retry().trigger('click')
    await vi.waitFor(() => expect(page.text()).toContain('2 家有称号企业'))
    expect(page.text()).not.toContain('名录统计加载失败')
    expect(page.text()).toContain('服务可用')
    expect(api.mock.calls).toEqual(Array.from({ length: 4 }, () => ['/api/stats']))
  } finally {
    page.unmount()
  }
})
