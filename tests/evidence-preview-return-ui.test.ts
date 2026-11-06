// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, reactive, ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RosterEnterpriseTable, { type EnterpriseRow } from '../components/RosterEnterpriseTable.vue'
import RosterTitleTable, { type TitleRow } from '../components/RosterTitleTable.vue'
import {
  hasEvidencePreviewReturn,
  rememberEvidencePreviewReturn,
  shouldNuxtScrollToTop,
  useEvidencePreviewScrollRestore,
} from '../lib/roster/evidence-preview-return'
import EnterprisePage from '../pages/enterprises/[id].vue'
import RecordEventRow from '../components/record-correspondence/RecordEventRow.vue'

vi.mock('@tanstack/vue-virtual', async () => {
  const { computed } = await import('vue')
  return {
    useVirtualizer: (options: { value: { count: number } }) =>
      computed(() => ({
        getVirtualItems: () => [],
        getTotalSize: () => options.value.count * 44,
      })),
  }
})

const mocks = vi.hoisted(() => ({
  detail: null as unknown,
  loading: false,
  setDetail: null as ((value: unknown) => void) | null,
  setLoading: null as ((value: boolean) => void) | null,
}))

const DETAIL_OPEN_EVIDENCE_STATE_KEY = 'roster:enterprise-detail-open-evidence'

vi.mock('@pinia/colada', async () => {
  const { ref } = await import('vue')
  return {
    useQuery: (options: { key: () => unknown[] }) => {
      if (options.key()[0] !== 'roster-enterprise') {
        return { data: ref({ rows: [], nextCursor: null }), isLoading: ref(false), error: ref(null), refetch: vi.fn() }
      }
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
  enterprise: { enterpriseId: 91, name: '宁波开诚生态技术有限公司', uscc: null, district: '海曙区' },
  aliases: [],
  records: [
    {
      id: 1,
      titleCode: 'specialized_sme',
      source: 'jxj',
      district: '海曙区',
    },
  ],
  events: [{ id: 10, recordId: 1, eventType: 'award', year: 2022, batchSeq: 1, decidedYear: null, reviewOutcome: null }],
  evidence: [{ eventId: 10, sourceFile: 'jxj/announcement/test.pdf', attachment: '附件二', listNo: 6, page: 8 }],
  platform: { queries: [], relations: [] },
}

const titleRow: TitleRow = {
  enterpriseId: 35,
  name: '宁波称号视图回归企业有限公司',
  uscc: null,
  district: '海曙区',
  titleCode: 'specialized_sme',
  sources: ['jxj'],
  events: [{
    type: 'award',
    year: 2022,
    seq: 1,
    source: 'jxj',
    evidence: [{ sourceFile: 'jxj/announcement/title-view.pdf', attachment: '附件一', listNo: 3, page: 7 }],
  }],
}

let currentRoute: Record<string, unknown>
let capturedPageMeta: Record<string, unknown>
let openedTitleRowPath = ''

// The detail page imports router composables explicitly; keep the route fixture
// shared with the roster harness instead of relying on Nuxt auto-import globals.
vi.mock('vue-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-router')>(),
  useRoute: () => currentRoute,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  onBeforeRouteLeave: vi.fn(),
}))

