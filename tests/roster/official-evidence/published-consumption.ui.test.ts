// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterLink, RouterView, useRoute as routerUseRoute } from 'vue-router'
import type { RosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import PageHeader from '../../../layers/core/app/components/PageHeader.vue'
import EnterprisePage from '../../../layers/sme-roster/app/pages/enterprises/[id].vue'
import CurrentPage from '../../../layers/sme-roster/app/pages/current-enterprises.vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OfficialEvidence from '../../../layers/sme-roster/app/components/OfficialEvidence.vue'

const mounted: ReturnType<typeof mount>[] = []
const evidence = { sourceFile: 'synthetic.pdf', page: 1, listNo: 7, attachment: '附件一' }
const stubs = { NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' } }
const fact = (nameRaw: string) => ({ evidenceId: 1, eventId: 9, revision: 1, availability: 'captured' as const, nameRaw, sourceBindingKnown: true })
beforeEach(() => {
  vi.stubGlobal('useState', () => ref(false))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
})
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it("keeps captured name empty whitespace and binding states separate from missing file HEAD", async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
  const wrapper = mount(OfficialEvidence, { props: { evidence: { ...evidence, publishedName: { ...fact(''), sourceBindingKnown: false } }, back: '' }, global: { stubs } }); mounted.push(wrapper)
  await flushPromises()
  expect(wrapper.get('[data-testid="published-name"]').text()).toBe('公布名称：""（出处绑定未核实）')
  expect(wrapper.text()).toContain('文件不可用；出处与已记录页码保留')
  await wrapper.setProps({ evidence: { ...evidence, publishedName: fact(' \t原值\n ') } }); await flushPromises()
  expect(wrapper.get('[data-testid="published-name"]').text()).toBe('公布名称：" \\t原值\\n "')
})

async function renderCurrent(aliases: string[]) {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(max-width: 639px)', media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  } as MediaQueryList))
  const row = { enterpriseId: 21, name: '新名', uscc: '91330211255994457P', district: '鄞州区', aliases, publishedNames: ['待核别名'], firstYear: 2024,
    recognition: { precision: 'year', year: 2024 }, matchedValidYears: [], matchedMaintenance: [], basis: '旧资格摘要', reviews: '', publication: '已见本称号宁波公布记录', notes: [], references: [], group: 'eligible',
    publishedPresentation: { availability: 'available', error: null, facts: [fact('公告名')] } }
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => url === '/api/roster/exports/current/capabilities' ? { exports: [] } : {
    rows: [row], total: 1, uncertainTotal: 0, options: { recognitionYears: [2024], validYears: [], maintenanceYears: [], maintenanceBatchesByYear: {} }, page: 1, pageSize: 25,
  }))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/current-enterprises', component: CurrentPage }, { path: '/enterprises/:id', component: { template: '<p>详情</p>' } }] })
  await router.push({ path: '/current-enterprises', query: { titleCode: 'specialized_sme' } })
  ;(globalThis as any).__routerBridge = { current: router }
  const wrapper = mount(CurrentPage, { global: { plugins: [createPinia(), PiniaColada, router], components: { NuxtLink: RouterLink } } }); mounted.push(wrapper)
  await flushPromises(); return wrapper
}

it("keeps confirmed aliases and the detail entry while leaving published-source text on the detail page", async () => {
  const wrapper = await renderCurrent(['已确认旧名']), card = wrapper.get('[data-testid="current-enterprise-card"]')
  expect(card.text()).toContain('新名')
  expect(card.text()).toContain('已确认曾用名：已确认旧名')
  expect(card.text()).not.toContain('公布名称："公告名"')
  expect(card.text()).not.toContain('待核别名')
  expect(card.get('a').attributes('href')).toContain('/enterprises/21')
  expect(wrapper.findAll('a').filter(a => a.text() === '公布名称："公告名"')).toHaveLength(0)
  expect(wrapper.get('table tbody tr').text()).toContain('已确认曾用名：已确认旧名')
})

it("leaves the mobile confirmed alias label absent when no confirmed alias exists", async () => {
  const wrapper = await renderCurrent([]), card = wrapper.get('[data-testid="current-enterprise-card"]')
  expect(card.text()).toContain('新名'); expect(card.text()).not.toContain('公布名称："公告名"')
  expect(card.text()).not.toContain('已确认曾用名'); expect(card.text()).not.toContain('待核别名')
})

it("keeps the real enterprise page single-root for Nuxt out-in navigation from the source dialog to a file", () => {
  // Vue Transition requires a component to have one element root:
  // https://vuejs.org/guide/built-ins/transition.html#the-transition-component
  // This page uses the Nuxt out-in transition; UI07 retains the actual SPA failure.
  const filename = resolve(process.cwd(), 'layers/sme-roster/app/pages/enterprises/[id].vue')
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
  expect(errors).toEqual([])
  const roots = descriptor.template!.ast!.children.filter(node => node.type !== 3 && !(node.type === 2 && !node.content.trim()))
  expect(roots.map(node => node.type === 1 ? node.tag : '#non-element')).toEqual(['div'])
})

