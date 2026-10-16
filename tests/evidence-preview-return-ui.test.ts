// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RosterEnterpriseTable, { type EnterpriseRow } from '../components/RosterEnterpriseTable.vue'
import { useEvidencePreviewScrollRestore } from '../lib/roster/evidence-preview-return'
import EnterprisePage from '../pages/enterprises/[id].vue'

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

const fullDetail = {
  id: 91,
  name: '宁波开诚生态技术有限公司',
  uscc: null,
  district: '海曙区',
  qualityFlags: [],
  records: [
    {
      titleCode: 'specialized_sme',
      source: 'jxj',
      district: '海曙区',
      events: [
        {
          type: 'award',
          year: 2022,
          seq: 1,
          evidence: [
            { sourceFile: 'jxj/announcement/test.pdf', attachment: '附件二', listNo: 6, page: 8 },
          ],
        },
      ],
    },
  ],
}

let currentRoute: Record<string, unknown>

const NuxtLinkStub = {
  props: ['to'],
  template:
    '<a :href="typeof to === \'string\' ? to : JSON.stringify(to)" :data-target="typeof to === \'string\' ? to : JSON.stringify(to)"><slot /></a>',
}
const globalStubs = {
  NuxtLink: NuxtLinkStub,
  PageHeader: {
    props: ['title'],
    template:
      '<header><h1>{{ title }}</h1><slot name="breadcrumb"/><slot name="description"/><slot name="actions"/></header>',
  },
  FilePreviewDialog: true,
  EventChip: true,
  SourceChip: true,
  TitleBadge: true,
  Badge: true,
  Button: { template: '<button><slot /></button>' },
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
    currentRoute = { query: {} }
    vi.stubGlobal('useRoute', () => currentRoute)
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

  it('从名录行进详情再经预览返回，保留名录筛选、页码、展开行和表格滚动', async () => {
    const listWindowTop = 90
    const listTableTop = 383
    const detailWindowTop = 214
    const detailPathPrefix = '/enterprises/91?back=view%3Denterprise%26q%3D%25E5%25BC%2580%25E8%25AF%259A%26page%3D2%26expand%3D91'
    Object.defineProperty(window, 'scrollY', { configurable: true, value: listWindowTop })
    history.replaceState(null, '', safeBack)
    mocks.detail = detail
    mocks.loading = false

    const sourceReady = ref(true)
    const roster = mount(ledgerHarness(sourceReady), {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    await flushPromises()
    const rosterScroller = roster.element.querySelector(
      '[data-evidence-return-scroll-container]',
    ) as HTMLElement | null
    expect(rosterScroller).not.toBeNull()
    rosterScroller!.scrollTop = listTableTop
    const fullDetailLink = roster.findAll('a').find((link) => link.text().includes('完整企业页'))
    expect(fullDetailLink).toBeDefined()
    await fullDetailLink!.trigger('click', { button: 0 })

    const fullDetailUrl = new URL(fullDetailLink!.attributes('href')!, window.location.origin)
    expect(fullDetailUrl.pathname).toBe('/enterprises/91')
    expect(fullDetailUrl.searchParams.get('back')).toBe('view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91')
    const rosterState = JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!) as {
      back: string
      scrollY: number
      scrollTop: number | null
    }[]
    expect(rosterState).toHaveLength(1)
    expect(rosterState[0]).toEqual({ back: safeBack, scrollY: listWindowTop, scrollTop: listTableTop })
    roster.unmount()

    const detailPath = `${fullDetailUrl.pathname}${fullDetailUrl.search}`
    expect(detailPath).toBe(detailPathPrefix)
    history.pushState(null, '', detailPath)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: detailWindowTop })
    currentRoute = {
      params: { id: '91' },
      query: { back: 'view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91' },
      fullPath: detailPath,
    }
    mocks.detail = fullDetail
    mocks.loading = false
    const detailPage = mount(EnterprisePage, {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    await flushPromises()
    const evidenceLink = detailPage.findAll('a').find((link) => link.text().includes('第 8 页'))
    expect(evidenceLink).toBeDefined()
    await evidenceLink!.trigger('click', { button: 0 })
    const previewUrl = new URL(evidenceLink!.attributes('href')!, window.location.origin)
    expect(previewUrl.searchParams.get('back')).toBe(detailPath)
    const chainedStates = JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!) as {
      back: string
      scrollY: number
      scrollTop: number | null
    }[]
    expect(chainedStates).toHaveLength(2)
    expect(chainedStates.find((state) => state.back === safeBack)).toEqual({
      back: safeBack,
      scrollY: listWindowTop,
      scrollTop: listTableTop,
    })
    expect(chainedStates.find((state) => state.back === detailPath)).toEqual({
      back: detailPath,
      scrollY: detailWindowTop,
      scrollTop: null,
    })
    detailPage.unmount()

    history.pushState(null, '', detailPath)
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
    const detailReturn = mount(EnterprisePage, {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    await flushPromises()
    expect(scrollTo).not.toHaveBeenCalled()
    mocks.setDetail?.(fullDetail)
    mocks.setLoading?.(false)
    await flushPromises()
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: detailWindowTop, behavior: 'instant' })
    expect(JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!)).toHaveLength(1)
    const ledgerLink = detailReturn.findAll('a').find((link) => link.text().includes('名录台账'))
    expect(ledgerLink?.attributes('data-target')).toBe(
      JSON.stringify({ path: '/', query: { view: 'enterprise', q: '开诚', page: '2', expand: '91' } }),
    )
    detailReturn.unmount()

    history.pushState(null, '', safeBack)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    currentRoute = { query: { view: 'enterprise', q: '开诚', page: '2', expand: '91' } }
    mocks.detail = null
    mocks.loading = true
    scrollTo.mockClear()
    frames.length = 0
    const returnedReady = ref(false)
    const ledgerReturn = mount(ledgerHarness(returnedReady), {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    await flushPromises()
    const returnedScroller = ledgerReturn.element.querySelector(
      '[data-evidence-return-scroll-container]',
    ) as HTMLElement | null
    expect(returnedReady.value).toBe(false)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(returnedScroller?.scrollTop).toBe(0)
    mocks.setDetail?.(detail)
    mocks.setLoading?.(false)
    await flushPromises()
    expect(returnedReady.value).toBe(true)
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: listWindowTop, behavior: 'instant' })
    expect(returnedScroller?.scrollTop).toBe(listTableTop)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()
    ledgerReturn.unmount()
  })

  it.each([
    { label: '桌面详情页', width: 1440, height: 900, windowTop: 90 },
    { label: '390×844 窄屏详情页', width: 390, height: 844, windowTop: 42 },
  ])('$label 从出处预览返回时在详情数据渲染后恢复页面位置', async ({ width, height, windowTop }) => {
    const detailPath = '/enterprises/91?back=view%3Denterprise%26q%3D%E5%BC%80%E8%AF%9A%26page%3D2%26expand%3D91'
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: windowTop })
    history.replaceState(null, '', detailPath)
    currentRoute = { params: { id: '91' }, query: { back: 'view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91' }, fullPath: detailPath }
    mocks.detail = fullDetail
    mocks.loading = false

    const source = mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    await flushPromises()
    const sourceLink = source.findAll('a').find((link) => link.text().includes('第 8 页'))
    expect(sourceLink).toBeDefined()
    await sourceLink!.trigger('click', { button: 0 })

    const previewUrl = new URL(sourceLink!.attributes('href')!, window.location.origin)
    expect(previewUrl.pathname).toBe('/preview')
    expect(previewUrl.searchParams.get('back')).toBe(detailPath)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain(`"back":"${detailPath}"`)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain(`"scrollY":${windowTop}`)
    source.unmount()

    history.pushState(null, '', detailPath)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    currentRoute = { params: { id: '91' }, query: { back: 'view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91' }, fullPath: detailPath }
    mocks.detail = null
    mocks.loading = true
    const frames: FrameRequestCallback[] = []
    const scrollTo = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('scrollTo', scrollTo)

    const returned = mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    await flushPromises()
    expect(scrollTo).not.toHaveBeenCalled()

    mocks.setDetail?.(fullDetail)
    mocks.setLoading?.(false)
    await flushPromises()
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: windowTop, behavior: 'instant' })
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()
    returned.unmount()
  })
})
