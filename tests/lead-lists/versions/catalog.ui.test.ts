// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { PiniaColada } from '@pinia/colada'
import { createPinia } from 'pinia'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { RouterLink, createMemoryHistory, createRouter, useRoute, useRouter } from 'vue-router'
import { Select } from '../../../layers/core/app/components/ui/select'
import Page from '../../../layers/lead-lists/app/pages/lead-lists/index.vue'
import type { LeadCatalog, LeadVersionSummary } from '../../../layers/lead-lists/lib/contracts'

const version = (id: number, series: string, channel: string, listType: string, acquiredOn: string): LeadVersionSummary => ({
  id, series, channel, listType, acquiredOn, fileId: id, fileName: `${series}.xlsx`, filePath: `${series}.xlsx`, fileAvailable: true,
})

const catalog: LeadCatalog = {
  channels: [{ code: 'research', name: '调研走访' }, { code: 'partner', name: '合作机构' }],
  listTypes: [{ code: 'lead', name: '线索名单' }, { code: 'service', name: '服务需求' }],
  versions: [
    version(1, '园区走访', 'research', 'lead', '2026-10-08'),
    version(2, '融资对接', 'partner', 'service', '2026-11-06'),
    version(3, '重点走访', 'research', 'service', '2026-11-05'),
  ],
}
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })
afterEach(() => vi.unstubAllGlobals())

async function render(path = '/lead-lists', data = catalog) {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/lead-lists/versions') return data
    const item = data.versions.find(item => url === `/api/lead-lists/versions/${item.id}`)
    if (item) return { ...item, rows: [{ id: 1, rowNumber: 2, name: '待走访企业', uscc: null, district: null, note: null, enterpriseId: null }] }
    throw new Error('名单不存在')
  })
  vi.stubGlobal('$fetch', fetch)
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('useRouter', useRouter)
  vi.stubGlobal('useHead', vi.fn())
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/lead-lists', component: Page }],
  })
  await router.push(path)
  await router.isReady()
  const view = mount(Page, { attachTo: document.body, global: {
    plugins: [router, createPinia(), PiniaColada], components: { NuxtLink: RouterLink },
    stubs: { LeadListRegistration: true, LeadListSupplement: true, LeadListExport: true },
  } })
  await flushPromises()
  const ids = () => view.findAll('[data-lead-version]').map(link => link.attributes('data-lead-version'))
  const filter = async (id: string, value: string) => {
    const control = view.findAllComponents(Select).find(select => select.find(`#lead-catalog-${id}`).exists())
    expect(control).toBeDefined()
    control!.vm.$emit('update:modelValue', value)
    await flushPromises()
  }
  return { router, view, fetch, ids, filter }
}

it('shows known types and sources in the directory and intersects the two filters', async () => {
  const { router, view, fetch, ids, filter } = await render()
  try {
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/lead-lists/versions'])
    expect(ids()).toEqual(['2', '3', '1'])
    expect(view.get('[aria-label="名单目录"] table').text()).toContain('合作机构')
    expect(view.get('[aria-label="名单目录"] table').text()).toContain('线索名单')
    const sidebar = view.get('[aria-label="名单筛选侧栏"]')
    expect(sidebar.get('ul[aria-label="名单来源"]').text()).toContain('合作机构')
    const tab = (name: string) => sidebar.findAll('[role="tab"]').find(item => item.text() === name)!
    const choose = (name: string) => sidebar.get('ul').findAll('button').find(item => item.text().startsWith(name))!
    await tab('名单类型').trigger('keydown', { key: 'Enter' })
    expect(sidebar.get('ul[aria-label="名单类型"]').text()).toContain('线索名单')
    await choose('服务需求').trigger('click')
    await flushPromises()
    expect(ids()).toEqual(['2', '3'])
    await tab('名单来源').trigger('keydown', { key: 'Enter' })
    const research = choose('调研走访')
    expect(research.get('[aria-label="1 份名单"]').text()).toBe('1')
    await research.trigger('click')
    await flushPromises()
    expect(ids()).toEqual(['3'])
    expect(router.currentRoute.value.query).toEqual({ listType: 'service', channel: 'research' })
    expect(research.attributes('aria-pressed')).toBe('true')
    await view.get('[aria-label="移除筛选条件:名单来源：调研走访"]').trigger('click')
    await flushPromises()
    expect(ids()).toEqual(['2', '3'])
    await filter('series', 'value:园区走访')
    expect(view.text()).toContain('没有符合条件的名单')
    await view.findAll('button').find(button => button.text() === '清除筛选')!.trigger('click')
    await flushPromises()
    expect(ids()).toEqual(['2', '3', '1'])
  } finally { view.unmount() }
})

it('opens one version and returns to the same filtered page with focus on that version link', async () => {
  const { router, view, fetch, ids } = await render('/lead-lists?listType=service&page=2&pageSize=1')
  try {
    expect(ids()).toEqual(['3'])
    await view.get('[data-lead-version="3"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({ version: '3', listType: 'service', page: '2', pageSize: '1' })
    expect(fetch).toHaveBeenCalledWith('/api/lead-lists/versions/3')
    expect(view.get('[aria-label="名单企业"]').text()).toContain('待走访企业')
    expect(view.text()).toContain('来源 调研走访')
    await view.findAll('a').find(link => link.text().includes('返回名单目录'))!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ listType: 'service', page: '2', pageSize: '1' })
    expect(ids()).toEqual(['3'])
    expect(document.activeElement).toBe(view.get('[data-lead-version="3"]').element)
  } finally { view.unmount() }
})

it('keeps the add action available when there are no lists', async () => {
  const { view, fetch } = await render('/lead-lists', { ...catalog, versions: [] })
  try {
    expect(view.text()).toContain('还没有名单')
    expect(view.findAll('button').filter(button => button.text() === '新增名单')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally { view.unmount() }
})

it('searches every catalog source across dozens of categories without changing the conditions until selection', async () => {
  const additional = Array.from({ length: 40 }, (_, i) => ({ code: `district-${i}`, name: `园区 ${String(i).padStart(2, '0')}` }))
  const { view, ids } = await render('/lead-lists', {
    ...catalog,
    channels: [...catalog.channels, ...additional],
    versions: [...catalog.versions, ...additional.map((item, i) => version(i + 4, item.name, item.code, 'lead', '2026-11-07'))],
  })
  try {
    const sidebar = view.get('[aria-label="名单筛选侧栏"]')
    expect(sidebar.get('ul[aria-label="名单来源"]').findAll('li')).toHaveLength(43)
    await sidebar.get('input[aria-label="搜索名单来源"]').setValue('园区 39')
    const choices = sidebar.get('ul[aria-label="名单来源"]').findAll('button')
    expect(choices).toHaveLength(2)
    expect(choices[1]!.text()).toContain('园区 39')
    expect(ids()).toHaveLength(25)
    await choices[1]!.trigger('click')
    await flushPromises()
    expect(ids()).toEqual(['43'])
    expect(choices[1]!.attributes('aria-pressed')).toBe('true')
  } finally { view.unmount() }
})
