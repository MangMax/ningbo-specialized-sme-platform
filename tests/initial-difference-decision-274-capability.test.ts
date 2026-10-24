// @vitest-environment happy-dom
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, provide, ref } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, expect, it, vi } from 'vitest'
import Form from '../components/enterprise/InitialDifferenceDecisionForm.vue'
import { Select } from '../components/ui/select'
import { REVIEW_DRAFTS_KEY, useReviewDrafts } from '../composables/useReviewDrafts'
import { useInitialDifferenceDecision } from '../composables/useInitialDifferenceDecision'

const scope = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const key = 'initial:7:specialized_sme:missing_in_miit'
type Capability = 'ready' | 'disabled' | 'unknown' | 'error'
type Current = 'empty' | 'own' | 'later' | 'withdrawn' | 'new'
const row = (id: number) => ({ ...scope, id, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history', actor: null, ruleVersion: null, isCurrent: true })
const content = (c: ReturnType<typeof useInitialDifferenceDecision>) => { c.basis.value = '人工核对依据'; Object.assign(c.draft.value, { status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history' }) }
enableAutoUnmount(afterEach)
afterEach(() => vi.unstubAllGlobals())
function harness() {
  let capability: Capability = 'ready', current: Current = 'empty', loseResponse = false, blockedVersion = false
  const commands: any[] = [], reads: string[] = []
  const context = async () => { reads.push('capability'); if (capability === 'error') throw new Error('capability unavailable'); return capability === 'unknown' ? {} : { writeEnabled: capability === 'ready' } }
  const readCurrent = async () => { reads.push('current'); const id = current === 'empty' ? null : current === 'own' ? 9 : current === 'new' ? 11 : 10; return { ...scope, versionId: id, current: id && current !== 'withdrawn' ? row(id) : null } }
  const version = async (id: number) => { reads.push(`version:${id}`); if (blockedVersion) throw new Error('own version unavailable'); return { ...row(id), isCurrent: current === 'own' && id === 9 || current === 'new' && id === 11 } }
  const post = vi.fn(async (body: any) => { commands.push(JSON.parse(JSON.stringify(body))); const id = commands.length === 1 || loseResponse ? 9 : 11; current = id === 9 ? 'own' : 'new'; if (loseResponse && commands.length === 1) throw new Error('lost response'); return { versionId: id, currentId: id, previousId: body.expectedCurrentId, action: 'replace', recordedAt: '2026-10-24T00:00:00Z' } })
  return { api: { context, current: readCurrent, version, post }, commands, reads, capability: (v: Capability) => { capability = v }, current: (v: Current) => { current = v }, lose: () => { loseResponse = true }, blockVersion: (v: boolean) => { blockedVersion = v } }
}
const button = (v: ReturnType<typeof mount>, text: string) => { const found = v.findAll('button').find(b => b.text() === text); if (!found) throw new Error('Missing button: ' + text); return found }
async function fill(v: ReturnType<typeof mount>) {
  await v.get('[aria-label="判断依据"]').setValue('明确人工重新核对的依据')
  for (const [label, value] of [['更正结论', 'confirmed_reason'], ['更正原因', 'other'], ['更正措施', 'keep_history']]) {
    v.findAllComponents(Select).find(c => c.find(`[aria-label="${label}"]`).exists())!.vm.$emit('update:modelValue', value); await flushPromises()
  }
}
function render(h: ReturnType<typeof harness>) {
  const shown = ref(true); let store!: ReturnType<typeof useReviewDrafts>
  vi.stubGlobal('$fetch', (url: string, opts?: any) => url.endsWith('browser-context') ? h.api.context() : url.endsWith('/current') ? h.api.current() : url.endsWith('browser-commands') ? h.api.post(opts.body) : h.api.version(Number(url.split('/').at(-1))))
  const Host = defineComponent({ components: { Form }, setup() { store = useReviewDrafts(); provide(REVIEW_DRAFTS_KEY, store); return { shown, scope } }, template: '<Form v-if="shown" :scope="scope" />' })
  const view = mount(Host, { attachTo: document.body, global: { plugins: [createPinia(), PiniaColada] } })
  return { view, shown, store: () => store, session: () => store.drafts[key]?.initialSubmission }
}
async function remount(h: ReturnType<typeof render>) { h.shown.value = false; await flushPromises(); expect(h.view.findComponent(Form).exists()).toBe(false); h.shown.value = true; await flushPromises() }
const matrix = [
  { name: 'own-ready', current: 'own', capability: 'ready' }, { name: 'own-disabled', current: 'own', capability: 'disabled' }, { name: 'own-unknown', current: 'own', capability: 'unknown' },
  { name: 'later-ready', current: 'later', capability: 'ready' }, { name: 'later-disabled', current: 'later', capability: 'disabled' }, { name: 'later-unknown', current: 'later', capability: 'unknown' },
  { name: 'withdrawn-ready', current: 'withdrawn', capability: 'ready' }, { name: 'withdrawn-disabled', current: 'withdrawn', capability: 'disabled' }, { name: 'withdrawn-unknown', current: 'withdrawn', capability: 'unknown' },
] as const
it.each(matrix)('restores verified identity and requires a fresh explicit command at the real head: $name', async ({ current, capability }) => {
  const api = harness(), h = render(api); await flushPromises(); await button(h.view, '登记差异判断').trigger('click'); await flushPromises(); await fill(h.view); await h.view.get('form').trigger('submit'); await flushPromises()
  const originalRequest = JSON.stringify(h.session()!.request), originalReceipt = JSON.stringify(h.session()!.receipt)
  api.current(current); api.capability(capability); const contexts = api.reads.filter(r => r === 'capability').length; const versions = api.reads.filter(r => r.startsWith('version:')).length
  await remount(h)
  expect(api.reads.filter(r => r === 'capability')).toHaveLength(contexts + 1); expect(api.reads.filter(r => r.startsWith('version:'))).toHaveLength(versions + 1)
  expect(h.session()!.head!.versionId).toBe(current === 'own' ? 9 : 10)
  expect(JSON.stringify(h.session()!.request)).toBe(originalRequest); expect(JSON.stringify(h.session()!.receipt)).toBe(originalReceipt); expect(api.commands).toHaveLength(1)
  const action = current === 'withdrawn' ? '登记差异判断' : '核对后追加更正'
  if (current === 'withdrawn') { expect(h.session()!.head!.current).toBeNull(); expect(h.view.text()).toContain('撤回版本 #10'); expect(h.view.text()).toContain('当前无有效决定') }
  if (capability !== 'ready') {
    expect(h.view.findAll('button').some(b => b.text() === action)).toBe(false)
    expect(h.view.text()).toContain(capability === 'disabled' ? '尚未开启页面提交' : '无法确认页面提交是否已开启')
    expect(h.session()!.writeState).toBe(capability === 'disabled' ? 'readonly' : 'unavailable')
    api.capability('ready'); await button(h.view, '重新检查页面提交能力').trigger('click'); await flushPromises()
    expect(api.commands).toHaveLength(1); expect(JSON.stringify(h.session()!.request)).toBe(originalRequest); expect(JSON.stringify(h.session()!.receipt)).toBe(originalReceipt)
  }
  const session = h.session()!
  await button(h.view, action).trigger('click'); await flushPromises()
  expect(session.request).toBeNull(); expect(session.receipt).toBeNull(); expect((h.view.get('[aria-label="判断依据"]').element as HTMLTextAreaElement).value).toBe('')
  expect(h.view.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  await fill(h.view); await h.view.get('form').trigger('submit'); await flushPromises()
  expect(api.commands).toHaveLength(2); expect(api.commands[1].expectedCurrentId).toBe(current === 'own' ? 9 : 10)
  expect(api.commands[1].idempotencyKey).not.toBe(api.commands[0].idempotencyKey)
})
it.each(['disabled', 'unknown'] as const)('rechecks capability before clearing a verified receipt for a new correction: %s', async capability => {
  const h = harness(); const c = useInitialDifferenceDecision(scope, h.api as any); await c.load(); content(c); await c.save()
  const frozen = JSON.stringify(c.state.request), receipt = JSON.stringify(c.receipt.value)
  h.capability(capability); expect(await c.begin()).toBe(false)
  expect(JSON.stringify(c.state.request)).toBe(frozen); expect(JSON.stringify(c.receipt.value)).toBe(receipt); expect(c.canSave.value).toBe(false)
  await c.save(); expect(h.commands).toHaveLength(1)
  h.capability('ready'); await c.recheckCapability(); expect(h.commands).toHaveLength(1); expect(c.receipt.value?.versionId).toBe(9)
  expect(await c.begin()).toBe(true); expect(c.basis.value).toBe(''); expect(c.state.request).toBeNull()
})
it.each(['disabled', 'unknown'] as const)('checks capability immediately before creating a new command or key: %s', async capability => {
  const h = harness(); const c = useInitialDifferenceDecision(scope, h.api as any); await c.load(); content(c); expect(c.canSave.value).toBe(true)
  h.capability(capability); await c.save(); expect(h.commands).toHaveLength(0); expect(c.state.request).toBeNull(); expect(c.basis.value).toBe('人工核对依据'); expect(c.canSave.value).toBe(false)
  h.capability('ready'); await c.recheckCapability(); expect(h.commands).toHaveLength(0); await c.save(); expect(h.commands).toHaveLength(1)
})
it.each(['disabled', 'unknown'] as const)('remounts an unknown command with fresh capability and no new head or POST: %s', async capability => {
  const api = harness(); api.lose(); const h = render(api); await flushPromises(); await button(h.view, '登记差异判断').trigger('click'); await flushPromises(); await fill(h.view); await h.view.get('form').trigger('submit'); await flushPromises()
  const frozen = JSON.stringify(h.session()!.request), identityReads = api.reads.filter(r => r !== 'capability').length, contexts = api.reads.filter(r => r === 'capability').length
  api.capability(capability); await remount(h)
  expect(api.reads.filter(r => r === 'capability')).toHaveLength(contexts + 1); expect(api.reads.filter(r => r !== 'capability')).toHaveLength(identityReads)
  expect(h.session()!.phase).toBe('unknown'); expect(h.session()!.receipt).toBeNull(); expect(JSON.stringify(h.session()!.request)).toBe(frozen)
  expect(api.commands).toHaveLength(1); expect(h.view.get('button[type="submit"]').attributes('disabled')).toBeDefined(); expect(h.view.get('fieldset').attributes('disabled')).toBeDefined()
  api.capability('ready'); await button(h.view, '重新检查页面提交能力').trigger('click'); await flushPromises()
  expect(api.commands).toHaveLength(1); expect(api.reads.filter(r => r !== 'capability')).toHaveLength(identityReads)
  await button(h.view, '重试同一次提交').trigger('click'); await flushPromises(); expect(api.commands).toHaveLength(2); expect(api.commands[1]).toEqual(api.commands[0]); expect(h.session()!.receipt?.versionId).toBe(9)
})
it('continues receipt version and current GETs through unavailable capability without offering a new command', async () => {
  const api = harness(), h = render(api); await flushPromises(); await button(h.view, '登记差异判断').trigger('click'); await flushPromises(); await fill(h.view); await h.view.get('form').trigger('submit'); await flushPromises()
  api.capability('error'); api.blockVersion(true); await remount(h)
  expect(h.session()!.phase).toBe('readback'); expect(h.store().hasDirty.value).toBe(true); expect(h.session()!.receipt?.versionId).toBe(9)
  api.blockVersion(false); await button(h.view, '重试读取当前决定').trigger('click'); await flushPromises()
  expect(h.session()!.phase).toBe('saved'); expect(h.session()!.writeState).toBe('unavailable'); expect(h.view.findAll('button').some(b => b.text() === '核对后追加更正')).toBe(false); expect(api.commands).toHaveLength(1)
})
it('retains an unknown request when the server disables writing after a ready capability check', async () => {
  const h = harness(); let attempts = 0
  const post = vi.fn(async (body: any) => { h.commands.push(JSON.parse(JSON.stringify(body))); attempts++; if (attempts === 1) throw new Error('response lost'); if (attempts === 2) throw { data: { error: { code: 'browser_review_disabled' } } }; h.current('own'); return { versionId: 9 } })
  const c = useInitialDifferenceDecision(scope, { ...h.api, post } as any); await c.load(); content(c); await c.save(); const frozen = JSON.stringify(c.state.request)
  await c.save(); expect(c.phase.value).toBe('unknown'); expect(c.writeState.value).toBe('readonly'); expect(JSON.stringify(c.state.request)).toBe(frozen); expect(c.canRetry.value).toBe(false)
  expect(await c.begin()).toBe(false); await c.recheckCapability(); await c.save(); expect(h.commands).toHaveLength(3); expect(h.commands[1]).toEqual(h.commands[0]); expect(h.commands[2]).toEqual(h.commands[0]); expect(c.receipt.value?.versionId).toBe(9)
})
it('keeps a late capability confirmation with its original session instead of enabling another scope', async () => {
  const h = harness(); let defer = false, release!: (value: { writeEnabled: boolean }) => void
  const old = useInitialDifferenceDecision(scope, { ...h.api, context: () => defer ? new Promise(resolve => { release = resolve }) : h.api.context() } as any)
  await old.load(); content(old); await old.save(); const receipt = JSON.stringify(old.receipt.value)
  defer = true; const beginning = old.begin(); expect(JSON.stringify(old.receipt.value)).toBe(receipt)
  const otherScope = { ...scope, direction: 'extra_in_miit' }
  const other = useInitialDifferenceDecision(otherScope, { ...h.api, context: async () => ({ writeEnabled: false }), current: async () => ({ ...otherScope, versionId: null, current: null }) } as any)
  await other.load(); content(other); expect(other.writeState.value).toBe('readonly')
  release({ writeEnabled: true }); await beginning
  expect(other.writeState.value).toBe('readonly'); expect(other.canSave.value).toBe(false); expect(other.state.request).toBeNull(); expect(other.head.value?.direction).toBe('extra_in_miit'); expect(h.commands).toHaveLength(1)
})
