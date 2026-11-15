// @vitest-environment jsdom
import { DOMWrapper, mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import Form from '../../../components/enterprise/InitialDifferenceDecisionForm.vue'
import Sheet from '../../../components/enterprise/EnterpriseEvidenceSheet.vue'
import Fields from '../../../components/evidence-review/ReplacementDecisionFields.vue'
import { Select } from '../../../components/ui/select'

const scope = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const assessment = { currentDecision: { ...scope, versionId: null, current: null }, queryCoverage: { status: 'complete', sources: [], truncated: false }, assessment: 'queried_unjudged', explanationValidity: { status: 'not_applicable', reasons: [] } }
enableAutoUnmount(afterEach)
afterEach(() => vi.unstubAllGlobals())
const root = () => new DOMWrapper(document.body)
const button = (name: string) => root().findAll('button').find(b => b.text() === name)!
function render(sheet = true, capability: { writeEnabled?: boolean } = { writeEnabled: true }) {
  let body: any = null, postResult: Promise<unknown> | null = null
  const post = vi.fn(async (value: any) => { body = value; return postResult ?? { versionId: 9 } })
  const fetcher = vi.fn(async (url: string, options?: any) => {
    if (url.endsWith('browser-context')) return capability
    if (url.endsWith('browser-commands')) return post(options.body)
    const version = body ? { ...scope, id: 9, ...body.decision, basis: body.basis, actor: null, ruleVersion: null, isCurrent: true } : null
    if (url.endsWith('/current')) return { ...scope, versionId: version?.id ?? null, current: version }
    if (url.endsWith('/9')) return version
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw Error('Unexpected request: ' + url)
  })
  vi.stubGlobal('$fetch', fetcher)
  const view = sheet
    ? mount(Sheet, { props: { open: true, ...scope, assessment: assessment as any }, attachTo: document.body, global: { plugins: [createPinia(), PiniaColada] } })
    : mount(Form, { props: { scope }, attachTo: document.body, global: { plugins: [createPinia(), PiniaColada] } })
  return { view, post, fetcher, pending: (value: Promise<unknown>) => { postResult = value } }
}
async function choose(view: ReturnType<typeof mount>, label: string, value: string) {
  view.findAllComponents(Select).find(c => c.find(`[aria-label="${label}"]`).exists())!.vm.$emit('update:modelValue', value)
  await flushPromises()
}
async function fill(h: ReturnType<typeof render>) {
  await flushPromises(); await button('登记差异判断').trigger('click'); await flushPromises()
  await root().get('[aria-label="判断依据"]').setValue('核对原始公布材料')
  await choose(h.view, '更正结论', 'confirmed_no_diff'); await choose(h.view, '更正措施', 'none')
}
it('labels the optional no-difference note consistently for shared consumers and preserves the reason label', async () => {
  const draft = { status: 'confirmed_no_diff', reasonCode: '', reasonNote: '保留合法说明', measureCode: 'none', measureNote: '', evidenceQueryId: '', evidenceRelationId: '' }
  const v = mount(Fields, { props: { modelValue: draft } })
  expect(v.get('[aria-label="无差异补充说明（可选）"]').element).toHaveProperty('value', '保留合法说明')
  expect(v.text()).toContain('无需选择差异原因')
  expect(v.text()).not.toContain('不填写原因')
  await v.setProps({ modelValue: { ...draft, status: 'confirmed_reason', reasonCode: 'other' } })
  expect(v.get('[aria-label="原因说明"]').element).toHaveProperty('value', draft.reasonNote)
  expect(v.find('[aria-label="无差异补充说明（可选）"]').exists()).toBe(false)
})
it('submits the sole real Sheet form from its external footer and reads back the optional note with a neutral first receipt', async () => {
  const h = render(); await fill(h)
  await root().get('[aria-label="无差异补充说明（可选）"]').setValue('核对后补充的原始说明')
  const footer = root().get('#review-sheet-footer'), submit = footer.get('button[type="submit"]')
  const form = root().get('form').element as HTMLFormElement
  expect(root().findAll('form')).toHaveLength(1); expect(root().findAll('button[type="submit"]')).toHaveLength(1)
  expect((submit.element as HTMLButtonElement).form).toBe(form)
  expect(footer.element.closest('.overflow-y-auto')).toBeNull()
  expect(form.closest('.overflow-y-auto')).not.toBeNull()
  expect(form.contains(submit.element)).toBe(false)
  await submit.trigger('click'); await flushPromises()
  expect(h.post).toHaveBeenCalledTimes(1)
  expect(h.post.mock.calls[0]![0]).toMatchObject({ ...scope, expectedCurrentId: null, decision: { status: 'confirmed_no_diff', reasonCode: null, reasonNote: '核对后补充的原始说明', measureCode: 'none' } })
  expect(footer.text()).toContain('已提交并读回当前决定 #9；本次版本已核实。')
  expect(footer.text()).not.toContain('原决定和历史保留')
  expect(root().get('[data-testid="decision-version"]').text()).toContain('核对后补充的原始说明')
  expect(root().find('button[type="submit"]').exists()).toBe(false)
})
it('keeps inline submission and feedback in ordinary flow without a Sheet target', async () => {
  const h = render(false); await fill(h)
  expect(root().find('#review-sheet-footer').exists()).toBe(false)
  const submit = root().get('button[type="submit"]')
  expect((submit.element as HTMLButtonElement).form).toBe(root().get('form').element)
  await submit.trigger('click'); await flushPromises()
  expect(h.post).toHaveBeenCalledTimes(1); expect(h.view.text()).toContain('本次版本已核实。')
})
it('keeps pending and unknown feedback in the footer and retries only the frozen original request', async () => {
  const h = render(); await fill(h)
  let reject!: (e: Error) => void
  h.pending(new Promise((_, no) => { reject = no }))
  await root().get('#review-sheet-footer button[type="submit"]').trigger('click'); await flushPromises()
  expect(button('正在提交…').attributes('disabled')).toBeDefined()
  await button('正在提交…').trigger('click'); expect(h.post).toHaveBeenCalledTimes(1)
  reject(Error('response lost')); await flushPromises()
  const footer = root().get('#review-sheet-footer')
  expect(footer.get('[role="status"]').text()).toContain('提交结果尚不能确认')
  expect((root().get('form fieldset').element as HTMLFieldSetElement).disabled).toBe(true)
  h.pending(Promise.resolve({ versionId: 9 }))
  await button('重试同一次提交').trigger('click'); await flushPromises()
  expect(h.post).toHaveBeenCalledTimes(2); expect(h.post.mock.calls[1]![0]).toEqual(h.post.mock.calls[0]![0])
  h.view.unmount(); await flushPromises(); expect(root().find('#review-sheet-footer button').exists()).toBe(false)
})
it.each([{ name: 'disabled', capability: { writeEnabled: false } }, { name: 'unknown', capability: {} }])('leaves the real Sheet read-only without a submit action for capability $name', async ({ capability }) => {
  const h = render(true, capability); await flushPromises()
  expect(root().text()).toContain('差异判断暂为只读')
  expect(root().find('form').exists()).toBe(false); expect(root().find('button[type="submit"]').exists()).toBe(false)
  expect(h.post).not.toHaveBeenCalled()
})
