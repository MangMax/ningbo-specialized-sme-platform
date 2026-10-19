// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { Tabs } from '../components/ui/tabs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/**
 * 真实 route 组件 + 真实 router：`onBeforeRouteLeave` 只在 route 组件上注册
 * 才可靠，所以这里必须经过 RouterView 挂载，而不是直接 mount 页面。
 */
vi.stubGlobal('definePageMeta', vi.fn())
vi.stubGlobal('useHead', vi.fn())
const ComparisonPage = (await import('../pages/comparison.vue')).default

const row = {
  id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit',
  decisionId: 82, latestRevisionId: 9, reviewedRevisionId: null, classification: 'premise_invalid',
  pending: true, lineage: 'current',
  oldDecision: { id: 82, status: 'not_queried', reasonNote: '原依据缺代码' },
}
const nameOf = (id: number) => `合成企业${id}`
const Home = defineComponent({ render: () => h('div', { 'data-testid': 'home' }, 'home') })
const Root = defineComponent({ render: () => h(RouterView) })

const dialogStubs = {
  Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
  DialogContent: { template: '<div data-testid="dialog-content"><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<h2><slot /></h2>' },
  DialogDescription: { template: '<p><slot /></p>' },
  DialogFooter: { template: '<div><slot /></div>' },
}

let fetcher: ReturnType<typeof vi.fn>
let committed = false

function installApi() {
  committed = false
  fetcher = vi.fn(async (url: string, options?: any) => {
    if (options?.method === 'POST' && url === '/api/roster/decision-lifecycle/commands') {
      committed = true
      return { action: 'maintain', reviewedRevisionId: 9 }
    }
    const profile = /\/api\/roster\/enterprises\/(\d+)\/profile$/.exec(url)
    if (profile) return { profile: { enterpriseId: Number(profile[1]), name: nameOf(Number(profile[1])) } }
    if (url === '/api/roster/evidence-impacts') return { rows: [row], nextCursor: null, asOf: { revision: 9 }, projectionReady: true }
    if (url === '/api/roster/evidence-impacts/4') {
      return {
        ...row,
        pending: !committed,
        currentDecision: { versionId: 82, current: row.oldDecision },
        evidenceToken: { decisionId: 82, latestRevisionId: 9, projectionReady: true },
        queryCoverage: null,
        gaps: { subjectUnknown: false, projectionReady: true },
      }
    }
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url === '/api/roster/decision-lifecycle/history') return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  })
  vi.stubGlobal('$fetch', fetcher)
}

async function mountPage(initialPath = '/comparison?mode=review') {
  installApi()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Home },
      { path: '/comparison', component: ComparisonPage },
      { path: '/enterprises/:id', component: Home },
    ],
  })
  await router.push(initialPath)
  await router.isReady()
  // 队列组件的 syncQuery 仍走 Nuxt 自动导入；测试绑定到同一个真实 router。
  vi.stubGlobal('useRoute', () => router.currentRoute.value)
  vi.stubGlobal('useRouter', () => router)
  const view = mount(Root, {
    attachTo: document.body,
    global: {
      plugins: [router, createPinia(), PiniaColada],
      stubs: {
        NuxtLink: { props: ['to'], template: '<a :href="String(to)"><slot /></a>' },
        RecordComparisonPanel: { template: '<div data-testid="record-panel" />' },
        PageHeader: true,
        TablePagination: true,
        TableLoadingStatus: true,
        TableFailureState: true,
        ComparisonPlatformEvidence: true,
        ComparisonCuration: true,
        ...dialogStubs,
      },
    },
  })
  await flushPromises()
  return { router, view }
}

async function openAndFill(view: ReturnType<typeof mount>) {
  await flushPromises()
  await view.get('[aria-label="处理这一项 4"]').trigger('click')
  await flushPromises()
  for (const [label, value] of [
    ['写入凭证', 'synthetic-token'],
    ['复核人', 'route-reviewer'],
    ['复核依据', '全局队列里未提交的依据'],
    ['规则版本', 'route-rule'],
  ] as const) {
    await view.get(`[aria-label="${label}"]`).setValue(value)
  }
  await flushPromises()
}