describe("published evidence navigation", () => {
  let animate: PropertyDescriptor | undefined
  const preventNativeNavigation = (event: Event) => event.preventDefault()
  beforeEach(() => {
    animate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
    Reflect.deleteProperty(Element.prototype, 'animate')
    document.addEventListener('click', preventNativeNavigation)
    vi.stubGlobal('definePageMeta', vi.fn())
    sessionStorage.clear()
  })
  afterEach(async () => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    await flushPromises()
    document.removeEventListener('click', preventNativeNavigation)
    if (animate) Object.defineProperty(Element.prototype, 'animate', animate)
    document.body.innerHTML = ''
    sessionStorage.clear()
  })

  const currentBack = 'titleCode=specialized_sme&q=Acme&district=鄞州区&page=2'
  const ledgerBack = 'titleCode=specialized_sme&page=4'
  async function formal(initial: number, context: 'current' | 'back') {
    const publishedName = fact('2024公布原名')
    const event = {
      id: 9, recordId: 2, eventType: 'review', year: 2021, decidedYear: 2024, batchSeq: 1, reviewOutcome: 'passed',
      record: { id: 2, enterpriseId: 42, titleCode: 'specialized_sme', source: 'jxj' },
      evidence: [{ id: 1, sourceFile: 'synthetic.pdf', page: 1, listNo: 7, attachment: '附件一', publishedName }],
      publishedPresentation: { availability: 'available', error: null, facts: [publishedName] },
    }
    const record = { ...event.record, district: '鄞州区', nameRaw: null }
    const detail = { enterprise: { enterpriseId: 42, name: '合成企业', uscc: '91330211255994457P', district: '鄞州区' },
      aliases: [], records: [record], events: [event, { ...event, id: 10 }], evidence: [9, 10].map(eventId => ({ ...event.evidence[0]!, id: eventId === 9 ? 1 : 2, eventId })),
      recognitions: [], differences: [], titleAssessments: [], platform: { queries: [], relations: [], businessRecords: [] },
      businessTimeline: {
        asOf: '2026-11-16',
        sources: [
          { source: 'publication', collectionStatus: 'not_applicable', collectedAt: null, events: [9, 10].map(id => ({
            key: `publication:${id}`, platformName: null, title: 'specialized_sme', matter: 'review', matterRaw: 'review',
            conclusion: 'passed', statusRaw: 'passed', businessTimeKind: 'recognition', businessYear: 2024,
            businessTime: { raw: '2024', value: '2024', precision: 'year' },
            period: { from: { raw: null, value: null, precision: 'unknown' }, until: { raw: null, value: null, precision: 'unknown' } },
            collectedAt: null, cycleKey: null,
          })) },
          { source: 'recognized_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
          { source: 'business_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
          { source: 'apply_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
        ],
      } satisfies RosterEnterpriseDetail['businessTimeline'],
      publishedPresentation: event.publishedPresentation }
    const api = vi.fn(async (url: string) => {
      if (url === '/api/roster/enterprises/42') return detail
      throw new Error('Unexpected detail request ' + url)
    })
    vi.stubGlobal('$fetch', api)
    vi.stubGlobal('useRoute', routerUseRoute)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/enterprises/:id', component: EnterprisePage }, { path: '/:pathMatch(.*)*', component: { template: '<p>返回页</p>' } }] })
    const query = context === 'current' ? { currentBack, back: ledgerBack } : { back: ledgerBack }
    await router.push({ path: '/enterprises/42', query: { ...query, eventId: String(initial) } })
    const wrapper = mount(defineComponent({ render: () => h(RouterView) }), { attachTo: document.body,
      global: { plugins: [createPinia(), PiniaColada, router], components: { NuxtLink: RouterLink, PageHeader }, stubs: {
        FilePreviewDialog: true,
        RosterTitleBadge: true, RosterSourceChip: true, RosterEventChip: true,
      } } }); mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.find('#record-event-9').exists()).toBe(true)
    expect(wrapper.find('#record-event-10').exists()).toBe(true)
    await vi.waitFor(() => expect(wrapper.get(`#record-event-${initial}`).attributes('data-highlighted')).toBe('true'))
    return { wrapper, router, api }
  }

  it.each((['current', 'back'] as const).flatMap(context => [9, 10].map(initial => ({ context, initial }))))("published PDF page returns to event $initial preserving $context", async ({ initial, context }) => {
    const { wrapper, router } = await formal(initial, context)
    const before = router.currentRoute.value.fullPath
    const link = wrapper.get(`#record-event-${initial} [data-testid="official-evidence"] a`)
    const file = new URL(link.attributes('href')!, 'http://local.invalid')
    expect(file.pathname).toBe('/preview')
    expect(file.searchParams.get('file')).toBe('synthetic.pdf')
    expect(file.searchParams.get('page')).toBe('1')
    const back = file.searchParams.get('back')!
    expect(router.resolve(back).query).toEqual({ ...router.currentRoute.value.query, tab: 'records', eventId: String(initial) })
    await link.trigger('click', { button: 0 }); await flushPromises()
    expect(router.currentRoute.value.path).toBe('/preview')
    // Preview rendering is outside this runtime owner; use its public back URL.
    await router.push(back); await flushPromises()
    expect(wrapper.find(`#record-event-${initial}`).exists()).toBe(true)
    expect(router.currentRoute.value.query.eventId).toBe(String(initial))
    expect(router.resolve(before).query).toEqual({ ...(context === 'current' ? { currentBack } : {}), back: ledgerBack, eventId: String(initial) })
  })

})