const NuxtLinkStub = {
  props: ['to'],
  template:
    '<a :href="typeof to === \'string\' ? to : JSON.stringify(to)" :data-target="typeof to === \'string\' ? to : JSON.stringify(to)"><slot /></a>',
}
const CollapsibleStub = defineComponent({
  props: { open: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => h('div', slots.default?.({ open: props.open }))
  },
})
const globalStubs = {
  NuxtLink: NuxtLinkStub,
  PageHeader: {
    props: ['title'],
    template:
      '<header><h1>{{ title }}</h1><slot name="breadcrumb"/><slot name="description"/><slot name="actions"/></header>',
  },
  FilePreviewDialog: true,
  RecordSourceReader: true,
  EnterpriseLaterProcesses: true,
  PlatformRecords: true,
  EventChip: true,
  SourceChip: true,
  TitleBadge: true,
  Badge: true,
  Button: { template: '<button><slot /></button>' },
  Collapsible: CollapsibleStub,
  CollapsibleContent: { template: '<div><slot /></div>' },
  CollapsibleTrigger: { template: '<button><slot /></button>' },
  Skeleton: true,
  // This suite controls animation frames to assert scroll restoration. Tab
  // entrance/indicator animations are unrelated and would consume those frames.
  TabsContent: { template: '<div><slot /></div>' },
  TabsTrigger: { template: '<button><slot /></button>' },
}

const passThrough = (tag: string) =>
  defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.())
    },
  })

