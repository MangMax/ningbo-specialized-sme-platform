// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RosterEnterpriseTable, { type EnterpriseRow } from '../../../layers/sme-roster/app/components/RosterEnterpriseTable.vue'
import RosterTitleTable, { type TitleRow } from '../../../layers/sme-roster/app/components/RosterTitleTable.vue'
import {
  hasEvidencePreviewReturn,
  rememberEvidencePreviewReturn,
  shouldNuxtScrollToTop,
  useEvidencePreviewScrollRestore,
} from '../../../layers/sme-roster/lib/roster/evidence-preview-return'
import type { RosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import EnterprisePage from '../../../layers/sme-roster/app/pages/enterprises/[id].vue'

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

const safeBack = '/roster?view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91'
const businessTimeline = {
  asOf: '2026-11-17',
  sources: [
    { source: 'publication', collectionStatus: 'not_applicable', collectedAt: null, events: [] },
    { source: 'recognized_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
    { source: 'business_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
    { source: 'apply_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
  ],
} satisfies RosterEnterpriseDetail['businessTimeline']

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
  businessTimeline,
  platform: { queries: [], relations: [], businessRecords: [] },
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
  businessTimeline,
  platform: { queries: [], relations: [], businessRecords: [] },
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
  RosterEnterpriseLaterProcesses: true,
  RosterEventChip: true,
  RosterSourceChip: true,
  RosterTitleBadge: true,
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
    vi.stubGlobal('useHead', vi.fn())
    vi.stubGlobal('$fetch', vi.fn(async () => ({})))
    currentRoute = { path: '/enterprises/91', params: { id: '91' }, query: {}, fullPath: '/enterprises/91' }
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
    frames[0]!(0)
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
    expect(scrollToTop({ fullPath: '/enterprises/91' }, { path: '/roster' })).toBe(true)
    // Nuxt may ask for its position after the ready-state restore consumed the session entry.
    expect(scrollToTop({ fullPath: '/enterprises/91' }, { path: '/preview' })).toBe(false)
    expect(shouldNuxtScrollToTop('/roster?view=title&page=2', '/enterprises/91')).toBe(false)
    expect(shouldNuxtScrollToTop('/roster?view=title&page=2', '/files')).toBe(true)
    sessionStorage.setItem(
      'roster:evidence-preview-return',
      JSON.stringify([{ back: '/enterprises/91', scrollY: 70, scrollTop: null, scrollLeft: null }]),
    )
    expect(scrollToTop({ fullPath: '/enterprises/91' }, { path: '/roster' })).toBe(false)
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
    expect(page.getComponent({ name: 'RosterEventChip' }).props('hideBatch')).toBe(true)
    page.unmount()
  })

  it('浏览器 Back 的默认企业 URL 匹配显式 view=enterprise 回链状态', async () => {
    const historyPath = '/roster?page=2&pageSize=100&expand=91'
    const savedBack = '/roster?view=enterprise&page=2&pageSize=100&expand=91'
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
      path: '/enterprises/91', params: { id: '91' },
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
    const returnPath = detailPath + '&tab=records&eventId=10'
    expect(previewUrl.searchParams.get('back')).toBe(returnPath)
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
    expect(chainedStates.find((state) => state.back === returnPath)).toMatchObject({
      back: returnPath,
      scrollY: detailWindowTop,
      scrollTop: null,
      scrollLeft: null,
    })
    detailPage.unmount()

    history.pushState(null, '', returnPath)
    currentRoute.fullPath = returnPath
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
    expect(JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!)).toEqual([
      { back: safeBack, scrollY: listWindowTop, scrollTop: listTableTop, scrollLeft: listTableLeft },
    ])
    const ledgerLink = detailReturn.findAll('a').find((link) => link.text().includes('企业列表'))
    expect(ledgerLink?.attributes('data-target')).toBe(
      JSON.stringify({ path: '/roster', query: { view: 'enterprise', q: '开诚', page: '2', expand: '91' } }),
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
    const ledgerPath = '/roster?view=title&district=%E6%B5%B7%E6%9B%99%E5%8C%BA&page=2'
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
      path: '/enterprises/35', params: { id: '35' },
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
    const returnPath = detailPath + '&tab=records&eventId=10'
    expect(previewUrl.searchParams.get('back')).toBe(returnPath)
    expect(JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!)).toEqual([
      { back: ledgerPath, scrollY: ledgerWindowTop, scrollTop: ledgerTableTop, scrollLeft: ledgerTableLeft },
      expect.objectContaining({ back: returnPath, scrollY: detailWindowTop, scrollTop: null, scrollLeft: null }),
    ])
    detailPage.unmount()

    history.pushState(null, '', returnPath)
    currentRoute.fullPath = returnPath
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
    detailFrames[0]!(0)
    expect(window.scrollY).toBe(detailWindowTop)
    expect(JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!)).toEqual([
      { back: ledgerPath, scrollY: ledgerWindowTop, scrollTop: ledgerTableTop, scrollLeft: ledgerTableLeft },
    ])
    const ledgerLink = detailReturn.findAll('a').find((link) => link.text().includes('企业列表'))
    expect(ledgerLink?.attributes('data-target')).toBe(
      JSON.stringify({ path: '/roster', query: { view: 'title', district: '海曙区', page: '2' } }),
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
    const nestedReturnTo = '/comparison?mode=record&queryIds=20&page=2&q=A%3FB&returnTo=%2Fcurrent-enterprises%3Fpage%3D4'
    const detailPath = '/enterprises/91?back=view%3Denterprise%26q%3D%E5%BC%80%E8%AF%9A%26page%3D2%26expand%3D91&returnTo=%2Fcomparison%3Fmode%3Drecord%26queryIds%3D20%26page%3D2%26q%3DA%253FB%26returnTo%3D%252Fcurrent-enterprises%253Fpage%253D4'
    const returnPath = detailPath + '&tab=records&eventId=10'
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: windowTop })
    history.replaceState(null, '', detailPath)
    currentRoute = { path: '/enterprises/91', params: { id: '91' }, query: { back: 'view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91', returnTo: nestedReturnTo }, fullPath: detailPath }
    mocks.detail = fullDetail
    mocks.loading = false

    const source = mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    await flushPromises()
    const sourceLink = source.findAll('a').find((link) => link.text().includes('第 8 页'))
    expect(sourceLink).toBeDefined()
    await sourceLink!.trigger('click', { button: 0 })

    const previewUrl = new URL(sourceLink!.attributes('href')!, window.location.origin)
    expect(previewUrl.pathname).toBe('/preview')
    expect(previewUrl.searchParams.get('back')).toBe(returnPath)
    expect(new URL(previewUrl.searchParams.get('back')!, window.location.origin).searchParams.get('returnTo')).toBe(nestedReturnTo)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain(`"back":"${returnPath}"`)
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain(`"scrollY":${windowTop}`)
    source.unmount()

    history.pushState(null, '', returnPath)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    currentRoute = { path: '/enterprises/91', params: { id: '91' }, query: { tab: 'records', eventId: '10', back: 'view=enterprise&q=%E5%BC%80%E8%AF%9A&page=2&expand=91', returnTo: nestedReturnTo }, fullPath: returnPath }
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
    expect(returned.find('[aria-label="正式公布文件"]').exists()).toBe(true)
    await flushPromises()
    mocks.setDetail?.(structuredClone(fullDetail))
    await flushPromises()
    expect(frames).toHaveLength(1)
    expect(document.activeElement?.textContent).toBe('第 8 页')
    expect(document.activeElement?.closest('[data-event-id]')?.getAttribute('data-event-id')).toBe('10')
    expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()
    returned.unmount()
  })

  it('restores the rendered publication without waiting for retired correspondence reads', async () => {
    history.replaceState(null, '', '/enterprises/91')
    currentRoute = { path: '/enterprises/91', params: { id: '91' }, query: {}, fullPath: '/enterprises/91' }
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 })
    rememberEvidencePreviewReturn(currentRoute.fullPath)
    mocks.detail = fullDetail
    const frames: FrameRequestCallback[] = []
    const scrollTo = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('scrollTo', scrollTo)
    const fetch = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('$fetch', fetch)
    const page = mount(EnterprisePage, { attachTo: document.body, global: { stubs: globalStubs } })
    await flushPromises()
    expect(page.find('[aria-label="正式公布文件"]').exists()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)
    frames[0]!(0)
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 420, behavior: 'instant' })
    page.unmount()
  })
})
