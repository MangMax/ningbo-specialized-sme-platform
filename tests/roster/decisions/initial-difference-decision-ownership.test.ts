// @vitest-environment happy-dom
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, provide, ref } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import Sheet from '../../../components/enterprise/EnterpriseEvidenceSheet.vue'
import { Sheet as SheetRoot } from '../../../components/ui/sheet'
import { Select } from '../../../components/ui/select'
import { REVIEW_DRAFTS_KEY, useReviewDrafts } from '../../../composables/useReviewDrafts'

const scope = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const key = 'initial:7:specialized_sme:missing_in_miit'
const assessment = { currentDecision: { ...scope, versionId: null, current: null }, queryCoverage: { status: 'complete', sources: [], truncated: false }, assessment: 'queried_unjudged', explanationValidity: { status: 'not_applicable', reasons: [] } }
const stubs = { teleport: true, SheetContent: { template: '<div><slot /></div>' }, SheetHeader: { template: '<div><slot /></div>' }, SheetTitle: { template: '<h2><slot /></h2>' }, SheetDescription: { template: '<p><slot /></p>' }, Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' }, DialogTitle: { template: '<h2><slot /></h2>' }, DialogHeader: { template: '<div><slot /></div>' }, DialogDescription: { template: '<p><slot /></p>' }, DialogFooter: { template: '<div><slot /></div>' } }
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
enableAutoUnmount(afterEach)
afterEach(() => vi.unstubAllGlobals())
function render() {
  const shown = ref(true), open = ref(true), direction = ref(scope.direction)
  let store!: ReturnType<typeof useReviewDrafts>, committed = false, lose = false
  const handoffs: boolean[] = [], commands: any[] = [], capabilities: ReturnType<typeof deferred<{ writeEnabled: boolean }>>[] = []
  let postWait: ReturnType<typeof deferred<{ versionId: number }>> | null = null
  vi.stubGlobal('$fetch', async (url: string, opts?: any) => {
    if (url.endsWith('browser-context')) return capabilities.shift()?.promise ?? { writeEnabled: true }
    if (url.endsWith('/current')) return { ...opts.query, versionId: committed && opts.query.direction === scope.direction ? 9 : null, current: committed && opts.query.direction === scope.direction ? { ...scope, id: 9, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history', isCurrent: true } : null }
    if (url.endsWith('/9')) return { ...scope, id: 9, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history', isCurrent: true }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    if (url.endsWith('browser-commands')) {
      // The actual POST boundary must already have the full retry body in the real parent store.
      handoffs.push(JSON.stringify(store.drafts[key]?.initialSubmission?.request) === JSON.stringify(opts.body))
      commands.push(JSON.parse(JSON.stringify(opts.body))); committed = true
      if (postWait) { const wait = postWait; postWait = null; return wait.promise }
      if (lose) { lose = false; throw new Error('synthetic committed response lost') }
      return { versionId: 9 }
    }
    throw new Error('Unexpected request: ' + url)
  })
  const Host = defineComponent({ components: { Sheet }, setup() { store = useReviewDrafts(); provide(REVIEW_DRAFTS_KEY, store); return { shown, open, direction, scope, assessment } }, template: '<Sheet v-if="shown" v-model:open="open" :enterprise-id="scope.enterpriseId" :title-code="scope.titleCode" :direction="direction" :assessment="assessment" />' })
  const view = mount(Host, { attachTo: document.body, global: { plugins: [createPinia(), PiniaColada], stubs } })
  return { view, shown, open, direction, handoffs, store: () => store, commands, session: () => store.drafts[key]?.initialSubmission, cap: () => { const d = deferred<{ writeEnabled: boolean }>(); capabilities.push(d); return d }, post: () => { postWait = deferred<{ versionId: number }>(); return postWait }, lose: () => { lose = true } }
}
const button = (h: ReturnType<typeof render>, name: string) => { const b = h.view.findAll('button').find(b => b.text() === name); if (!b) throw Error('Missing button: ' + name); return b }
async function fill(h: ReturnType<typeof render>) {
  await button(h, '登记差异判断').trigger('click'); await flushPromises()
  await h.view.get('[aria-label="判断依据"]').setValue('所有权回归人工依据')
  for (const [label, value] of [['更正结论', 'confirmed_reason'], ['更正原因', 'other'], ['更正措施', 'keep_history']]) { h.view.findAllComponents(Select).find(c => c.find(`[aria-label="${label}"]`).exists())!.vm.$emit('update:modelValue', value); await flushPromises() }
}
async function submit(h: ReturnType<typeof render>) { await h.view.get('form').trigger('submit'); await flushPromises() }
async function remount(h: ReturnType<typeof render>) { h.shown.value = false; await flushPromises(); h.shown.value = true; await flushPromises() }
it.each(['discard', 'close', 'scope', 'structural'] as const)('cancels an unsent save awaiting capability after %s without creating a command', async action => {
  const h = render(); await flushPromises(); await fill(h); const wait = h.cap(); await submit(h)
  expect(h.session()!.busy).toBe(true); expect(h.session()!.request).toBeNull()
  if (action === 'discard') h.store().discardAll()
  else if (action === 'close') { h.view.findComponent(SheetRoot).vm.$emit('update:open', false); await flushPromises(); await button(h, '关闭并丢弃').trigger('click') }
  else if (action === 'scope') { h.direction.value = 'extra_in_miit'; await flushPromises(); await button(h, '丢弃并切换').trigger('click') }
  else h.shown.value = false
  await flushPromises(); wait.resolve({ writeEnabled: true }); await flushPromises()
  expect(h.commands).toEqual([])
  if (action !== 'structural') expect(h.store().drafts[key]).toBeUndefined()
  else { expect(h.session()!.request).toBeNull(); expect(h.store().hasDirty.value).toBe(true) }
})
it('does not clear the retained receipt when a pending explicit begin loses its view', async () => {
  const h = render(); await flushPromises(); await fill(h); await submit(h)
  const original = JSON.stringify({ request: h.session()!.request, receipt: h.session()!.receipt })
  const wait = h.cap(); await button(h, '核对后追加更正').trigger('click'); await flushPromises()
  await remount(h); wait.resolve({ writeEnabled: true }); await flushPromises()
  expect(JSON.stringify({ request: h.session()!.request, receipt: h.session()!.receipt })).toBe(original)
  expect(h.commands).toHaveLength(1); expect(h.view.find('[aria-label="判断依据"]').exists()).toBe(false)
})
it('does not revive the old A command after A B A creates a different exact-scope session', async () => {
  const h = render(); await flushPromises(); await fill(h); const old = h.session(); const wait = h.cap(); await submit(h)
  h.direction.value = 'extra_in_miit'; await flushPromises(); await button(h, '丢弃并切换').trigger('click'); await flushPromises()
  h.direction.value = scope.direction; await flushPromises(); await fill(h)
  expect(h.session()).not.toBe(old); const next = h.cap(); await submit(h); expect(h.session()!.busy).toBe(true)
  wait.resolve({ writeEnabled: true }); await flushPromises(); expect(h.commands).toEqual([]); expect(h.session()!.busy).toBe(true)
  next.resolve({ writeEnabled: true }); await flushPromises(); expect(h.commands).toHaveLength(1); expect(h.session()!.receipt?.versionId).toBe(9)
})
it.each(['ready', 'failure'] as const)('keeps an unknown identity and the new operation busy when an unmounted retry gets late %s', async outcome => {
  const h = render(); await flushPromises(); await fill(h); h.lose(); await submit(h)
  const original = JSON.stringify(h.session()!.request); const wait = h.cap(); await submit(h)
  h.shown.value = false; await flushPromises(); const fresh = h.cap(); h.shown.value = true; await flushPromises()
  expect(h.session()!.busy).toBe(true)
  if (outcome === 'ready') wait.resolve({ writeEnabled: true }); else wait.reject(new Error('late capability failure'))
  await flushPromises(); expect(h.session()!.busy).toBe(true); expect(h.commands).toHaveLength(1); expect(JSON.stringify(h.session()!.request)).toBe(original)
  fresh.resolve({ writeEnabled: true }); await flushPromises(); expect(h.session()!.busy).toBe(false); expect(h.session()!.phase).toBe('unknown')
  await submit(h); expect(h.commands).toHaveLength(2); expect(h.commands[1]).toEqual(h.commands[0]); expect(h.session()!.receipt?.versionId).toBe(9)
})
it('retains a dispatched command through structural unmount and lost receipt then retries the identical body', async () => {
  const h = render(); await flushPromises(); await fill(h); const response = h.post(); await submit(h)
  const request = JSON.stringify(h.session()!.request); expect(h.commands).toHaveLength(1); expect(h.handoffs).toEqual([true])
  h.shown.value = false; await flushPromises(); h.store().discardAll(); response.reject(new Error('committed response lost')); await flushPromises()
  expect(h.session()!.phase).toBe('unknown'); expect(JSON.stringify(h.session()!.request)).toBe(request); expect(h.store().hasDirty.value).toBe(true)
  h.shown.value = true; await flushPromises(); await submit(h)
  expect(h.commands).toHaveLength(2); expect(h.commands[1]).toEqual(h.commands[0]); expect(h.session()!.receipt?.versionId).toBe(9)
})
it('ends host ownership before a pending capability can dispatch a new command', async () => {
  const h = render(); await flushPromises(); await fill(h); const wait = h.cap(); await submit(h)
  h.view.unmount(); expect(Object.keys(h.store().drafts)).toEqual([])
  wait.resolve({ writeEnabled: true }); await flushPromises(); expect(h.commands).toEqual([]); expect(Object.keys(h.store().drafts)).toEqual([])
})
it('does not resurrect an ended host when a dispatched POST later returns a receipt', async () => {
  const h = render(); await flushPromises(); await fill(h); const response = h.post(); await submit(h)
  const old = h.session(); h.view.unmount(); response.resolve({ versionId: 9 }); await flushPromises()
  expect(h.commands).toHaveLength(1); expect(Object.keys(h.store().drafts)).toEqual([]); expect(old!.receipt).toBeNull()
})
