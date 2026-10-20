// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { defineComponent, provide, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import EnterpriseEvidenceSheet from '../components/enterprise/EnterpriseEvidenceSheet.vue'
import { Sheet } from '../components/ui/sheet'
import { REVIEW_DRAFTS_KEY, useReviewDrafts } from '../composables/useReviewDrafts'

const row = {
  id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit',
  decisionId: 82, latestRevisionId: 9, reviewedRevisionId: null, classification: 'evidence_changed',
  pending: true, lineage: 'current',
  oldDecision: { id: 82, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none', reasonNote: '待复核原因' },
}
const detail = {
  ...row,
  currentDecision: { versionId: 82, current: row.oldDecision },
  evidenceToken: { decisionId: 82, latestRevisionId: 9, projectionReady: true },
  queryCoverage: null,
  gaps: { subjectUnknown: false, projectionReady: true },
  reviewedBaseline: null,
}
const stubs = {
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  SheetContent: { template: '<div><slot /></div>' },
  SheetHeader: { template: '<div><slot /></div>' },
  SheetTitle: { template: '<h2><slot /></h2>' },
  SheetDescription: { template: '<p><slot /></p>' },
  Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
  DialogContent: { template: '<div><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<h2><slot /></h2>' },
  DialogDescription: { template: '<p><slot /></p>' },
  DialogFooter: { template: '<div><slot /></div>' },
}

afterEach(() => vi.unstubAllGlobals())

function mountSheet() {
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
    if (url === '/api/roster/evidence-review/browser-context') return { writeEnabled: true }
    if (url === '/api/roster/evidence-impacts/4') return detail
    if (url.endsWith('/sources')) return { rows: [], nextCursor: null, asOf: {} }
    if (url.endsWith('/history')) return { rows: [], total: 0, page: 1, pageSize: 25 }
    throw new Error('Unexpected request: ' + url)
  }))
  let store: ReturnType<typeof useReviewDrafts>
  const open = ref(true)
  const Host = defineComponent({
    components: { EnterpriseEvidenceSheet },
    setup() {
      store = useReviewDrafts()
      provide(REVIEW_DRAFTS_KEY, store)
      return { open }
    },
    template: '<div><div id="review-sheet-footer"></div><EnterpriseEvidenceSheet v-model:open="open" :enterprise-id="7" title-code="specialized_sme" direction="missing_in_miit" :impact-id="4" /></div>',
  })
  const view = mount(Host, { attachTo: document.body, global: { plugins: [createPinia(), PiniaColada], stubs } })
  return { view, store: () => store, open }
}
function clickText(view: ReturnType<typeof mount>, text: string) {
  const button = view.findAll('button').find(candidate => candidate.text() === text)
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

it('keeps the Sheet open with the same in-memory draft on continue and clears it on explicit discard', async () => {
  const { view, store, open } = mountSheet()
  await flushPromises()
  await view.get('[aria-label="复核依据"]').setValue('抽屉里填写的依据')
  await flushPromises()

  const sheet = view.findComponent(Sheet)
  sheet.vm.$emit('update:open', false)
  await flushPromises()
  expect(view.text()).toContain('关闭会丢弃未提交内容')
  await clickText(view, '继续填写').trigger('click'); await flushPromises()
  expect(open.value).toBe(true)
  expect((view.get('[aria-label="复核依据"]').element as HTMLTextAreaElement).value).toBe('抽屉里填写的依据')
  expect(view.find('[aria-label="复核人"]').exists()).toBe(false)

  sheet.vm.$emit('update:open', false)
  await flushPromises()
  await clickText(view, '关闭并丢弃').trigger('click'); await flushPromises()
  expect(open.value).toBe(false)
  expect(store().hasDraft(4)).toBe(false)
  view.unmount()
})
