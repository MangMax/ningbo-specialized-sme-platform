// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import FactReferences from '../../../components/enterprise/EnterpriseFactReferences.vue'
import EvidenceReviewForm from '../../../components/evidence-review/EvidenceReviewForm.vue'
import InitialForm from '../../../components/enterprise/InitialDifferenceDecisionForm.vue'
import { Select } from '../../../components/ui/select'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { defineComponent, provide } from 'vue'
import { REVIEW_DRAFTS_KEY, useReviewDrafts } from '../../../composables/useReviewDrafts'
import { createInitialDecisionState, useInitialDifferenceDecision } from '../../../composables/useInitialDifferenceDecision'
const views: VueWrapper[] = []
afterEach(() => { for (const v of views.splice(0)) v.unmount(); vi.unstubAllGlobals() })
const pin = (factId: number, revision = 2) => ({ enterpriseId: 7, factId, revision, kind: factId === 2 ? 'cancelled' : 'moved_out' })
function row(factId: number, revision = 2, status = 'confirmed', statement = `原文${factId}`) { return { factId, revision, status, fact: { kind: factId === 2 ? 'cancelled' : 'moved_out', source: { reference: `来源${factId}`, statement }, effective: { precision: 'year', value: '2024' } } } }
function mountView(props: Record<string, unknown>) { const v = mount(FactReferences, { props: { enterpriseId: 7, modelValue: [], editable: true, ...props } }); views.push(v); return v }
it('selects multiple confirmed facts as exact hidden pins without offering pending or withdrawn facts', async () => {
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ facts: [row(1), row(2, 4), row(3, 1, 'pending'), row(4, 3, 'withdrawn')], history: [] }))
  const v = mountView({}); await flushPromises()
  expect(v.findAll('[role="checkbox"]')).toHaveLength(2)
  await v.findAll('[role="checkbox"]')[0]!.trigger('click'); await v.setProps({ modelValue: [pin(1)] })
  await v.findAll('[role="checkbox"]')[1]!.trigger('click')
  expect(v.emitted('update:modelValue')!.at(-1)).toEqual([[pin(1), pin(2, 4)]])
  expect(v.text()).toContain('原文1'); expect(v.text()).toContain('来源2')
  expect(v.find('input[type="number"]').exists()).toBe(false)
})
it('shows the exact pinned historical snapshot after withdrawal without resolving to a newer fact revision', async () => {
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ facts: [row(1, 3, 'withdrawn', '后来撤回')], history: [row(1, 2, 'confirmed', '当时确认原文'), row(1, 3, 'withdrawn', '后来撤回')] }))
  const v = mountView({ modelValue: [pin(1)], editable: false }); await flushPromises()
  expect(v.text()).toContain('当时确认原文'); expect(v.text()).not.toContain('后来撤回')
  expect(v.find('[role="checkbox"]').exists()).toBe(false)
  expect(v.emitted('update:modelValue')).toBeUndefined()
})
it('retains selected references across a failed read and explicit retry without claiming no facts', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ facts: [row(1)], history: [row(1)] }); vi.stubGlobal('$fetch', fetcher)
  const v = mountView({ modelValue: [pin(1)] }); await flushPromises()
  expect(v.text()).toContain('主体事实读取失败'); expect(v.text()).not.toContain('暂无可关联')
  expect(v.emitted('validity')!.at(-1)).toEqual([false])
  await v.get('button[data-testid="fact-references-retry"]').trigger('click'); await flushPromises()
  expect(v.text()).toContain('原文1'); expect(v.emitted('validity')!.at(-1)).toEqual([true])
  expect(v.emitted('update:modelValue')).toBeUndefined()
})
it('never silently upgrades an old selected pin to a newer confirmed revision', async () => {
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ facts: [row(1, 3, 'confirmed', '新原文')], history: [row(1, 2, 'confirmed', '旧原文'), row(1, 3, 'confirmed', '新原文')] }))
  const v = mountView({ modelValue: [pin(1)] }); await flushPromises()
  expect(v.text()).toContain('旧原文'); expect(v.text()).toContain('已变化')
  expect(v.emitted('validity')!.at(-1)).toEqual([false]); expect(v.emitted('update:modelValue')).toBeUndefined()
})
const scope = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const plugins = () => [createPinia(), PiniaColada]
async function choose(v: VueWrapper, label: string, value: string) {
  const select = v.findAllComponents(Select).find(c => c.find(`[aria-label="${label}"]`).exists())!
  select.vm.$emit('update:modelValue', value); await flushPromises()
}
it('keeps inherited correction references and replays an uncertain request after those facts are withdrawn', async () => {
  const refs = [pin(1), pin(2, 4)], command = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ versionId: 83 })
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options: any) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('/facts')) return { facts: [row(1), row(2, 4)], history: [row(1), row(2, 4)] }
    if (url.endsWith('browser-commands')) return command(options.body)
    throw Error(url)
  }))
  const detail = { ...scope, id: 4, decisionId: 82, lineage: 'current', pending: true, oldDecision: { id: 82 }, currentDecision: { ...scope, versionId: 82, current: { ...scope, id: 82, factReferences: refs } }, evidenceToken: { latestRevisionId: 9, decisionId: 82, projectionReady: true }, gaps: {} }
  const v = mount(EvidenceReviewForm, { props: { detail: detail as any }, global: { plugins: plugins() } }); views.push(v); await flushPromises()
  await v.get('[value="replace"]').setValue(true); await flushPromises()
  await v.get('[aria-label="复核依据"]').setValue('依据两个已确认主体事实')
  await choose(v, '更正原因', 'other'); await choose(v, '更正措施', 'none')
  await v.get('form').trigger('submit'); await flushPromises()
  expect(command.mock.calls[0]![0].decision.factReferences).toEqual(refs)
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options: any) => {
    if (url.endsWith('/facts')) return { facts: [row(1, 3, 'withdrawn'), row(2, 5, 'withdrawn')], history: [row(1), row(2, 4)] }
    if (url.endsWith('browser-commands')) return command(options.body)
    throw Error(url)
  }))
  await v.findAll('button').find(b => b.text() === '刷新可关联事实')!.trigger('click'); await flushPromises()
  expect(v.text()).toContain('已有引用已变化')
  await v.get('form').trigger('submit'); await flushPromises()
  expect(command.mock.calls[1]![0]).toEqual(command.mock.calls[0]![0])
})
it('submits multiple chosen facts from the initial explanation form and reads them back in decision details', async () => {
  let saved: any, id: number | null = null
  const version = () => ({ ...scope, id, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none', actor: null, ruleVersion: null, factReferences: saved?.decision.factReferences })
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options: any) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('/facts')) return { facts: [row(1), row(2, 4)], history: [row(1), row(2, 4)] }
    if (url.endsWith('/current')) return { ...scope, versionId: id, current: id == null ? null : version() }
    if (url.endsWith('browser-commands')) { saved = options.body; id = 9; return { versionId: 9 } }
    if (/decision-lifecycle\/\d+$/.test(url)) return version()
    throw Error(url)
  }))
  const v = mount(InitialForm, { props: { scope }, global: { plugins: plugins() } }); views.push(v); await flushPromises()
  await v.findAll('button').find(b => b.text() === '登记差异判断')!.trigger('click'); await flushPromises()
  await v.get('[aria-label="判断依据"]').setValue('依据两个已确认主体事实')
  await choose(v, '更正结论', 'confirmed_reason'); await choose(v, '更正原因', 'other'); await choose(v, '更正措施', 'none')
  for (const box of v.findAll('[role="checkbox"]')) await box.trigger('click')
  await v.get('form').trigger('submit'); await flushPromises()
  expect(saved.decision.factReferences).toEqual([pin(1), pin(2, 4)])
  expect(v.get('[data-testid="decision-version"]').text()).toContain('原文1')
  expect(v.get('[data-testid="decision-version"]').text()).toContain('原文2')
})
it('can replay an already-dispatched request after remount even if its fact reference is now withdrawn', async () => {
  const request = { ...scope, action: 'replace', expectedCurrentId: null, idempotencyKey: 'existing-dispatched-request', basis: '原依据', decision: { status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none', factReferences: [pin(1)] } }
  const post = vi.fn().mockResolvedValue({ versionId: 9 })
  const version = { ...scope, id: 9, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none', factReferences: [pin(1)], actor: null, ruleVersion: null }
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options: any) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('/facts')) return { facts: [row(1, 3, 'withdrawn')], history: [row(1), row(1, 3, 'withdrawn')] }
    if (url.endsWith('browser-commands')) return post(options.body)
    if (url.endsWith('/current')) return { ...scope, versionId: 9, current: version }
    if (/decision-lifecycle\/\d+$/.test(url)) return version
    throw Error(url)
  }))
  const Host = defineComponent({ components: { InitialForm }, setup() {
    const store = useReviewDrafts(); provide(REVIEW_DRAFTS_KEY, store)
    const session = store.initialFor(scope); session.request = request; session.phase = 'unknown'; session.head = { ...scope, versionId: null, current: null }
    session.draft.factReferences = [pin(1)]; return { scope }
  }, template: '<InitialForm :scope="scope" />' })
  const v = mount(Host, { global: { plugins: plugins() } }); views.push(v); await flushPromises()
  expect(v.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
  await v.get('form').trigger('submit'); await flushPromises()
  expect(post).toHaveBeenCalledWith(request); expect(v.text()).toContain('已提交并读回当前决定')
})
it('retains the draft and releases only a rejected fact-reference request for explicit correction', async () => {
  const state = createInitialDecisionState(scope)
  const c = useInitialDifferenceDecision(scope, { context: async () => ({ writeEnabled: true }), current: async () => ({ ...scope, versionId: null, current: null }), post: async () => { throw { statusCode: 422, data: { error: { code: 'fact_reference_mismatch' } } } } }, state)
  await c.load(); state.basis = '原依据'; Object.assign(state.draft, { status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none', factReferences: [pin(1)] })
  await c.save()
  expect(state.phase).toBe('ready'); expect(state.request).toBeNull()
  expect(state.draft.factReferences).toEqual([pin(1)]); expect(state.message).toContain('关联事实已变化')
})
