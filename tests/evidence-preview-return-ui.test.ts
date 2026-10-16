// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RosterEnterprisePanel from '../components/RosterEnterprisePanel.vue'
import { useEvidencePreviewScrollRestore } from '../lib/roster/evidence-preview-return'

const mocks = vi.hoisted(() => ({
  detail: null as unknown,
}))

vi.mock('@pinia/colada', async () => {
  const { ref } = await import('vue')
  return {
    useQuery: () => ({ data: ref(mocks.detail), isLoading: ref(false), error: ref(null) }),
  }
})

const safeBack = '/?view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91'
const detail = {
  enterprise: { name: '宁波开诚生态技术有限公司', uscc: null },
  aliases: [],
  records: [
    {
      id: 1,
      titleCode: 'specialized_sme',
      source: 'jxj',
      district: '海曙区',
      lifecycle: { firstRecognitionYear: null, anchorYear: null, dueYear: null, state: 'none', needsReview: false },
    },
  ],
  events: [{ id: 10, recordId: 1, eventType: 'award', year: 2022, batchSeq: 1, decidedYear: null, reviewOutcome: null }],
  evidence: [{ eventId: 10, sourceFile: 'jxj/announcement/test.pdf', attachment: '附件二', listNo: 6, page: 8 }],
  recognitions: [],
  differences: [],
  platform: { queries: [], relations: [] },
}

const NuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' }

describe('出处预览返回滚动恢复', () => {
  beforeEach(() => {
    mocks.detail = detail
    sessionStorage.clear()
    history.replaceState(null, '', '/')
    vi.stubGlobal('useHead', vi.fn())
    vi.stubGlobal('$fetch', vi.fn(async () => ({})))
    vi.stubGlobal('useRoute', () => ({ query: {} }))
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 90 })
  })

  it('点击出处页码保存滚动偏移,返回路径保留筛选 / 页码 / 展开行,并等待列表就绪后恢复', async () => {
    const source = mount(RosterEnterprisePanel, {
      props: { enterpriseId: 91, backQuery: 'view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91' },
      global: {
        stubs: {
          NuxtLink: NuxtLinkStub,
          FilePreviewDialog: true,
          EventChip: true,
          SourceChip: true,
          TitleBadge: true,
          Badge: true,
          Button: true,
          Collapsible: { template: '<div><slot /></div>' },
          CollapsibleContent: { template: '<div><slot /></div>' },
          CollapsibleTrigger: { template: '<button><slot /></button>' },
          Skeleton: true,
        },
      },
    })

    const sourceLink = source.findAll('a').find((link) => link.text().includes('第 8 页'))
    expect(sourceLink).toBeDefined()
    await sourceLink!.trigger('click', { button: 0 })

    const previewUrl = new URL(sourceLink!.attributes('href')!, window.location.origin)
    expect(previewUrl.pathname).toBe('/preview')
    expect(previewUrl.searchParams.get('back')).toBe(safeBack)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain('"scrollY":90')
    source.unmount()

    // The preview return link navigates to the same safe path that the source link carried.
    history.pushState(null, '', previewUrl.searchParams.get('back')!)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })

    const ready = ref(false)
    const RestoreHarness = defineComponent({
      setup() {
        useEvidencePreviewScrollRestore(ready as Ref<boolean>)
        return () => h('div', 'ledger list')
      },
    })
    const scrollTo = vi.fn()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('scrollTo', scrollTo)
    const returned = mount(RestoreHarness, { attachTo: document.body })
    await flushPromises()
    expect(scrollTo).not.toHaveBeenCalled()

    ready.value = true
    await flushPromises()
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: 90, behavior: 'instant' })
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()

    returned.unmount()
  })
})