function clickText(view: ReturnType<typeof mount>, text: string) {
  const button = view.findAll('button').find(candidate => candidate.text() === text)
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

function hasLeaveDialog(view: ReturnType<typeof mount>) {
  return view.findAll('[data-testid="comparison-draft-leave-dialog"]').length > 0
}
function leaveDialog(view: ReturnType<typeof mount>) {
  return view.get('[data-testid="comparison-draft-leave-dialog"]')
}

beforeEach(() => {
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal('definePageMeta', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('guards a sidebar route leave and keeps route, item and values on continue', async () => {
  const { router, view } = await mountPage()
  await openAndFill(view)

  router.push('/')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/comparison?mode=review')
  expect(hasLeaveDialog(view)).toBe(true)
  expect(leaveDialog(view).text()).toContain('离开会丢弃未提交内容')
  expect(leaveDialog(view).findAll('button').map(button => button.text())).toEqual(['继续填写', '离开并丢弃'])
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toBe('全局队列里未提交的依据')

  await clickText(view, '继续填写').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/comparison?mode=review')
  expect(hasLeaveDialog(view)).toBe(false)
  expect(view.find('[aria-label="复核依据"]').exists()).toBe(true)
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toBe('全局队列里未提交的依据')
  expect((view.get('[aria-label="复核人"]').element as HTMLInputElement).value).toBe('route-reviewer')

  await router.push('/')
  await flushPromises()
  await clickText(view, '离开并丢弃').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/')
  expect(view.find('[data-testid="home"]').exists()).toBe(true)
  expect(JSON.stringify({ ...sessionStorage })).not.toContain('synthetic-token')
  expect(JSON.stringify({ ...localStorage })).not.toContain('synthetic-token')
  view.unmount()
})

it('guards browser back (popstate) and leaves only after explicit discard', async () => {
  const { router, view } = await mountPage('/comparison?mode=record')
  await router.push('/comparison?mode=review')
  await flushPromises()
  await openAndFill(view)

  router.back()
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/comparison?mode=review')
  expect(hasLeaveDialog(view)).toBe(true)

  await clickText(view, '继续填写').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/comparison?mode=review')

  router.back()
  await flushPromises()
  expect(hasLeaveDialog(view)).toBe(true)
  await clickText(view, '离开并丢弃').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/comparison?mode=record')
  view.unmount()
})

it('guards leaving review through the same-page mode tabs but not through filter query sync', async () => {
  const { router, view } = await mountPage()
  await openAndFill(view)

  // 筛选写回 query 时 review 仍挂载，草稿不丢：不弹确认。
  await router.replace({ path: '/comparison', query: { mode: 'review', reviewState: 'all' } })
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/comparison?mode=review&reviewState=all')
  expect(hasLeaveDialog(view)).toBe(false)

  const tabs = view.findComponent(Tabs)
  tabs.vm.$emit('update:modelValue', 'record')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/comparison?mode=review&reviewState=all')
  expect(hasLeaveDialog(view)).toBe(true)

  await clickText(view, '继续填写').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.query.mode).toBe('review')
  expect(view.find('[aria-label="复核依据"]').exists()).toBe(true)

  tabs.vm.$emit('update:modelValue', 'record')
  await flushPromises()
  await clickText(view, '离开并丢弃').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/comparison')
  expect(router.currentRoute.value.query.mode).toBe('record')
  expect(view.find('[data-testid="record-panel"]').exists()).toBe(true)
  view.unmount()
})

it('does not stack a second dialog while the queue child confirmation is open', async () => {
  const { router, view } = await mountPage()
  await openAndFill(view)
  await view.get('[aria-label="收起复核项 4"]').trigger('click')
  await flushPromises()
  expect(view.text()).toContain('收起会丢弃未提交内容')

  await router.push('/')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/comparison?mode=review')
  expect(hasLeaveDialog(view)).toBe(false)
  expect(view.findAll('[data-testid="review-draft-dialog"]')).toHaveLength(1)

  await clickText(view, '继续填写').trigger('click')
  await flushPromises()
  await router.push('/')
  await flushPromises()
  expect(hasLeaveDialog(view)).toBe(true)
  await clickText(view, '继续填写').trigger('click')
  await flushPromises()
  view.unmount()
})

it('does not guard after a successful submit already cleared the draft', async () => {
  const { router, view } = await mountPage()
  await openAndFill(view)

  await view.findAll('form').at(-1)!.trigger('submit')
  await flushPromises()
  await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/roster/decision-lifecycle/commands', expect.objectContaining({ method: 'POST' }))
  expect(view.text()).toContain('复核已登记')

  await router.push('/')
  await flushPromises()
  expect(hasLeaveDialog(view)).toBe(false)
  expect(router.currentRoute.value.fullPath).toBe('/')
  view.unmount()
})
