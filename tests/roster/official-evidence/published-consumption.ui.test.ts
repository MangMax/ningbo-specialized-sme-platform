// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterLink, RouterView, useRoute as routerUseRoute } from 'vue-router'
import EnterprisePage from '../../../pages/enterprises/[id].vue'
import CorrespondenceItem from '../../../components/record-correspondence/CorrespondenceItem.vue'
import type { CorrespondenceDetail, EventSource, OfficialPublishedFact, SourceResponse } from '../../../lib/roster/correspondence-view'
import CurrentPage from '../../../pages/current-enterprises.vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SourceReader from '../../../components/record-correspondence/SourceReader.vue'
import OfficialEvidence from '../../../components/record-correspondence/OfficialEvidence.vue'
import { useRecordSource } from '../../../composables/useRecordSource'
import { refreshCorrespondenceViews } from '../../../composables/useCorrespondenceReadback'

const mounted: ReturnType<typeof mount>[] = []
const stubs = { NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' } }
const fact = (nameRaw: string | null, availability: 'captured' | 'unknown_legacy' = 'captured') => ({ evidenceId: 1, eventId: 9, revision: availability === 'captured' ? 1 : null, availability, nameRaw, sourceBindingKnown: availability === 'captured' ? true : null })
const source = (nameRaw: string | null = '2024公布原名', availability: 'captured' | 'unknown_legacy' = 'captured') => ({
  source: { id: 9, recordId: 2, eventType: 'review', year: 2021, decidedYear: 2024, batchSeq: 1, reviewOutcome: 'passed', record: { id: 2, enterpriseId: 42, titleCode: 'specialized_sme', source: 'jxj', usccRaw: null },
    evidence: [{ id: 1, sourceFile: 'synthetic.pdf', page: 1, listNo: 7, attachment: '附件一', publishedName: fact(nameRaw, availability) }], correspondences: [],
    publishedPresentation: { availability: 'available', error: null, facts: [fact(nameRaw, availability)] } }, correspondences: [],
})
const unavailable = () => ({ ...source(), source: { ...source().source, evidence: [], publishedPresentation: { availability: 'unavailable', error: 'read_failed', facts: [] } } })
function render(id = 9) {
  const wrapper = mount(SourceReader, { props: { kind: 'event', id, returnTo: '/comparison?mode=record' }, global: { stubs } })
  mounted.push(wrapper); return wrapper
}
beforeEach(() => {
  vi.stubGlobal('useState', () => ref(false))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
})
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('U01 rejects first typed unavailable scope and keeps null rather than displaying legacy', async () => {
  vi.stubGlobal('$fetch', vi.fn(async () => unavailable()))
  const wrapper = render(); await flushPromises()
  expect(wrapper.text()).toContain('未能读取事件出处')
  expect(wrapper.text()).not.toContain('未逐出处核实')
  expect(wrapper.find('[data-testid="official-evidence"]').exists()).toBe(false)
  expect(wrapper.findAll('button').some(b => b.text() === '重试读取')).toBe(true)
})

it('U02 retains the last successful names on unavailable and retry replaces them using the same existing request', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(source('原成功公布名')).mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(source('重试新公布名'))
  vi.stubGlobal('$fetch', fetch)
  const wrapper = render(); await flushPromises()
  await wrapper.setProps({ id: 10 }); await flushPromises()
  expect(wrapper.text()).toContain('未能读取事件出处')
  expect(wrapper.text()).toContain('上次成功读取的出处保留在下方')
  expect(wrapper.text()).toContain('公布名称："原成功公布名"')
  await wrapper.findAll('button').find(b => b.text() === '重试读取')!.trigger('click'); await flushPromises()
  expect(fetch).toHaveBeenLastCalledWith('/api/roster/correspondences/events/10')
  expect(wrapper.text()).toContain('公布名称："重试新公布名"')
  expect(wrapper.text()).not.toContain('原成功公布名')
  expect(wrapper.text()).not.toContain('未能读取事件出处')
})

