// @vitest-environment happy-dom
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { computed, defineComponent, nextTick, provide, ref } from 'vue'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import EvidenceReviewForm from '../components/evidence-review/EvidenceReviewForm.vue'
import { REVIEW_DRAFTS_KEY, useReviewDrafts } from '../composables/useReviewDrafts'
import { Select } from '../components/ui/select'
const detail = { id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', decisionId: 82, lineage: 'current', pending: true, oldDecision: { id: 82, reasonNote: '原决定' }, currentDecision: { versionId: 82, current: { id: 82 } }, evidenceToken: { latestRevisionId: 9, decisionId: 82, projectionReady: true }, gaps: {} }
const CONTEXT = '/api/roster/evidence-review/browser-context'
const COMMAND = '/api/roster/evidence-review/browser-commands'
enableAutoUnmount(afterEach)
let fetcher: ReturnType<typeof vi.fn>
let command: ReturnType<typeof vi.fn>
let contextEnabled = true
beforeEach(() => {
  contextEnabled = true
  command = vi.fn().mockResolvedValue({ reviewedRevisionId: 9 })
  fetcher = vi.fn(async (url: string, options?: unknown) => {
    if (url === CONTEXT) return { writeEnabled: contextEnabled }
    if (url === COMMAND) return (command as unknown as (url: string, options?: unknown) => unknown)(url, options)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('$fetch', fetcher)
})
afterEach(() => vi.unstubAllGlobals())
async function render(patch = {}) {
  const pinia = createPinia()
  const view = mount(EvidenceReviewForm, { props: { detail: { ...detail, ...patch } as any }, global: { plugins: [pinia, PiniaColada] } })
  await flushPromises()
  return view
}
function selectByLabel(view: ReturnType<typeof mount>, label: string) {
  const select = view.findAllComponents(Select).find(candidate => candidate.find(`[aria-label="${label}"]`).exists())
  if (!select) throw new Error(`Select not found: ${label}`)
  return select
}
async function fill(view: ReturnType<typeof mount>) {
  await view.get('[aria-label="复核依据"]').setValue('核对新查询并保留原业务判断')
}
it('keeps the sheet primary action outside the scroll body and bound to the same form', async () => {
  const Host = defineComponent({
    components: { EvidenceReviewForm },
    setup: () => ({ detail }),
    template: '<div><div id="review-sheet-footer" /><EvidenceReviewForm :detail="detail" footer /></div>',
  })
  const view = mount(Host, { attachTo: document.body, global: { plugins: [createPinia(), PiniaColada] } })
  await flushPromises()
  await nextTick()
  const form = view.get('form')
  const submit = view.find('#review-sheet-footer button[type="submit"]')
  expect(submit.exists()).toBe(true)
  expect(submit.attributes('form')).toBe(form.attributes('id'))
  expect(view.findAll('button[type="submit"]')).toHaveLength(1)
  view.unmount()
})
it('keeps the failed page-submit reason visible and focused inside the sheet footer without clearing the basis', async () => {
  command.mockRejectedValueOnce({ data: { error: { code: 'unauthorized', message: 'Bearer synthetic-token' } } })
  const Host = defineComponent({
    components: { EvidenceReviewForm },
    setup: () => ({ detail }),
    template: '<div><div id="review-sheet-footer" /><EvidenceReviewForm :detail="detail" footer /></div>',
  })
  const view = mount(Host, { attachTo: document.body, global: { plugins: [createPinia(), PiniaColada] } })
  await flushPromises()
  await fill(view)
  await view.get('form').trigger('submit')
  await flushPromises()
  const errors = view.findAll('[data-testid="review-save-error"]')
  expect(errors).toHaveLength(1)
  expect(view.get('#review-sheet-footer [data-testid="review-save-error"]').text()).toContain('页面提交未开启或授权已失效')
  expect(view.get('#review-sheet-footer [data-testid="review-save-error"]').text()).not.toContain('凭证已清空')
  expect(document.activeElement).toBe(errors[0]!.element)
  expect(view.find('[aria-label="写入凭证"]').exists()).toBe(false)
  expect(view.find('[aria-label="复核人"]').exists()).toBe(false)
  expect(view.find('[aria-label="规则版本"]').exists()).toBe(false)
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  const first = command.mock.calls[0]![1].body
  await view.get('form').trigger('submit')
  await flushPromises()
  expect(command.mock.calls[1]![1].body).toEqual(first)
  expect(command.mock.calls[1]![1].body.idempotencyKey).toBe(first.idempotencyKey)
  view.unmount()
})

it('shows a single read-only line without technical inputs when the deployment capability is off', async () => {
  contextEnabled = false
  const view = await render()
  expect(view.text()).toContain('复核暂为只读：尚未开启页面提交。')
  expect(view.find('[aria-label="写入凭证"]').exists()).toBe(false)
  expect(view.find('[aria-label="复核人"]').exists()).toBe(false)
  expect(view.find('[aria-label="规则版本"]').exists()).toBe(false)
  await fill(view)
  await view.get('form').trigger('submit')
  expect(command).not.toHaveBeenCalled()
  expect(view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
})
it('shows a loading state and a fail-closed state with an explicit retry', async () => {
  let resolveContext: (value: unknown) => void = () => {}
  fetcher.mockImplementationOnce(() => new Promise(resolve => { resolveContext = resolve }))
  const pending = mount(EvidenceReviewForm, { props: { detail: detail as any }, global: { plugins: [createPinia(), PiniaColada] } })
  expect(pending.text()).toContain('正在确认页面提交是否已开启')
  expect(pending.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  resolveContext({ writeEnabled: true })
  await flushPromises()
  expect(pending.text()).not.toContain('正在确认页面提交是否已开启')
  pending.unmount()

  fetcher.mockImplementationOnce(() => Promise.reject(new Error('synthetic context failure')))
  const failed = mount(EvidenceReviewForm, { props: { detail: detail as any }, global: { plugins: [createPinia(), PiniaColada] } })
  await flushPromises()
  expect(failed.text()).toContain('复核暂为只读：无法确认页面提交是否已开启。')
  expect(failed.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  await failed.get('[data-testid="review-write-status"] button').trigger('click')
  await flushPromises()
  expect(failed.text()).not.toContain('无法确认页面提交是否已开启')
  failed.unmount()
})
it('maintains the exact decision with live evidence and no replacement reason and sends no identity fields', async () => {
  const view = await render(); await fill(view)
  await view.get('form').trigger('submit'); await flushPromises()
  expect(fetcher).toHaveBeenCalledWith(COMMAND, expect.objectContaining({ method: 'POST', body: expect.objectContaining({ action: 'maintain', enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', expectedCurrentId: 82, reviewedEvidence: { latestRevisionId: 9, projectionReady: true } }) }))
  const options = command.mock.calls[0]![1]
  expect(options.headers).toBeUndefined()
  expect(options.body).not.toHaveProperty('actor')
  expect(options.body).not.toHaveProperty('ruleVersion')
  expect(options.body).not.toHaveProperty('decision')
  expect(view.emitted('saved')).toHaveLength(1)
  expect(view.html()).not.toContain('Bearer')
})
it('preserves pending and the draft on failure and reuses the same retry envelope', async () => {
  command.mockRejectedValueOnce({ data: { error: { code: 'transaction_failed', message: 'Bearer synthetic-token' } } })
  const view = await render(); await fill(view)
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain('待复核状态保留')
  expect(view.text()).not.toContain('Bearer synthetic-token')
  expect(view.emitted('saved')).toBeUndefined()
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  const first = command.mock.calls[0]![1].body
  await view.get('form').trigger('submit'); await flushPromises()
  expect(command.mock.calls[1]![1].body).toEqual(first)
  expect(view.emitted('saved')).toHaveLength(1)
})
it.each([{ code: 'stale_version', message: '决定版本冲突' }, { code: 'stale_evidence', message: '证据版本冲突' }])('requires a live reread after $code without completing the pending item', async ({ code, message }) => {
  command.mockRejectedValueOnce({ data: { error: { code } } })
  const view = await render(); await fill(view); await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain(message)
  expect(view.emitted('saved')).toBeUndefined()
  expect(view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  await view.get('button[type="button"]').trigger('click')
  expect(view.emitted('reload')).toHaveLength(1)
  await view.setProps({ detail: { ...detail, evidenceToken: { ...detail.evidenceToken, latestRevisionId: 10 } } as any })
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(command.mock.calls[1]![1].body.reviewedEvidence.latestRevisionId).toBe(10)
})
it('appends an explicit correction without selecting a reason automatically', async () => {
  const view = await render(); await fill(view)
  await view.get('[value="replace"]').setValue(true)
  expect(selectByLabel(view, '更正原因').props('modelValue')).toBe('__unset')
  expect(view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  // 两个 Select 各自通过 defineModel 回写同一 draft；分两次刷新，避免后一次用旧对象覆盖前一次。
  selectByLabel(view, '更正原因').vm.$emit('update:modelValue', 'other')
  await flushPromises()
  selectByLabel(view, '更正措施').vm.$emit('update:modelValue', 'none')
  await flushPromises()
  await view.get('[aria-label="原因说明"]').setValue('人工核验后的更正')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(command.mock.calls[0]![1].body).toMatchObject({ action: 'replace', expectedCurrentId: 82, reviewedEvidence: { latestRevisionId: 9, projectionReady: true }, decision: { status: 'confirmed_reason', reasonCode: 'other', reasonNote: '人工核验后的更正', measureCode: 'none', verificationStatus: 'confirmed' } })
  expect(command.mock.calls[0]![1].body).not.toHaveProperty('actor')
  expect(command.mock.calls[0]![1].body).not.toHaveProperty('ruleVersion')
})
it('retains the basis when the page submit is rejected and leaves public reads intact', async () => {
  command.mockRejectedValueOnce({ data: { error: { code: 'unauthorized', message: 'synthetic-token' } } })
  const view = await render(); await fill(view); await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain('页面提交未开启或授权已失效')
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  expect(view.emitted('saved')).toBeUndefined()
})
it.each([{ lineage: 'historical' }, { lineage: 'withdrawn' }, { lineage: 'merged' }])('does not submit a $lineage owner', async ({ lineage }) => {
  const view = await render({ lineage }); await fill(view); await view.get('form').trigger('submit')
  expect(command).not.toHaveBeenCalled()
})
it('does not clear the business draft on pagehide because it holds no secret', async () => {
  const view = await render(); await fill(view)
  window.dispatchEvent(new Event('pagehide'))
  await flushPromises()
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  await view.get('form').trigger('submit')
  await flushPromises()
  expect(command).toHaveBeenCalledTimes(1)
  view.unmount()
})
it('keeps unprocessed evidence read-only', async () => {
  const view = await render({ evidenceToken: { ...detail.evidenceToken, projectionReady: false } }); await fill(view)
  await view.get('form').trigger('submit')
  expect(command).not.toHaveBeenCalled()
  expect(view.text()).toContain('尚未完成影响检查')
  expect(view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
})

it('removes the teleported footer action and resets the draft flag when the form unmounts', async () => {
  const footer = document.createElement('div')
  footer.id = 'review-sheet-footer'
  document.body.appendChild(footer)
  const draft = ref(true)
  const view = mount(EvidenceReviewForm, {
    props: { detail: detail as any, footer: true },
    attachTo: document.body,
    global: { plugins: [createPinia(), PiniaColada], provide: { 'enterprise-review-draft': draft } },
  })
  await flushPromises()
  await nextTick()
  expect(footer.querySelector('button[type="submit"]')).toBeTruthy()
  view.unmount()
  await nextTick()
  expect(footer.childElementCount).toBe(0)
  expect(draft.value).toBe(false)
  footer.remove()
})


function mountStored() {
  const show = ref(true)
  let store: ReturnType<typeof useReviewDrafts>
  const Host = defineComponent({
    components: { EvidenceReviewForm },
    setup() {
      store = useReviewDrafts()
      provide(REVIEW_DRAFTS_KEY, store)
      const dirty = computed(() => store.hasDirty.value)
      return { detail, show, dirty }
    },
    template: '<div><button id="toggle" @click="show = !show">toggle</button><span id="dirty">{{ dirty }}</span><EvidenceReviewForm v-if="show" :detail="detail" /></div>',
  })
  const view = mount(Host, { global: { plugins: [createPinia(), PiniaColada] } })
  return { view, store: () => store, show }
}

it('keeps an in-memory business draft across structural unmount and clears it only on discard', async () => {
  const { view, store, show } = mountStored()
  await flushPromises()
  await fill(view)
  expect(view.get('#dirty').text()).toBe('true')
  show.value = false
  await nextTick()
  show.value = true
  await nextTick(); await flushPromises()
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')

  window.dispatchEvent(new Event('pagehide'))
  await flushPromises()
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  expect(store().hasDraft(4)).toBe(true)

  store().discard(4)
  await flushPromises()
  show.value = false
  await nextTick()
  show.value = true
  await nextTick(); await flushPromises()
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toBe('')
  view.unmount()
})

it('shows the decision-under-review role in the form heading instead of a fixed original-decision label', async () => {
  const view = await render()
  expect(view.text()).toContain('待复核的当前决定 #82')
  expect(view.text()).not.toContain('复核原决定')
})

it('keeps the inline page-submit failure and retry action in the same form without a footer', async () => {
  command.mockRejectedValueOnce({ data: { error: { code: 'unauthorized' } } })
  const view = await render(); await fill(view)
  await view.get('form').trigger('submit'); await flushPromises()
  const error = view.get('[data-testid="review-save-error"]')
  expect(error.text()).toContain('页面提交未开启或授权已失效')
  expect(error.classes()).toContain('scroll-mt-14')
  expect(view.find('button[type="submit"]').exists()).toBe(true)
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toContain('核对新查询')
  view.unmount()
})

it('freezes an accepted command after response loss across close and structural remount and never writes after receipt', async () => {
  const accepted: any[] = []
  command.mockImplementation(async (_url: string, options: any) => {
    const body = JSON.parse(JSON.stringify(options.body))
    if (!accepted.length) { accepted.push(body); throw new Error('response lost after acceptance') }
    expect(body).toEqual(accepted[0])
    return { action: 'maintain', versionId: 82 }
  })
  const Host = defineComponent({
    components: { EvidenceReviewForm },
    setup() { const store = useReviewDrafts(); provide(REVIEW_DRAFTS_KEY, store); return { detail, shown: ref(true), discard: () => store.discard(4) } },
    template: '<div><button @click="shown = !shown">关闭或重开</button><button @click="discard">丢弃草稿</button><EvidenceReviewForm v-if="shown" :detail="detail" /></div>',
  })
  const view = mount(Host, { global: { plugins: [createPinia(), PiniaColada] } })
  await flushPromises(); await fill(view); await view.get('form').trigger('submit'); await flushPromises()
  expect(view.text()).toContain('提交结果未知')
  expect(view.text()).not.toContain('保存失败，待复核状态保留')
  expect(view.get('[aria-label="复核依据"]').element.closest('fieldset')!.disabled).toBe(true)
  const toggle = async () => { await view.findAll('button').find(b => b.text() === '关闭或重开')!.trigger('click'); await flushPromises() }
  await toggle(); await view.findAll('button').find(b => b.text() === '丢弃草稿')!.trigger('click'); await toggle()
  expect(view.text()).toContain('提交结果未知')
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toBe('核对新查询并保留原业务判断')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(command).toHaveBeenCalledTimes(2)
  await toggle(); await toggle()
  expect(view.text()).toContain('复核已提交')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(command).toHaveBeenCalledTimes(2)
})

it('allows reviewing a later evidence revision without reopening the already committed revision', async () => {
  const view = await render(); await fill(view); await view.get('form').trigger('submit'); await flushPromises()
  expect(view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  await view.setProps({ detail: { ...detail, evidenceToken: { ...detail.evidenceToken, latestRevisionId: 10 } } as any })
  await fill(view); await view.get('form').trigger('submit'); await flushPromises()
  expect(command).toHaveBeenCalledTimes(2)
  expect(command.mock.calls[1]![1].body.reviewedEvidence.latestRevisionId).toBe(10)
  expect(command.mock.calls[1]![1].body.idempotencyKey).not.toBe(command.mock.calls[0]![1].body.idempotencyKey)
})