const titleTableStubs = {
  ...globalStubs,
  Table: passThrough('table'),
  TableHeader: passThrough('thead'),
  TableBody: passThrough('tbody'),
  TableRow: passThrough('tr'),
  TableHead: passThrough('th'),
  TableCell: passThrough('td'),
  HoverCard: passThrough('div'),
  HoverCardTrigger: passThrough('div'),
  HoverCardContent: passThrough('div'),
  Empty: passThrough('div'),
  EmptyHeader: passThrough('div'),
  EmptyMedia: passThrough('div'),
  EmptyTitle: passThrough('div'),
  EmptyDescription: passThrough('div'),
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

function titleLedgerHarness(ready: Ref<boolean>) {
  return defineComponent({
    setup() {
      useEvidencePreviewScrollRestore(ready)
      return () =>
        h(RosterTitleTable, {
          rows: ready.value ? [titleRow] : [],
          loading: !ready.value,
          hasError: false,
          backQuery: 'view=title&district=%E6%B5%B7%E6%9B%99%E5%8C%BA&page=2',
          onOpen: (path: string) => (openedTitleRowPath = path),
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
    currentRoute = { params: { id: '91' }, query: {}, fullPath: '/enterprises/91' }
    capturedPageMeta = {}
    openedTitleRowPath = ''
    vi.stubGlobal('useRoute', () => currentRoute)
    vi.stubGlobal('definePageMeta', (meta: Record<string, unknown>) => {
      capturedPageMeta = meta
    })
  })

  it.each([
    { label: '桌面表格滚动', width: 1440, height: 900, tableTop: 383, tableLeft: 0, windowTop: 90 },
    { label: '390×844 窄屏表格滚动', width: 390, height: 844, tableTop: 339, tableLeft: 644, windowTop: 42 },
  ])('$label 保留筛选 / 页码 / 展开行,并在表格与详情渲染后恢复三层滚动', async ({ width, height, tableTop, tableLeft, windowTop }) => {
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
    tableScroller!.scrollLeft = tableLeft

    const sourceLink = source.findAll('a').find((link) => link.text().includes('第 8 页'))
    expect(sourceLink).toBeDefined()
    await sourceLink!.trigger('click', { button: 0 })

    const previewUrl = new URL(sourceLink!.attributes('href')!, window.location.origin)
    expect(previewUrl.pathname).toBe('/preview')
    expect(previewUrl.searchParams.get('back')).toBe(safeBack)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain(`"scrollY":${windowTop}`)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain(`"scrollTop":${tableTop}`)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain(`"scrollLeft":${tableLeft}`)
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
    for (let i = 0; i < 5; i++) { frames.splice(0).forEach(frame => frame(0)); await flushPromises() }
    expect(scrollTo).toHaveBeenCalledWith({ top: windowTop, behavior: 'instant' })
    expect(returnedScroller!.scrollTop).toBe(tableTop)
    expect(returnedScroller!.scrollLeft).toBe(tableLeft)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()

    returned.unmount()
  })

  it('详情和名录返回依来源路由关闭 Nuxt 自动归顶', () => {
    mocks.detail = fullDetail
    mocks.loading = false
    const detailPage = mount(EnterprisePage, {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    const scrollToTop = capturedPageMeta.scrollToTop as (
      to: { fullPath: string },
      from: { path: string },
    ) => boolean
    expect(scrollToTop({ fullPath: '/enterprises/91' }, { path: '/' })).toBe(true)
    // Nuxt may ask for its position after the ready-state restore consumed the session entry.
    expect(scrollToTop({ fullPath: '/enterprises/91' }, { path: '/preview' })).toBe(false)
    expect(shouldNuxtScrollToTop('/?view=title&page=2', '/enterprises/91')).toBe(false)
    expect(shouldNuxtScrollToTop('/?view=title&page=2', '/files')).toBe(true)
    sessionStorage.setItem(
      'roster:evidence-preview-return',
      JSON.stringify([{ back: '/enterprises/91', scrollY: 70, scrollTop: null, scrollLeft: null }]),
    )
    expect(scrollToTop({ fullPath: '/enterprises/91' }, { path: '/' })).toBe(false)
    detailPage.unmount()
  })

  it('企业事件把原认定年与复核结论年分开显示，并翻译复核结果', async () => {
    mocks.detail = {
      ...fullDetail,
      events: [{ id: 11, recordId: 1, eventType: 'review', year: 2021, batchSeq: 2, decidedYear: 2024, reviewOutcome: 'failed' }],
      evidence: [],
    }
    const page = mount(EnterprisePage, {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    await flushPromises()
    expect(page.text()).toContain('原认定 2021 年 · 复核结论 2024 年 · 复核不通过')
    expect(page.text()).not.toContain('failed')
    expect(page.getComponent({ name: 'EventChip' }).attributes('hide-batch')).toBe('true')
    page.unmount()
  })

  it('浏览器 Back 的默认企业 URL 匹配显式 view=enterprise 回链状态', async () => {
    const historyPath = '/?page=2&pageSize=100&expand=91'
    const savedBack = '/?view=enterprise&page=2&pageSize=100&expand=91'
    sessionStorage.setItem(
      'roster:evidence-preview-return',
      JSON.stringify([{ back: savedBack, scrollY: 96, scrollTop: 1538, scrollLeft: 0 }]),
    )
    history.replaceState(null, '', historyPath)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    expect(hasEvidencePreviewReturn(historyPath)).toBe(true)
    expect(shouldNuxtScrollToTop(historyPath, '/enterprises/91')).toBe(false)

    const frames: FrameRequestCallback[] = []
    const scrollTo = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('scrollTo', scrollTo)
    const ready = ref(true)
    const returned = mount(ledgerHarness(ready), {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    await flushPromises()
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    const scroller = returned.element.querySelector('[data-evidence-return-scroll-container]') as HTMLElement
    expect(scroller.scrollTop).toBe(1538)
    expect(scroller.scrollLeft).toBe(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: 96, behavior: 'instant' })
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()
    returned.unmount()
  })

  it('详情来源预览后真实 history.back 在恢复状态已消费时仍抑制 Nuxt 顶端复位', async () => {
    const detailPath = '/enterprises/91?back=view%3Dtitle%26page%3D2'
    history.replaceState(null, '', detailPath)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 70 })
    rememberEvidencePreviewReturn(detailPath)
    history.pushState(null, '', `/preview?file=synthetic.pdf&back=${encodeURIComponent(detailPath)}`)

    // 页面恢复钩子会先消费 sessionStorage；Nuxt 的 delayed scrollBehavior 随后才计算位置。
    sessionStorage.removeItem('roster:evidence-preview-return')
    const returned = new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true })
    })
    history.back()
    await returned

    expect(`${window.location.pathname}${window.location.search}`).toBe(detailPath)
    expect(shouldNuxtScrollToTop(detailPath, '')).toBe(false)
  })

  it('从名录行进详情再经预览返回，保留名录筛选、页码、展开行和表格滚动', async () => {
    const listWindowTop = 90
    const listTableTop = 383
    const listTableLeft = 128
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
    rosterScroller!.scrollLeft = listTableLeft
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
      scrollLeft: number | null
    }[]
    expect(rosterState).toHaveLength(1)
    expect(rosterState[0]).toEqual({ back: safeBack, scrollY: listWindowTop, scrollTop: listTableTop, scrollLeft: listTableLeft })
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
      scrollLeft: number | null
    }[]
    expect(chainedStates).toHaveLength(2)
    expect(chainedStates.find((state) => state.back === safeBack)).toEqual({
      back: safeBack,
      scrollY: listWindowTop,
      scrollTop: listTableTop,
      scrollLeft: listTableLeft,
    })
    expect(chainedStates.find((state) => state.back === detailPath)).toEqual({
      back: detailPath,
      scrollY: detailWindowTop,
      scrollTop: null,
      scrollLeft: null,
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
    for (let i = 0; i < 5; i++) { frames.splice(0).forEach(frame => frame(0)); await flushPromises() }
    expect(scrollTo).toHaveBeenCalledWith({ top: detailWindowTop, behavior: 'instant' })
    expect(JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!)).toEqual([
      { back: safeBack, scrollY: listWindowTop, scrollTop: listTableTop, scrollLeft: listTableLeft },
    ])
    const ledgerLink = detailReturn.findAll('a').find((link) => link.text().includes('企业列表'))
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
    expect(returnedScroller?.scrollLeft).toBe(0)
    mocks.setDetail?.(detail)
    mocks.setLoading?.(false)
    await flushPromises()
    expect(returnedReady.value).toBe(true)
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: listWindowTop, behavior: 'instant' })
    expect(returnedScroller?.scrollTop).toBe(listTableTop)
    expect(returnedScroller?.scrollLeft).toBe(listTableLeft)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()
    ledgerReturn.unmount()
  })

  it('称号视图名称入口保留 view/page 和表格滚动，并完成详情预览返回链', async () => {
    const ledgerPath = '/?view=title&district=%E6%B5%B7%E6%9B%99%E5%8C%BA&page=2'
    const backQuery = 'view=title&district=%E6%B5%B7%E6%9B%99%E5%8C%BA&page=2'
    const detailPath = `/enterprises/35?back=${encodeURIComponent(backQuery)}`
    const ledgerWindowTop = 70
    const ledgerTableTop = 247
    const ledgerTableLeft = 96
    const detailWindowTop = 118

    history.replaceState(null, '', ledgerPath)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: ledgerWindowTop })
    const titleLedger = mount(titleLedgerHarness(ref(true)), {
      attachTo: document.body,
      global: { stubs: titleTableStubs },
    })
    await flushPromises()
    const titleScroller = titleLedger.element as HTMLElement
    expect(titleScroller.matches('[data-evidence-return-scroll-container]')).toBe(true)
    titleScroller.scrollTop = ledgerTableTop
    titleScroller.scrollLeft = ledgerTableLeft

    const enterpriseNameLink = titleLedger
      .findAll('a')
      .find((link) => link.text().includes(titleRow.name))
    expect(enterpriseNameLink).toBeDefined()
    const titleDetailUrl = new URL(enterpriseNameLink!.attributes('href')!, window.location.origin)
    expect(titleDetailUrl.pathname).toBe('/enterprises/35')
    expect(titleDetailUrl.searchParams.get('back')).toBe(backQuery)
    expect(titleDetailUrl.searchParams.get('back')).toContain('district=%E6%B5%B7%E6%9B%99%E5%8C%BA')
    await enterpriseNameLink!.trigger('click', { button: 0 })
    expect(openedTitleRowPath).toBe('')
    const ledgerState = JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!) as {
      back: string
      scrollY: number
      scrollTop: number | null
      scrollLeft: number | null
    }[]
    expect(ledgerState).toEqual([
      { back: ledgerPath, scrollY: ledgerWindowTop, scrollTop: ledgerTableTop, scrollLeft: ledgerTableLeft },
    ])
    sessionStorage.removeItem('roster:evidence-preview-return')
    const sourceLink = titleLedger.findAll('a').find((link) => link.text().includes('第 7 页'))
    expect(sourceLink).toBeDefined()
    const sourceUrl = new URL(sourceLink!.attributes('href')!, window.location.origin)
    expect(sourceUrl.pathname).toBe('/preview')
    expect(sourceUrl.searchParams.get('file')).toBe('jxj/announcement/title-view.pdf')
    expect(sourceUrl.searchParams.get('page')).toBe('7')
    expect(sourceUrl.searchParams.get('back')).toBe(ledgerPath)
    await sourceLink!.trigger('click', { button: 0 })
    expect(JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!)).toEqual([
      { back: ledgerPath, scrollY: ledgerWindowTop, scrollTop: ledgerTableTop, scrollLeft: ledgerTableLeft },
    ])
    titleLedger.unmount()

    history.pushState(null, '', detailPath)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: detailWindowTop })
    currentRoute = {
      params: { id: '35' },
      query: { back: backQuery },
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
    expect(previewUrl.pathname).toBe('/preview')
    expect(previewUrl.searchParams.get('back')).toBe(detailPath)
    expect(JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!)).toEqual([
      { back: ledgerPath, scrollY: ledgerWindowTop, scrollTop: ledgerTableTop, scrollLeft: ledgerTableLeft },
      { back: detailPath, scrollY: detailWindowTop, scrollTop: null, scrollLeft: null },
    ])
    detailPage.unmount()

    history.pushState(null, '', detailPath)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    mocks.detail = null
    mocks.loading = true
    const detailFrames: FrameRequestCallback[] = []
    const detailScrollTo = vi.fn((position: ScrollToOptions) => {
      Object.defineProperty(window, 'scrollY', {
        configurable: true,
        value: position.top ?? window.scrollY,
      })
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      detailFrames.push(callback)
      return detailFrames.length
    })
    vi.stubGlobal('scrollTo', detailScrollTo)
    const detailReturn = mount(EnterprisePage, {
      attachTo: document.body,
      global: { stubs: globalStubs },
    })
    await flushPromises()
    expect(detailScrollTo).not.toHaveBeenCalled()
    mocks.setDetail?.(fullDetail)
    mocks.setLoading?.(false)
    await flushPromises()
    expect(detailFrames).toHaveLength(1)
    for (let i = 0; i < 5; i++) { detailFrames.splice(0).forEach(frame => frame(0)); await flushPromises() }
    expect(window.scrollY).toBe(detailWindowTop)
    expect(JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!)).toEqual([
      { back: ledgerPath, scrollY: ledgerWindowTop, scrollTop: ledgerTableTop, scrollLeft: ledgerTableLeft },
    ])
    const ledgerLink = detailReturn.findAll('a').find((link) => link.text().includes('企业列表'))
    expect(ledgerLink?.attributes('data-target')).toBe(
      JSON.stringify({ path: '/', query: { view: 'title', district: '海曙区', page: '2' } }),
    )
    detailReturn.unmount()

    history.pushState(null, '', ledgerPath)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    const titleReady = ref(false)
    const titleFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      titleFrames.push(callback)
      return titleFrames.length
    })
    detailScrollTo.mockClear()
    const ledgerReturn = mount(titleLedgerHarness(titleReady), {
      attachTo: document.body,
      global: { stubs: titleTableStubs },
    })
    await flushPromises()
    expect(titleReady.value).toBe(false)
    expect(detailScrollTo).not.toHaveBeenCalled()
    titleReady.value = true
    await flushPromises()
    expect(titleFrames).toHaveLength(1)
    titleFrames[0]!(0)
    const restoredTitleScroller = ledgerReturn.element as HTMLElement
    expect(restoredTitleScroller.matches('[data-evidence-return-scroll-container]')).toBe(true)
    expect(restoredTitleScroller.scrollTop).toBe(ledgerTableTop)
    expect(restoredTitleScroller.scrollLeft).toBe(ledgerTableLeft)
    expect(window.scrollY).toBe(ledgerWindowTop)
    expect(window.location.pathname + window.location.search).toBe(ledgerPath)
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
    expect(JSON.parse(sessionStorage.getItem(DETAIL_OPEN_EVIDENCE_STATE_KEY)!)).toEqual({
      back: detailPath,
      keys: [JSON.stringify(['91', 10])],
      sourceKeys: [JSON.stringify(['91', 10])],
    })
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
    for (let i = 0; i < 5; i++) { frames.splice(0).forEach(frame => frame(0)); await flushPromises() }
    expect(scrollTo).toHaveBeenCalledWith({ top: windowTop, behavior: 'instant' })
    expect(returned.findAll('button').some((button) => button.text().includes('来源记录'))).toBe(true)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()
    expect(sessionStorage.getItem(DETAIL_OPEN_EVIDENCE_STATE_KEY)).toBeNull()
    returned.unmount()
  })

  it('restores the inner source disclosure once and respects a later user collapse', async () => {
    mocks.detail = fullDetail
    const mountPage = () => mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    const source = mountPage()
    await flushPromises()
    const button = (page: ReturnType<typeof mountPage>, text: string) => page.find('#record-event-10').findAll('button').find(b => b.text() === text)!
    await button(source, '来源记录').trigger('click')
    await flushPromises()
    expect(button(source, '正式文件与已登记出处').attributes('aria-expanded')).toBe('false')
    await button(source, '正式文件与已登记出处').trigger('click')
    await flushPromises()
    expect(button(source, '正式文件与已登记出处').attributes('aria-expanded')).toBe('true')
    await source.find('#record-event-10').findAll('a').find(a => a.text() === '第 8 页')!.trigger('click', { button: 0 })
    source.unmount()
    const returned = mountPage()
    await flushPromises()
    expect(button(returned, '正式文件与已登记出处').attributes('aria-expanded')).toBe('true')
    expect(returned.find('#record-event-10 [data-testid="record-event-source"]').isVisible()).toBe(true)
    expect(sessionStorage.getItem(DETAIL_OPEN_EVIDENCE_STATE_KEY)).toBeNull()
    await button(returned, '正式文件与已登记出处').trigger('click')
    await flushPromises()
    mocks.setDetail?.({ ...fullDetail })
    await flushPromises()
    expect(button(returned, '正式文件与已登记出处').attributes('aria-expanded')).toBe('false')
    returned.unmount()
  })

  it.each([
    ['first visit', null],
    ['malformed JSON', '{'],
    ['different full back', JSON.stringify({ back: '/enterprises/91?back=page%3D2', keys: ['["91",10]'], sourceKeys: ['["91",10]'] })],
    ['different enterprise', JSON.stringify({ back: '/enterprises/91', keys: ['["92",10]'], sourceKeys: ['["92",10]'] })],
    ['absent event', JSON.stringify({ back: '/enterprises/91', keys: ['["91",99]'], sourceKeys: ['["91",99]'] })],
    ['invalid source keys', JSON.stringify({ back: '/enterprises/91', keys: ['["91",10]'], sourceKeys: [10] })],
  ])('keeps inner sources closed for %s', async (_label, saved) => {
    mocks.detail = fullDetail
    if (saved) sessionStorage.setItem(DETAIL_OPEN_EVIDENCE_STATE_KEY, saved)
    const page = mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    await flushPromises()
    const row = page.find('#record-event-10')
    const outer = row.findAll('button').find(b => b.text() === '来源记录')!
    if (outer.attributes('aria-expanded') === 'false') await outer.trigger('click')
    await flushPromises()
    expect(row.findAll('button').find(b => b.text() === '正式文件与已登记出处')!.attributes('aria-expanded')).toBe('false')
    expect(sessionStorage.getItem(DETAIL_OPEN_EVIDENCE_STATE_KEY)).toBeNull()
    page.unmount()
  })

  it.each(['back', 'enterprise', 'tab'])('isolates restored sources and clears them on %s change', async change => {
    currentRoute = reactive({ params: { id: '91' }, query: {}, fullPath: '/enterprises/91' })
    mocks.detail = { ...fullDetail, events: [...fullDetail.events, { ...fullDetail.events[0], id: 11 }], evidence: [...fullDetail.evidence, { ...fullDetail.evidence[0], eventId: 11 }] }
    sessionStorage.setItem(DETAIL_OPEN_EVIDENCE_STATE_KEY, JSON.stringify({ back: '/enterprises/91', keys: ['["91",10]', '["91",11]'], sourceKeys: ['["91",10]'] }))
    const page = mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    await flushPromises()
    const inner = (id: number) => page.find(`#record-event-${id}`).findAll('button').find(b => b.text() === '正式文件与已登记出处')!
    expect(inner(10).attributes('aria-expanded')).toBe('true')
    expect(inner(11).attributes('aria-expanded')).toBe('false')
    if (change === 'enterprise') currentRoute.params = { id: '92' }
    if (change === 'tab') currentRoute.query = { tab: 'review' }
    currentRoute.fullPath = change === 'enterprise' ? '/enterprises/92' : `/enterprises/91?${change}=other`
    await flushPromises()
    currentRoute.params = { id: '91' }
    currentRoute.query = {}
    currentRoute.fullPath = '/enterprises/91'
    await flushPromises()
    await page.find('#record-event-10').findAll('button').find(b => b.text() === '来源记录')!.trigger('click')
    await flushPromises()
    expect(inner(10).attributes('aria-expanded')).toBe('false')
    page.unmount()
  })

  it('keeps source navigation usable when session storage throws', async () => {
    mocks.detail = fullDetail
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied') })
    const page = mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    try {
      await flushPromises()
      const button = (text: string) => page.find('#record-event-10').findAll('button').find(b => b.text() === text)!
      await button('来源记录').trigger('click')
      await flushPromises()
      await button('正式文件与已登记出处').trigger('click')
      await flushPromises()
      expect(button('正式文件与已登记出处').attributes('aria-expanded')).toBe('true')
      const link = page.find('#record-event-10').findAll('a').find(a => a.text() === '第 8 页')!
      expect(link.attributes('href')).toContain('/preview?')
      await link.trigger('click', { button: 0 })
    } finally { page.unmount(); get.mockRestore(); set.mockRestore() }
  })

  it('keeps the review consumer uncontrolled and preserves automatic error disclosure', async () => {
    const page = mount(RecordEventRow, {
      attachTo: document.body,
      props: {
        event: { id: 10, recordId: 1, type: 'award', year: 2022, seq: 1, decidedYear: null, reviewOutcome: null, titleCode: 'specialized_sme', source: 'jxj', district: null },
        evidence: fullDetail.evidence, edges: [], back: '/enterprises/91?tab=review', open: true, review: true,
      },
      global: { stubs: globalStubs },
    })
    await flushPromises()
    const inner = () => page.findAll('button').find(b => b.text() === '正式文件与已登记出处')!
    expect(inner().attributes('aria-expanded')).toBe('false')
    await inner().trigger('click')
    await flushPromises()
    expect(inner().attributes('aria-expanded')).toBe('true')
    await inner().trigger('click')
    await flushPromises()
    expect(inner().attributes('aria-expanded')).toBe('false')
    await page.setProps({ detailsError: true })
    expect(inner().attributes('aria-expanded')).toBe('true')
    await page.setProps({ detailsError: false, edges: [{
      id: 1, type: 'event_process', role: 'source', status: 'confirmed', eventId: 10,
      predecessorEventId: null, relationId: 1, exportRowId: null, enterpriseId: 91,
      titleCode: 'specialized_sme', revision: 1, requiresRevalidation: true,
      ruleId: 'synthetic', ruleVersion: '1', createdAt: '2026-01-01', decidedAt: null, endedAt: null,
    }] })
    expect(inner().attributes('aria-expanded')).toBe('true')
    page.unmount()
  })

  it.each(['complete', 'inner collapse', 'outer collapse', 'route', 'enterprise', 'event removed', 'unmount', 'no animation', 'animation cancelled'])('waits for restored disclosure animations and handles %s', async outcome => {
    history.replaceState(null, '', '/enterprises/91')
    currentRoute = reactive({ params: { id: '91' }, query: {}, fullPath: '/enterprises/91' })
    mocks.detail = fullDetail
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 })
    rememberEvidencePreviewReturn('/enterprises/91')
    sessionStorage.setItem(DETAIL_OPEN_EVIDENCE_STATE_KEY, JSON.stringify({
      back: '/enterprises/91', keys: ['["91",10]'], sourceKeys: ['["91",10]'],
    }))
    let finish!: () => void
    let cancel!: () => void
    const finished = new Promise<void>((resolve, reject) => { finish = resolve; cancel = () => reject(new Error("animation cancelled")) })
    const animations = vi.spyOn(Element.prototype, 'getAnimations').mockReturnValue(outcome === 'no animation' ? [] : [{ finished } as Animation])
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    const pump = async () => {
      for (let i = 0; i < 5; i++) {
        frames.splice(0).forEach(frame => frame(0))
        await flushPromises()
      }
    }
    const page = mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    await flushPromises()
    await pump()
    if (outcome !== 'no animation') expect(scrollTo).not.toHaveBeenCalled()
    if (outcome.endsWith('collapse')) {
      const title = outcome === 'inner collapse' ? '正式文件与已登记出处' : '来源记录'
      await page.find('#record-event-10').findAll('button').find(button => button.text() === title)!.trigger('click')
    }
    if (outcome === 'route') currentRoute.fullPath = '/enterprises/91?back=changed'
    if (outcome === 'enterprise') currentRoute.params.id = '92'
    if (outcome === 'event removed') mocks.setDetail?.({ ...fullDetail, records: [] })
    if (outcome === 'unmount') page.unmount()
    await flushPromises()
    if (outcome === 'event removed') mocks.setDetail?.(fullDetail)
    if (outcome === 'animation cancelled') cancel()
    else finish()
    await flushPromises()
    await pump()
    if (outcome === 'complete' || outcome === 'no animation') expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 420, behavior: 'instant' })
    else expect(scrollTo).not.toHaveBeenCalled()
    if (outcome !== 'unmount') page.unmount()
    animations.mockRestore()
  })

  it('waits for event source rows to settle before restoring an enterprise preview return', async () => {
    history.replaceState(null, '', '/enterprises/91')
    currentRoute = { params: { id: '91' }, query: {}, fullPath: '/enterprises/91' }
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 })
    rememberEvidencePreviewReturn(currentRoute.fullPath)
    mocks.detail = fullDetail
    const frames: FrameRequestCallback[] = []
    const scrollTo = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('scrollTo', scrollTo)
    let settle!: (value: unknown) => void
    vi.stubGlobal('$fetch', vi.fn((url: string) => url === '/api/roster/correspondences'
      ? new Promise(resolve => { settle = resolve }) : Promise.resolve({})))
    const page = mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    await flushPromises()
    expect(frames).toHaveLength(0)
    settle({ rows: [], total: 0, page: 1, pageSize: 200 })
    await flushPromises()
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 420, behavior: 'instant' })
    page.unmount()
  })
})