it('U03 accepts legacy and captured null as successful names and keeps distinct review years', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(source(null, 'unknown_legacy')).mockResolvedValueOnce(source(null))
  vi.stubGlobal('$fetch', fetch)
  const wrapper = render(); await flushPromises()
  expect(wrapper.text()).toContain('未逐出处核实')
  expect(wrapper.text()).toContain('原认定 2021 年 · 复核结论 2024 年')
  expect(wrapper.text()).not.toContain('未能读取事件出处')
  await wrapper.setProps({ id: 10 }); await flushPromises()
  expect(wrapper.text()).toContain('已捕获出处，名称原值未知')
  expect(wrapper.text()).not.toContain('未逐出处核实')
})

it('U04 ignores stale unavailable and late success after a newer successful source', async () => {
  let first!: (value: unknown) => void, second!: (value: unknown) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { second = resolve })).mockResolvedValueOnce(source('当前成功名'))
  vi.stubGlobal('$fetch', fetch)
  const wrapper = render(); await wrapper.setProps({ id: 10 }); await wrapper.setProps({ id: 11 }); await flushPromises()
  first(unavailable()); second(source('旧晚响应名')); await flushPromises()
  expect(wrapper.text()).toContain('当前成功名')
  expect(wrapper.text()).not.toContain('旧晚响应名')
  expect(wrapper.text()).not.toContain('未能读取事件出处')
})

it('U05 reports failed explicit readback and recovers without replacing retained success on failure', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(source('保留公布名')).mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(source('恢复公布名'))
  vi.stubGlobal('$fetch', fetch)
  const wrapper = render(); await flushPromises()
  await expect(refreshCorrespondenceViews()).rejects.toThrow('readback_failed'); await flushPromises()
  expect(wrapper.text()).toContain('保留公布名')
  await expect(refreshCorrespondenceViews()).resolves.toBeUndefined(); await flushPromises()
  expect(wrapper.text()).toContain('恢复公布名')
})

it('U06 accepts old responses and platform raw unavailable strings without guessing typed failure', async () => {
  const payload = { source: { id: 1, nameRaw: 'unavailable', rawFields: { publishedPresentation: { availability: 'unavailable' } } }, correspondences: [] }
  vi.stubGlobal('$fetch', vi.fn(async () => payload))
  let reader!: ReturnType<typeof useRecordSource>
  const wrapper = mount(defineComponent({ setup() { reader = useRecordSource('relation', 1); return () => null } })); mounted.push(wrapper)
  await flushPromises(); expect(reader.displayed.value).toEqual(payload); expect(reader.error.value).toBe(false)
})

