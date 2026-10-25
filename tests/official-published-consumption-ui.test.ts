// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
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
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount(); vi.unstubAllGlobals() })

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
