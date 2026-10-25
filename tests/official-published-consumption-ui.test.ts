// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterLink } from 'vue-router'
import CurrentPage from '../pages/current-enterprises.vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SourceReader from '../components/record-correspondence/SourceReader.vue'
import OfficialEvidence from '../components/record-correspondence/OfficialEvidence.vue'
import { useRecordSource } from '../composables/useRecordSource'
import { refreshCorrespondenceViews } from '../composables/useCorrespondenceReadback'

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

it('U08 shows current confirmed alias and published name independently inside the mobile card with two mounted text branches', async () => {
  const wrapper = await renderCurrent(['已确认旧名']), card = wrapper.get('[data-testid="current-enterprise-card"]')
  expect(card.text()).toContain('新名')
  expect(card.text()).toContain('已确认曾用名：已确认旧名')
  expect(card.text()).toContain('公布名称："公告名"')
  expect(card.text()).not.toContain('待核别名')
  expect(card.findAll('a').filter(a => a.text() === '公布名称："公告名"')).toHaveLength(1)
  expect(wrapper.findAll('a').filter(a => a.text() === '公布名称："公告名"')).toHaveLength(2)
  expect(wrapper.get('table tbody tr').text()).toContain('已确认曾用名：已确认旧名')
})

it('U09 leaves the mobile confirmed alias label absent when no confirmed alias exists', async () => {
  const wrapper = await renderCurrent([]), card = wrapper.get('[data-testid="current-enterprise-card"]')
  expect(card.text()).toContain('新名'); expect(card.text()).toContain('公布名称："公告名"')
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