it('U07 keeps captured name empty whitespace and binding states separate from missing file HEAD', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
  const wrapper = mount(OfficialEvidence, { props: { evidence: { ...source().source.evidence[0]!, publishedName: { ...fact(''), sourceBindingKnown: false } } as any, back: '' }, global: { stubs } }); mounted.push(wrapper)
  await flushPromises()
  expect(wrapper.get('[data-testid="published-name"]').text()).toBe('公布名称：""（出处绑定未核实）')
  expect(wrapper.text()).toContain('文件不可用；出处与已记录页码保留')
  await wrapper.setProps({ evidence: { ...source().source.evidence[0]!, publishedName: fact(' \t原值\n ') } as any }); await flushPromises()
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

it('U08 keeps confirmed aliases and the detail entry while leaving published-source text on the detail page', async () => {
  const wrapper = await renderCurrent(['已确认旧名']), card = wrapper.get('[data-testid="current-enterprise-card"]')
  expect(card.text()).toContain('新名')
  expect(card.text()).toContain('已确认曾用名：已确认旧名')
  expect(card.text()).not.toContain('公布名称："公告名"')
  expect(card.text()).not.toContain('待核别名')
  expect(card.get('a').attributes('href')).toContain('/enterprises/21')
  expect(wrapper.findAll('a').filter(a => a.text() === '公布名称："公告名"')).toHaveLength(0)
  expect(wrapper.get('table tbody tr').text()).toContain('已确认曾用名：已确认旧名')
})

it('U09 leaves the mobile confirmed alias label absent when no confirmed alias exists', async () => {
  const wrapper = await renderCurrent([]), card = wrapper.get('[data-testid="current-enterprise-card"]')
  expect(card.text()).toContain('新名'); expect(card.text()).not.toContain('公布名称："公告名"')
  expect(card.text()).not.toContain('已确认曾用名'); expect(card.text()).not.toContain('待核别名')
})

it('U10 keeps the real enterprise page single-root for Nuxt out-in navigation from the source dialog to a file', () => {
  // Vue Transition requires a component to have one element root:
  // https://vuejs.org/guide/built-ins/transition.html#the-transition-component
  // This page uses the Nuxt out-in transition; UI07 retains the actual SPA failure.
  const filename = resolve(process.cwd(), 'pages/enterprises/[id].vue')
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
  expect(errors).toEqual([])
  const roots = descriptor.template!.ast!.children.filter(node => node.type !== 3 && !(node.type === 2 && !node.content.trim()))
  expect(roots.map(node => node.type === 1 ? node.tag : '#non-element')).toEqual(['div'])
})

// Schema-valid source fixtures: event_process/context_only and
// event_export_context/current_snapshot_context are separate public branches.
function r4Source(status: 'confirmed' | 'candidate'): SourceResponse {
  const publishedName: OfficialPublishedFact = { evidenceId: 1, eventId: 9, revision: 1, availability: 'captured', nameRaw: '2024公布原名', sourceBindingKnown: true }
  const event: EventSource = { ...source().source, evidence: [{ ...source().source.evidence[0]!, publishedName }],
    publishedPresentation: { availability: 'available', error: null, facts: [publishedName] } }
  const relation: NonNullable<CorrespondenceDetail['relation']> = {
    id: 30, queryId: 20, sequenceNo: 1, relationKey: null, enterpriseId: 42,
    usccRaw: null, nameRaw: '平台采集名称', province: null, status: 'success', batch: null,
    declareKind: null, appliedAt: null, awardBatchLabel: null, year: 2026,
    sourceRdjb: '2', sourcePage: 1, rawFields: {}, correspondences: [],
    query: { id: 20, interface: 'apply_list', queryKey: 'synthetic-r4', rdjb: '2', titleCode: 'specialized_sme',
      queriedAt: '2026-10-26T00:00:00Z', status: 'success', failureReason: null, relationCount: 1, collectionEvidence: null },
  }
  const process: CorrespondenceDetail = {
    id: 329, type: 'event_process', role: 'context_only', status, revision: 2, requiresRevalidation: false,
    eventId: 9, predecessorEventId: null, relationId: 30, exportRowId: null, enterpriseId: 42, titleCode: 'specialized_sme',
    ruleId: 'synthetic-r4', ruleVersion: '1', createdAt: '2026-10-26T00:00:00Z', decidedAt: null, endedAt: null,
    event, predecessorEvent: null, relation, exportRow: null,
  }
  const current: CorrespondenceDetail = { ...process, id: 330, type: 'event_export_context', role: 'current_snapshot_context', relationId: null, relation: null,
    exportRowId: 31, exportRow: { id: 31, batchId: 6, sourceRowNo: 1, usccRaw: null, nameRaw: '平台当前名称', district: null,
      province: null, city: null, regStatus: null, rawFields: {}, correspondences: [],
      batch: { id: 6, titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-26', originalFilename: 'synthetic.xlsx',
        sha256: '0'.repeat(64), rowCount: 1, importStatus: 'committed', replacedBatchId: null } } }
  return { source: event, correspondences: [process, current] }
}

describe("formal source consumer boundaries", () => {
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

  const states = [true, false].flatMap(capability => (['confirmed', 'candidate'] as const).map(status => ({ capability, status })))
  it.each(states)('U11 readonly event sources and current never mount decisions or request capability for $status capability=$capability', async ({ capability, status }) => {
    vi.stubGlobal('useState', () => ref(null))
    const api = vi.fn(async (url: string) => url === '/api/roster/evidence-review/browser-context' ? { writeEnabled: capability } : r4Source(status))
    vi.stubGlobal('$fetch', api)
    const wrapper = mount(SourceReader, { props: { kind: 'event', id: 9, readOnly: true }, global: { stubs } }); mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.findAllComponents(CorrespondenceItem)).toHaveLength(2)
    expect(wrapper.get('[aria-label="本记录的平台来源"]').text()).toContain(status === 'confirmed' ? '已确认' : '待确认')
    expect(wrapper.get('[aria-label="当前导出快照"]').text()).toContain('非历史出处')
    expect(wrapper.findAllComponents(CorrespondenceItem).map(item => item.props('readOnly'))).toEqual([true, true])
    expect(wrapper.find('[data-testid="event-correspondence-decision"]').exists()).toBe(false)
    expect(api.mock.calls.filter(([url]) => url === '/api/roster/evidence-review/browser-context')).toHaveLength(0)
  })

  it.each(states.flatMap(state => ['default', 'false'].map(mode => ({ ...state, mode }))))('U12 writable $mode source preserves decision UI for $status capability=$capability', async ({ capability, status, mode }) => {
    vi.stubGlobal('useState', () => ref(null))
    const api = vi.fn(async (url: string) => url === '/api/roster/evidence-review/browser-context' ? { writeEnabled: capability } : r4Source(status))
    vi.stubGlobal('$fetch', api)
    const wrapper = mount(SourceReader, { props: { kind: 'event', id: 9, ...(mode === 'false' ? { readOnly: false } : {}) }, global: { stubs } }); mounted.push(wrapper)
    await flushPromises()
    const decision = wrapper.get('[data-testid="event-correspondence-decision"]')
    expect(api.mock.calls.filter(([url]) => url === '/api/roster/evidence-review/browser-context')).toHaveLength(1)
    if (capability) expect(decision.text()).toContain(status === 'confirmed' ? '取消对应' : '确认对应')
    else { expect(decision.text()).toContain('此页面当前只读'); expect(decision.find('button').exists()).toBe(false) }
    expect(api.mock.calls.every(call => call.length === 1)).toBe(true) // read-only API mocks; no decision submitted
  })

  const currentBack = 'titleCode=specialized_sme&q=Acme&district=鄞州区&page=2'
  const ledgerBack = 'titleCode=specialized_sme&page=4'
  const comparison = '/comparison?mode=record&queryIds=20&page=2'
  async function formal(initial: number, context: 'current' | 'back' | 'comparison') {
    const payload = r4Source('confirmed'), event = payload.source as EventSource
    const record = { ...event.record, district: '鄞州区', nameRaw: null }
    const detail = { enterprise: { enterpriseId: 42, name: '合成企业', uscc: '91330211255994457P', district: '鄞州区' },
      aliases: [], records: [record], events: [event, { ...event, id: 10 }], evidence: [{ ...event.evidence[0]!, eventId: 9 }],
      recognitions: [], differences: [], titleAssessments: [], platform: { queries: [], relations: [], businessRecords: [] },
      publishedPresentation: event.publishedPresentation }
    const api = vi.fn(async (url: string) => {
      if (url === '/api/roster/enterprises/42') return detail
      if (url === '/api/roster/evidence-impacts') return { rows: [], nextCursor: null }
      if (url === '/api/roster/correspondences') return { rows: payload.correspondences.map(({ event, predecessorEvent, relation, exportRow, ...summary }) => summary), total: 2, page: 1, pageSize: 200 }
      if (url === '/api/roster/correspondences/329') return payload.correspondences[0]
      if (url === '/api/roster/correspondences/330') return payload.correspondences[1]
      if (url === '/api/roster/correspondences/events/9') return payload
      throw new Error('Unregistered R4 read ' + url)
    })
    vi.stubGlobal('$fetch', api)
    vi.stubGlobal('useRoute', routerUseRoute)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/enterprises/:id', component: EnterprisePage }, { path: '/:pathMatch(.*)*', component: { template: '<p>返回页</p>' } }] })
    const query = context === 'current' ? { currentBack, back: ledgerBack, returnTo: comparison } : context === 'back' ? { back: ledgerBack } : { returnTo: comparison }
    await router.push({ path: '/enterprises/42', query: { ...query, eventId: String(initial) } })
    const wrapper = mount(defineComponent({ render: () => h(RouterView) }), { attachTo: document.body,
      global: { plugins: [createPinia(), PiniaColada, router], components: { NuxtLink: RouterLink }, stubs: {
        PageHeader: { template: '<header><slot name="breadcrumb" /></header>' }, FilePreviewDialog: true,
        EnterpriseLaterProcesses: true, EnterpriseExplanations: true, PlatformRecords: true, EventCorrespondenceReview: true,
        TitleBadge: true, SourceChip: true, EventChip: true,
      } } }); mounted.push(wrapper)
    await flushPromises()
    const row = wrapper.get('#record-event-9')
    const trigger = row.findAll('button').find(button => button.text() === '来源记录')!
    if (trigger.attributes('aria-expanded') !== 'true') await trigger.trigger('click')
    await flushPromises()
    const owner = row.element.closest('li')
    expect(owner).not.toBeNull()
    const sourceButtons = new DOMWrapper(owner!).findAll('button').filter(button => button.text() === '查看正式来源')
    expect(sourceButtons).toHaveLength(1)
    await sourceButtons[0]!.trigger('click')
    await flushPromises()
    const dialogs = document.querySelectorAll('[role="dialog"] [data-testid="record-source-reader"]')
    expect(dialogs).toHaveLength(1)
    return { wrapper, router, reader: dialogs[0]!, api }
  }

  const links = [
    { branch: 'sources', selector: '[aria-label="本记录的平台来源"] [data-correspondence-id="329"] a' },
    { branch: 'current', selector: '[aria-label="当前导出快照"] [data-correspondence-id="330"] a' },
  ]
  it.each(links.flatMap(link => (['current', 'back', 'comparison'] as const).flatMap(context => [9, 10].map(initial => ({ ...link, context, initial })))))('U13 formal $branch returns from event $initial preserving $context and PDF back independently', async ({ selector, context, initial }) => {
    const { wrapper, router, reader } = await formal(initial, context), departure = router.currentRoute.value.fullPath
    const file = new URL(reader.querySelector('[data-testid="official-evidence"] a')!.getAttribute('href')!, 'http://local.invalid')
    expect(file.pathname).toBe('/preview'); expect(file.searchParams.get('file')).toBe('synthetic.pdf'); expect(file.searchParams.get('page')).toBe('1'); expect(file.searchParams.get('back')).toBe(departure)
    const link = reader.querySelector(selector) as HTMLAnchorElement
    expect(link).not.toBeNull()
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    await flushPromises()
    const expectedQuery = { ...(context === 'current' ? { currentBack, back: ledgerBack, returnTo: comparison } : context === 'back' ? { back: ledgerBack } : { returnTo: comparison }), eventId: '9' }
    expect(router.currentRoute.value.query).toEqual(expectedQuery)
    await vi.waitFor(() => expect(wrapper.get('#record-event-9').attributes('data-highlighted')).toBe('true'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const breadcrumb = wrapper.get('header a')
    const expectedBack = context === 'current' ? { path: '/current-enterprises', query: { titleCode: 'specialized_sme', q: 'Acme', district: '鄞州区', page: '2' } } : context === 'back' ? { path: '/', query: { titleCode: 'specialized_sme', page: '4' } } : comparison
    expect(breadcrumb.attributes('href')).toBe(router.resolve(expectedBack).href)
    await breadcrumb.trigger('click', { button: 0 }); await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(router.resolve(expectedBack).fullPath)
  })

  it.each([{ name: 'ctrl', ctrlKey: true }, { name: 'meta', metaKey: true }, { name: 'shift', shiftKey: true }, { name: 'alt', altKey: true }, { name: 'middle', button: 1 }, { name: 'target', target: '_blank' }])('U14 formal event link keeps NuxtLink modifier behavior for $name', async ({ name, target, ...options }) => {
    const { router, reader } = await formal(10, 'current'), before = router.currentRoute.value.fullPath
    const link = reader.querySelector(links[0]!.selector) as HTMLAnchorElement
    if (target) link.setAttribute('target', target)
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true, ...options }))
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(before)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(new URL(link.href).searchParams.get('currentBack')).toBe(currentBack)
  })

  it('U15 old source consumers retain comparison returnTo when no event query adapter is supplied', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => r4Source('confirmed')))
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<p />' } }] })
    await router.push(comparison)
    const wrapper = mount(SourceReader, { props: { kind: 'event', id: 9, returnTo: comparison }, global: { plugins: [router], components: { NuxtLink: RouterLink } } }); mounted.push(wrapper)
    await flushPromises()
    await wrapper.get(links[0]!.selector).trigger('click', { button: 0 }); await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ eventId: '9', returnTo: comparison })
    expect(wrapper.emitted('event-navigate')).toEqual([[9]])
  })
})
