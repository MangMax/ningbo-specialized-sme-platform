// @vitest-environment happy-dom
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, provide, ref } from 'vue'
import { REVIEW_DRAFTS_KEY, useReviewDrafts } from '../../../composables/useReviewDrafts'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import InitialForm from '../../../components/enterprise/InitialDifferenceDecisionForm.vue'
import Sheet from '../../../components/enterprise/EnterpriseEvidenceSheet.vue'
import { Sheet as SheetRoot } from '../../../components/ui/sheet'
import { Select } from '../../../components/ui/select'
const scope = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const assessment = { currentDecision: { ...scope, versionId: null, current: null }, queryCoverage: { status: 'complete', sources: [], truncated: false }, assessment: 'queried_unjudged', explanationValidity: { status: 'not_applicable', reasons: [] } }
let post: ReturnType<typeof vi.fn>, fetcher: ReturnType<typeof vi.fn>, id: number | null
const stubs = { teleport: true, SheetContent: { template: '<div><slot /></div>' }, SheetHeader: { template: '<div><slot /></div>' }, SheetTitle: { template: '<h2><slot /></h2>' }, SheetDescription: { template: '<p><slot /></p>' }, Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' }, DialogTitle: { template: '<h2><slot /></h2>' }, DialogHeader: { template: '<div><slot /></div>' }, DialogDescription: { template: '<p><slot /></p>' }, DialogFooter: { template: '<div><slot /></div>' } }
const plugins = () => [createPinia(), PiniaColada]
enableAutoUnmount(afterEach)
beforeEach(() => {
  id = null
  post = vi.fn(async () => { id = 9; return { versionId: 9 } })
  fetcher = vi.fn(async (url: string, options?: any) => {
    if (url.endsWith('browser-context')) return { writeEnabled: true }
    if (url.endsWith('browser-commands')) return (post as (body: unknown) => Promise<unknown>)(options.body)
    if (url.endsWith('/current')) return { ...options.query, versionId: id, current: id ? { ...options.query, id, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history', basis: '依据', actor: null, ruleVersion: null } : null }
    if (/decision-lifecycle\/\d+$/.test(url)) return { ...scope, id: Number(url.split('/').at(-1)), status: 'confirmed_reason', reasonCode: 'other', measureCode: 'keep_history', actor: null, ruleVersion: null }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  })
  vi.stubGlobal('$fetch', fetcher)
})
afterEach(() => vi.unstubAllGlobals())
const button = (v: ReturnType<typeof mount>, text: string) => {
  const b = v.findAll('button').find(b => b.text() === text)
  if (!b) throw new Error('Missing button: ' + text)
  return b
}
async function choose(v: ReturnType<typeof mount>, label: string, value: string) {
  const c = v.findAllComponents(Select).find(c => c.find(`[aria-label="${label}"]`).exists())!
  c.vm.$emit('update:modelValue', value); await flushPromises()
}
async function fill(v: ReturnType<typeof mount>) {
  await v.get('[aria-label="判断依据"]').setValue('核对原始公布材料')
  await choose(v, '更正结论', 'confirmed_reason'); await choose(v, '更正原因', 'other'); await choose(v, '更正措施', 'keep_history')
}
it('opens from the exact no-impact Sheet and saves an explicit decision then displays honest metadata', async () => {
  const v = mount(Sheet, { props: { open: true, ...scope, assessment: assessment as any }, attachTo: document.body, global: { plugins: plugins(), stubs } })
  await flushPromises()
  await button(v, '登记差异判断').trigger('click'); await flushPromises()
  expect(button(v, '保存差异判断').attributes('disabled')).toBeDefined()
  expect(v.find('[aria-label="操作人"]').exists()).toBe(false)
  await fill(v); await v.get('form').trigger('submit'); await flushPromises()
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0]![0]).toMatchObject({ ...scope, expectedCurrentId: null, basis: '核对原始公布材料' })
  expect(v.text()).toContain('已提交并读回当前决定')
  expect(v.find('[data-testid="query-assessment"]').exists()).toBe(false)
  expect(v.get('[data-testid="decision-version"]').text()).toContain('未记录')
})
it.each([{ name: 'enterprise', patch: { enterpriseId: 8 } }, { name: 'title', patch: { titleCode: 'little_giant' } }, { name: 'direction', patch: { direction: 'extra_in_miit' } }])('preserves drafts on close and scope switch until explicit discard with no cross-scope reuse: $name', async ({ patch }) => {
  const v = mount(Sheet, { props: { open: true, ...scope, assessment: assessment as any }, attachTo: document.body, global: { plugins: plugins(), stubs } })
  await flushPromises(); await button(v, '登记差异判断').trigger('click'); await fill(v)
  v.findComponent(SheetRoot).vm.$emit('update:open', false); await flushPromises()
  expect(v.text()).toContain('关闭会丢弃未提交内容')
  await button(v, '继续填写').trigger('click'); await flushPromises()
  expect((v.get('[aria-label="判断依据"]').element as HTMLTextAreaElement).value).toBe('核对原始公布材料')
  await v.setProps(patch); await flushPromises()
  expect(v.text()).toContain('切换会丢弃未提交内容')
  expect(fetcher.mock.calls.filter(c => c[0].endsWith('/current')).at(-1)![1].query.direction).toBe('missing_in_miit')
  await button(v, '丢弃并切换').trigger('click'); await flushPromises()
  await button(v, '登记差异判断').trigger('click'); await flushPromises()
  expect((v.get('[aria-label="判断依据"]').element as HTMLTextAreaElement).value).toBe('')
  expect(fetcher.mock.calls.filter(c => c[0].endsWith('/current')).at(-1)![1].query).toEqual({ ...scope, ...patch })
  expect(post).not.toHaveBeenCalled()
})
it('renders disabled deployment as read-only without business-entry or credential inputs', async () => {
  fetcher.mockImplementation(async (url: string, opts?: any) => url.endsWith('browser-context') ? { writeEnabled: false } : { ...opts.query, versionId: null, current: null })
  const v = mount(InitialForm, { props: { scope }, global: { plugins: plugins() } }); await flushPromises()
  expect(v.text()).toContain('差异判断暂为只读：尚未开启页面提交')
  expect(v.find('form').exists()).toBe(false); expect(v.find('input').exists()).toBe(false)
})

it('registers the exact-scope draft in the existing host guard and restores it after structural remount', async () => {
  const shown = ref(true)
  let store: ReturnType<typeof useReviewDrafts>
  const Host = defineComponent({ components: { InitialForm }, setup() { store = useReviewDrafts(); provide(REVIEW_DRAFTS_KEY, store); return { shown, scope } }, template: '<InitialForm v-if="shown" :scope="scope" />' })
  const v = mount(Host, { global: { plugins: plugins() } }); await flushPromises()
  expect(store!.hasDirty.value).toBe(false)
  await button(v, '登记差异判断').trigger('click'); await fill(v)
  expect(store!.hasDirty.value).toBe(true)
  expect(Object.keys(store!.drafts)).toEqual(['initial:7:specialized_sme:missing_in_miit'])
  shown.value = false; await flushPromises(); expect(store!.hasDirty.value).toBe(true)
  shown.value = true; await flushPromises()
  expect((v.get('[aria-label="判断依据"]').element as HTMLTextAreaElement).value).toBe('核对原始公布材料')
  await v.get('form').trigger('submit'); await flushPromises()
  expect(store!.hasDirty.value).toBe(false)
  expect(store!.drafts['initial:7:specialized_sme:missing_in_miit']?.initialSubmission?.receipt?.versionId).toBe(9)
})
