// @vitest-environment happy-dom
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, provide, ref } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import InitialForm from '../components/enterprise/InitialDifferenceDecisionForm.vue'
import { Select } from '../components/ui/select'
import { REVIEW_DRAFTS_KEY, useReviewDrafts } from '../composables/useReviewDrafts'
import { useInitialDifferenceDecision } from '../composables/useInitialDifferenceDecision'

const scope = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const version = (id: number, coordinate = scope) => ({ ...coordinate, id, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history', basis: `版本${id}原依据`, actor: null, ruleVersion: null, isCurrent: id !== 9 })
const head = (id: number | null, coordinate = scope) => ({ ...coordinate, versionId: id, current: id ? { ...version(id, coordinate), isCurrent: true } : null })
enableAutoUnmount(afterEach)
afterEach(() => vi.unstubAllGlobals())
function render(fetcher: ReturnType<typeof vi.fn>) {
  const shown = ref(true), coordinate = ref({ ...scope })
  let store!: ReturnType<typeof useReviewDrafts>
  vi.stubGlobal('$fetch', fetcher)
  const Host = defineComponent({ components: { InitialForm }, setup() { store = useReviewDrafts(); provide(REVIEW_DRAFTS_KEY, store); return { shown, coordinate } }, template: '<InitialForm v-if="shown" :key="JSON.stringify(coordinate)" :scope="coordinate" />' })
  const view = mount(Host, { global: { plugins: [createPinia(), PiniaColada] } })
  return { view, shown, coordinate, store: () => store }
}
const button = (v: ReturnType<typeof mount>, name: string) => {
  const found = v.findAll('button').find(b => b.text() === name)
  if (!found) throw new Error('Missing button: ' + name)
  return found
}
async function fill(v: ReturnType<typeof mount>) {
  await button(v, '登记差异判断').trigger('click')
  await v.get('[aria-label="判断依据"]').setValue('恢复完整业务请求的人工依据')
  for (const [label, value] of [['更正结论', 'confirmed_reason'], ['更正原因', 'other'], ['更正措施', 'keep_history']]) {
    v.findAllComponents(Select).find(c => c.find(`[aria-label="${label}"]`).exists())!.vm.$emit('update:modelValue', value)
    await flushPromises()
  }
}
async function remount(h: ReturnType<typeof render>) {
  h.shown.value = false; await flushPromises(); expect(h.view.findComponent(InitialForm).exists()).toBe(false)
  h.shown.value = true; await flushPromises(); expect(h.view.findComponent(InitialForm).exists()).toBe(true)
}
it('retains unknown body key effectiveAt and locked action across real remount and host discard', async () => {
  const commands: any[] = []; let reads = 0, currentId: number | null = null
  const fetcher = vi.fn(async (url: string, opts?: any) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('/current')) { reads++; return head(currentId) }
    if (url.endsWith('/9')) return version(9)
    if (url.endsWith('browser-commands')) { commands.push(JSON.parse(JSON.stringify(opts.body))); if (commands.length === 1) throw new Error('response lost'); return { versionId: 9 } }
    throw new Error('Unexpected request: ' + url)
  })
  const h = render(fetcher); await flushPromises(); await fill(h.view); await h.view.get('form').trigger('submit'); await flushPromises()
  const original = structuredClone(commands[0]); expect(h.store().hasDirty.value).toBe(true)
  h.store().discardAll(); currentId = 10; await remount(h)
  expect(reads).toBe(1)
  expect(h.view.get('fieldset').attributes('disabled')).toBeDefined()
  expect(h.view.text()).toContain('重试同一次提交')
  await h.view.get('form').trigger('submit'); await flushPromises()
  expect(commands).toEqual([original, original]); expect(h.view.text()).toContain('本次提交版本 #9 已读回')
  expect(h.view.text()).toContain('后续版本 #10 替代'); expect(h.view.text()).not.toContain('已提交并读回当前决定 #10')
  expect(h.store().hasDirty.value).toBe(false)
})
it('retains a known receipt across remount and uses only GET until that exact version is verified', async () => {
  const commands: any[] = []; let blocked = false, currentId: number | null = null
  const fetcher = vi.fn(async (url: string, opts?: any) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('/current')) { if (blocked) throw new Error('readback unavailable'); return head(currentId) }
    if (url.endsWith('/9')) return version(9)
    if (url.endsWith('browser-commands')) { commands.push(JSON.parse(JSON.stringify(opts.body))); blocked = true; return { versionId: 9, currentId: 9, previousId: null, action: 'replace', recordedAt: '2026-10-24T00:00:00Z' } }
    throw new Error('Unexpected request: ' + url)
  })
  const h = render(fetcher); await flushPromises(); await fill(h.view); await h.view.get('form').trigger('submit'); await flushPromises()
  expect(h.store().hasDirty.value).toBe(true); h.store().discardAll(); await remount(h)
  expect(h.view.text()).toContain('回执 #9'); expect(h.view.text()).toContain('待核读回'); expect(commands).toHaveLength(1)
  expect(h.view.find('button[type="submit"]').exists()).toBe(false)
  const session = h.store().drafts['initial:7:specialized_sme:missing_in_miit']!.initialSubmission!
  expect(session.receipt).toMatchObject({ versionId: 9, recordedAt: '2026-10-24T00:00:00Z' }); expect(session.request).toEqual(commands[0])
  blocked = false; currentId = 10; await button(h.view, '重试读取当前决定').trigger('click'); await flushPromises()
  expect(commands).toHaveLength(1); expect(h.view.text()).toContain('本次提交版本 #9 已读回')
  expect(h.view.findAll('[data-testid="decision-version"]')).toHaveLength(2)
  expect(h.store().hasDirty.value).toBe(false)
})
it('keeps an in-flight old-scope receipt isolated and resumes it after switching back', async () => {
  let complete!: (v: { versionId: number }) => void
  const commands: any[] = []; let committed = false
  const fetcher = vi.fn(async (url: string, opts?: any) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('/current')) return head(committed && opts.query.direction === scope.direction ? 9 : null, opts.query)
    if (url.endsWith('/9')) return { ...version(9), isCurrent: true }
    if (url.endsWith('browser-commands')) { commands.push(JSON.parse(JSON.stringify(opts.body))); return new Promise<{ versionId: number }>(resolve => { complete = resolve }) }
    throw new Error('Unexpected request: ' + url)
  })
  const h = render(fetcher); await flushPromises(); await fill(h.view); await h.view.get('form').trigger('submit'); await flushPromises()
  h.coordinate.value = { ...scope, direction: 'extra_in_miit' }; await flushPromises()
  expect(h.view.find('[aria-label="判断依据"]').exists()).toBe(false)
  committed = true; complete({ versionId: 9 }); await flushPromises()
  expect(h.view.text()).not.toContain('本次提交回执 #9')
  h.coordinate.value = { ...scope }; await flushPromises()
  expect(h.view.text()).toContain('本次提交回执 #9'); expect(h.view.text()).toContain('已提交并读回当前决定 #9')
  expect(commands).toHaveLength(1)
  h.view.unmount(); expect(Object.keys(h.store().drafts)).toEqual([])
})
it('does not use a later current as readback when the submitted version is missing or wrong-scope', async () => {
  for (const readVersion of [vi.fn().mockRejectedValue(new Error('404')), vi.fn().mockResolvedValue(version(9, { ...scope, enterpriseId: 8 }))]) {
    let currentId: number | null = null
    const api = { context: async () => ({ writeEnabled: true }), current: async () => head(currentId), version: readVersion, post: vi.fn(async () => ({ versionId: 9 })) }
    const c = useInitialDifferenceDecision(scope, api as any); await c.load(); c.basis.value = '本次版本必须核实'
    Object.assign(c.draft.value, { status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history' })
    currentId = 10; await c.save()
    expect(readVersion).toHaveBeenCalledWith(9); expect(c.phase.value).toBe('readback'); expect(c.dirty.value).toBe(true)
    expect(c.receipt.value?.versionId).toBe(9); await c.save(); expect(api.post).toHaveBeenCalledTimes(1)
  }
})
it('rejects a late nested current from another scope and never clears the unresolved guard', async () => {
  let currentId: number | null = null
  const api = { context: async () => ({ writeEnabled: true }), current: async () => currentId ? { ...head(10), current: version(10, { ...scope, direction: 'extra_in_miit' }) } : head(null), post: vi.fn(async () => ({ versionId: 9 })) }
  const c = useInitialDifferenceDecision(scope, api as any); await c.load(); c.basis.value = '不接受错范围读回'
  Object.assign(c.draft.value, { status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history' }); currentId = 10
  await c.save(); expect(c.phase.value).toBe('readback'); expect(c.dirty.value).toBe(true)
  expect(c.head.value?.versionId).toBeNull()
})
it('isolates a late current readback across a scope switch and verifies its own historical version on return', async () => {
  let release!: (value: ReturnType<typeof head>) => void
  let afterPost = false
  const commands: any[] = []
  const fetcher = vi.fn(async (url: string, opts?: any) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('/current')) {
      if (afterPost && opts.query.direction === scope.direction) return new Promise<ReturnType<typeof head>>(resolve => { release = resolve })
      return head(commands.length && opts.query.direction === scope.direction ? 10 : null, opts.query)
    }
    if (url.endsWith('/9')) return version(9)
    if (url.endsWith('browser-commands')) { commands.push(JSON.parse(JSON.stringify(opts.body))); afterPost = true; return { versionId: 9 } }
    throw new Error('Unexpected request: ' + url)
  })
  const h = render(fetcher); await flushPromises(); await fill(h.view); await h.view.get('form').trigger('submit'); await flushPromises()
  h.coordinate.value = { ...scope, direction: 'extra_in_miit' }; await flushPromises()
  release(head(10)); await flushPromises()
  expect(h.view.text()).not.toContain('本次提交回执 #9')
  afterPost = false; h.coordinate.value = { ...scope }; await flushPromises()
  expect(h.view.text()).toContain('本次提交版本 #9 已读回')
  expect(h.view.text()).toContain('后续版本 #10 替代')
  expect(commands).toHaveLength(1)
})
it('requires an explicit new human correction before ending a verified superseded request', async () => {
  let currentId: number | null = null
  const post = vi.fn(async () => ({ versionId: 9 }))
  const c = useInitialDifferenceDecision(scope, { context: async () => ({ writeEnabled: true }), current: async () => head(currentId), version: async () => version(9), post } as any)
  await c.load(); c.basis.value = '首次人工依据'; Object.assign(c.draft.value, { status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history' })
  currentId = 10; await c.save(); expect(c.phase.value).toBe('superseded'); expect(c.dirty.value).toBe(false)
  const first = JSON.parse(JSON.stringify(post.mock.calls[0]))
  await c.save(); expect(post).toHaveBeenCalledTimes(1)
  c.begin(); expect(c.basis.value).toBe(''); expect(c.draft.value.status).toBe(''); expect(c.canSave.value).toBe(false)
  c.basis.value = '核对当前十号后明确追加'; Object.assign(c.draft.value, { status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history' })
  await c.save(); expect(post).toHaveBeenCalledTimes(2)
  expect(c.state.request?.expectedCurrentId).toBe(10)
  expect(c.state.request?.idempotencyKey).not.toBe(first[0].idempotencyKey)
})
