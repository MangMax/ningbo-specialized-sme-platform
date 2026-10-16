// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RosterEnterpriseTable, { type EnterpriseRow } from '../components/RosterEnterpriseTable.vue'
import { useEvidencePreviewScrollRestore } from '../lib/roster/evidence-preview-return'

const mocks = vi.hoisted(() => ({
  detail: null as unknown,
  loading: false,
  setDetail: null as ((value: unknown) => void) | null,
  setLoading: null as ((value: boolean) => void) | null,
}))

vi.mock('@pinia/colada', async () => {
  const { ref } = await import('vue')
  return {
    useQuery: () => {
      const data = ref<unknown>(mocks.detail)
      const isLoading = ref(mocks.loading)
      mocks.setDetail = (value) => (data.value = value)
      mocks.setLoading = (value) => (isLoading.value = value)
      return { data, isLoading, error: ref(null) }
    },
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

const row: EnterpriseRow = {
  enterpriseId: 91,
  name: '宁波开诚生态技术有限公司',
  uscc: null,
  district: '海曙区',
  city: null,
  regStatus: null,
  rosterState: 'current',
  titles: ['specialized_sme'],
  aliasNames: [],
  firstRecognition: [],
  nextReviewYear: null,
  anchorNeedsReview: false,
}

const NuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' }
const globalStubs = {
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
}

function ledgerHarness(ready: Ref<boolean>) {
  return defineComponent({
    setup() {
      useEvidencePreviewScrollRestore(ready)
      return () =>
        h(RosterEnterpriseTable, {
          rows: [row],
          loading: false,
          hasError: false,
          expandedId: 91,
          backQuery: 'view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91',
          onDetailReady: () => (ready.value = true),
        })
    },
  })
}

describe('出处预览返回滚动恢复', () => {
  beforeEach(() => {
    mocks.detail = detail
    mocks.loading = false
    mocks.setDetail = null
    mocks.setLoading = null
    sessionStorage.clear()
    history.replaceState(null, '', '/')
    vi.stubGlobal('useHead', vi.fn())
    vi.stubGlobal('$fetch', vi.fn(async () => ({})))
    vi.stubGlobal('useRoute', () => ({ query: {} }))
  })

  it.each([
    { label: '桌面表格滚动', width: 1440, height: 900, tableTop: 383, windowTop: 90 },
    { label: '390×844 窄屏表格滚动', width: 390, height: 844, tableTop: 339, windowTop: 42 },
  ])('$label 保留筛选 / 页码 / 展开行,并在表格与详情渲染后恢复两层滚动', async ({ width, height, tableTop, windowTop }) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: windowTop })

    const source = mount(ledgerHarness(ref(true)), {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    await flushPromises()
    const tableScroller = source.element.querySelector(
      '[data-evidence-return-scroll-container]',
    ) as HTMLElement | null
    expect(tableScroller).not.toBeNull()
    tableScroller!.scrollTop = tableTop

    const sourceLink = source.findAll('a').find((link) => link.text().includes('第 8 页'))
    expect(sourceLink).toBeDefined()
    await sourceLink!.trigger('click', { button: 0 })

    const previewUrl = new URL(sourceLink!.attributes('href')!, window.location.origin)
    expect(previewUrl.pathname).toBe('/preview')
    expect(previewUrl.searchParams.get('back')).toBe(safeBack)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain(`"scrollY":${windowTop}`)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain(`"scrollTop":${tableTop}`)
    source.unmount()

    history.pushState(null, '', previewUrl.searchParams.get('back')!)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    mocks.detail = null
    mocks.loading = true
    const frames: FrameRequestCallback[] = []
    const scrollTo = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('scrollTo', scrollTo)

    const returnedReady = ref(false)
    const returned = mount(ledgerHarness(returnedReady), {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    await flushPromises()
    const returnedScroller = returned.element.querySelector(
      '[data-evidence-return-scroll-container]',
    ) as HTMLElement | null
    expect(returnedScroller).not.toBeNull()
    expect(returnedReady.value).toBe(false)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(returnedScroller!.scrollTop).toBe(0)

    mocks.setDetail?.(detail)
    mocks.setLoading?.(false)
    await flushPromises()
    expect(returnedReady.value).toBe(true)
    expect(returned.findAll('a').some((link) => link.text().includes('第 8 页'))).toBe(true)
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: windowTop, behavior: 'instant' })
    expect(returnedScroller!.scrollTop).toBe(tableTop)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()

    returned.unmount()
  })
})
