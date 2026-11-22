// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, useRoute, useRouter } from 'vue-router'
import PageHeader from '../../../layers/core/app/components/PageHeader.vue'
import TableFailureState from '../../../layers/core/app/components/TableFailureState.vue'
import TableLoadingStatus from '../../../layers/core/app/components/TableLoadingStatus.vue'
import TablePagination from '../../../layers/core/app/components/TablePagination.vue'
import RosterPage from '../../../layers/sme-roster/app/pages/roster.vue'

const mounted: ReturnType<typeof mount>[] = []

afterEach(() => {
  mounted.splice(0).forEach(view => view.unmount())
  vi.unstubAllGlobals()
})

async function openLedger(path: string, beforeResult?: Promise<void>) {
  const setHead = vi.fn()
  vi.stubGlobal('useHead', setHead)
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('useRouter', useRouter)
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('$fetch', async (url: string, options?: { query: { q?: string } }) => {
    if (url === '/api/roster/ledger-years') return { eventYears: [], firstRecognitionYears: [] }
    if (url !== '/api/roster/enterprises') throw new Error(`Unexpected request: ${url}`)
    if (options?.query.q === '断开') throw new Error('Network failure')
    await beforeResult
    const rows = options?.query.q === '未命中' ? [] : [{
      enterpriseId: 13,
      name: '精密企业',
      uscc: null,
      district: '鄞州区',
      aliasNames: [],
      titles: [],
      firstRecognition: [],
      difference: { count: 0, status: null, reasonCode: null, anyCurrent: false },
    }]
    return { rows, counts: { total: rows.length, titlePairs: 0, titles: {}, recognitionPairs: 0, differences: 0 } }
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }, { path: '/roster', component: RosterPage }],
  })
  await router.push('/')
  await router.push(path)
  const view = mount(RosterPage, {
    global: {
      plugins: [router, createPinia(), PiniaColada],
      components: { PageHeader, TableFailureState, TableLoadingStatus, TablePagination },
      stubs: {
        RosterEnterpriseDrawer: { props: ['enterpriseId'], template: '<button v-if="enterpriseId" @click="$emit(\'close\')">关闭抽屉</button>' },
      },
    },
  })
  mounted.push(view)
  await flushPromises()
  return { router, view, setHead }
}

it.each([1280, 390])('keeps ledger export and filters available at %ipx', async width => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media === '(max-width: 639px)' && width <= 639,
    addEventListener() {},
    removeEventListener() {},
  }))
  const { view } = await openLedger('/roster?q=精密&district=鄞州区')
  const actions = view.get('[aria-label="企业列表操作"]')
  const exportLink = new URL(actions.get('a').element.href)
  expect(exportLink.pathname).toBe('/api/roster/export')
  expect(exportLink.searchParams.get('q')).toBe('精密')
  expect(exportLink.searchParams.get('district')).toBe('鄞州区')
  expect(actions.find('button').exists()).toBe(false)
  expect(view.find('[aria-label="按属地筛选"]').exists()).toBe(true)
  expect(view.text().includes('更多筛选与排序')).toBe(width <= 639)
})

it('opens the drawer in history and returns to the filtered ledger before leaving it', async () => {
  const { router, view } = await openLedger('/roster?q=精密&district=鄞州区')
  await view.get('[data-testid="enterprise-name-trigger"]').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.query).toEqual({ q: '精密', district: '鄞州区', expand: '13' })
  expect(view.text()).toContain('关闭抽屉')
  router.back()
  await flushPromises()
  expect(router.currentRoute.value).toMatchObject({ path: '/roster', query: { q: '精密', district: '鄞州区' } })
  expect(router.currentRoute.value.query.expand).toBeUndefined()
  expect(view.text()).not.toContain('关闭抽屉')
  expect(view.get('input').element.value).toBe('精密')
  router.forward()
  await flushPromises()
  expect(view.text()).toContain('关闭抽屉')
})

it('closes a shared drawer link without navigating to the previous page', async () => {
  const { router, view } = await openLedger('/roster?q=精密&expand=13')
  await view.findAll('button').find(button => button.text() === '关闭抽屉')!.trigger('click')
  await flushPromises()
  expect(router.currentRoute.value).toMatchObject({ path: '/roster', query: { q: '精密' } })
  expect(router.currentRoute.value.query.expand).toBeUndefined()
})

it('has no loading label left in the title or live region after an empty result settles', async () => {
  const { view, setHead } = await openLedger('/roster?q=未命中')
  expect(view.text()).toContain('没有匹配的企业')
  expect(setHead).toHaveBeenCalledWith({ title: '历年优质中小企业' })
  expect(view.get('[data-testid="ledger-loading-status"]').text()).toBe('')
})

it('shows a zero count only after a confirmed empty result and retains it across a later failure', async () => {
  let settle!: () => void
  const pending = new Promise<void>(resolve => { settle = resolve })
  const { view } = await openLedger('/roster?q=未命中', pending)
  expect(view.findComponent(TablePagination).exists()).toBe(false)
  settle()
  await flushPromises()
  expect(view.getComponent(TablePagination).text()).toContain('共 0 家')
  expect(view.getComponent(TablePagination).props('loading')).toBe(false)
  await view.get('input').setValue('断开')
  await vi.waitFor(() => expect(view.getComponent(TableFailureState).text()).toContain('企业列表暂时无法加载'))
  expect(view.getComponent(TablePagination).text()).toContain('共 0 家')
  expect(view.getComponent(TablePagination).props('loading')).toBe(true)
  expect(view.text()).toContain('没有匹配的企业')
})
