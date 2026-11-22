// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from '@pinia/colada'
import EnterpriseListTable from '../../../layers/sme-roster/app/components/EnterpriseListTable.vue'
import EnterpriseDrawer from '../../../layers/sme-roster/app/components/EnterpriseDrawer.vue'
import type { RosterEventRow } from '../../../layers/sme-roster/lib/roster/enterprise-roster'

vi.mock('@pinia/colada', () => ({ useQuery: vi.fn() }))

const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })
const refetch = vi.fn()

const mounted: ReturnType<typeof mount>[] = []
let queryData: ReturnType<typeof ref>
let queryLoading: ReturnType<typeof ref>
let queryError: ReturnType<typeof ref>

function detailWithDifference(patch: Record<string, unknown> = {}) {
  return {
    enterprise: {
      enterpriseId: 1,
      name: '宁波已确认无差异企业',
      uscc: '91330211000000012X',
      district: '鄞州区',
      aliasNames: [],
      firstRecognition: [],
      nextReviewYear: null,
      anchorNeedsReview: false,
    },
    businessTimeline: { asOf: '2026-11-16', sources: ['publication', 'recognized_list', 'business_list', 'apply_list'].map(source => ({ source, collectionStatus: 'not_collected', collectedAt: null, events: [] })) },
    aliases: [],
    records: [],
    events: [],
    evidence: [],
    differences: [{
      explanationId: 1,
      titleCode: 'specialized_sme',
      direction: 'extra_in_miit',
      status: 'confirmed_no_diff',
      reasonCode: null,
      reasonNote: null,
      measureCode: 'none',
      measureNote: null,
      verificationStatus: 'confirmed',
      inCurrentDifference: false,
      ...patch,
    }],
  }
}

function mountDrawer(returnFocusTarget: HTMLButtonElement | null = null) {
  const wrapper = mount(EnterpriseDrawer, {
    props: { enterpriseId: 1, backQuery: '', returnFocusTarget },
    global: {
      stubs: {
        DialogContent: {
          name: 'DialogContentStub',
          emits: ['interactOutside', 'openAutoFocus', 'closeAutoFocus'],
          template: '<section><slot /></section>',
        },
        DialogTitle: { template: '<h2><slot /></h2>' },
        Button: { inheritAttrs: false, template: '<button v-bind="$attrs"><slot /></button>' },
        Skeleton: { template: '<div />' },
        NuxtLink: { template: '<a><slot /></a>' },
      },
    },
  })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => {
  vi.stubGlobal('$fetch', vi.fn())
  queryData = ref(null)
  queryLoading = ref(true)
  queryError = ref(null)
  vi.mocked(useQuery).mockReturnValue({
    data: queryData,
    isLoading: queryLoading,
    error: queryError,
    refetch,
  } as never)
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.clearAllMocks()
})

describe('企业详情抽屉的异步状态', () => {
  it.each([
    ['加载中', () => {}],
    ['加载失败', () => { queryError.value = new Error('detail request failed') }],
  ])('%s时仍提供可用的关闭按钮', async (_state, prepare) => {
    prepare()
    const wrapper = mountDrawer()
    const close = wrapper.get('[data-testid="enterprise-drawer"] button[aria-label="关闭"]')

    await close.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('企业详情抽屉的焦点返回', () => {
  it('主动关闭时将焦点还给打开抽屉的企业按钮', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    const wrapper = mountDrawer(trigger)
    const content = wrapper.findComponent({ name: 'DialogContentStub' })
    const closeEvent = new Event('closeAutoFocus', { cancelable: true })

    content.vm.$emit('closeAutoFocus', closeEvent)

    expect(document.activeElement).toBe(trigger)
    expect(closeEvent.defaultPrevented).toBe(true)
    trigger.remove()
  })

  it('没有显式触发器 prop 时从打开焦点记录表格按钮', () => {
    const tableBody = document.createElement('tbody')
    const trigger = document.createElement('button')
    tableBody.append(trigger)
    document.body.append(tableBody)
    trigger.focus()
    const wrapper = mountDrawer()
    const content = wrapper.findComponent({ name: 'DialogContentStub' })

    content.vm.$emit('openAutoFocus', new Event('openAutoFocus'))
    const closeEvent = new Event('closeAutoFocus', { cancelable: true })
    content.vm.$emit('closeAutoFocus', closeEvent)

    expect(document.activeElement).toBe(trigger)
    expect(closeEvent.defaultPrevented).toBe(true)
    tableBody.remove()
  })

  it('由 Dialog 的关闭自动聚焦事件恢复触发器焦点', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    const wrapper = mountDrawer(trigger)

    await wrapper.setProps({ enterpriseId: null })
    expect(document.activeElement).not.toBe(trigger)
    const closeEvent = new Event('closeAutoFocus', { cancelable: true })
    wrapper.findComponent({ name: 'DialogContentStub' }).vm.$emit('closeAutoFocus', closeEvent)

    expect(document.activeElement).toBe(trigger)
    expect(closeEvent.defaultPrevented).toBe(true)
    trigger.remove()
  })

  it('外部交互后由打开状态 watcher 关闭时保留外部焦点', async () => {
    const trigger = document.createElement('button')
    const outside = document.createElement('button')
    document.body.append(trigger, outside)
    const wrapper = mountDrawer(trigger)
    const content = wrapper.findComponent({ name: 'DialogContentStub' })
    outside.focus()
    content.vm.$emit('interactOutside', new Event('interactOutside', { cancelable: true }))

    await wrapper.setProps({ enterpriseId: null })

    expect(document.activeElement).toBe(outside)
    const closeEvent = new Event('closeAutoFocus', { cancelable: true })
    content.vm.$emit('closeAutoFocus', closeEvent)

    expect(closeEvent.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(outside)
    trigger.remove()
    outside.remove()
  })

  it('外部交互关闭时保留外部元素的焦点', () => {
    const trigger = document.createElement('button')
    const outside = document.createElement('button')
    document.body.append(trigger, outside)
    const wrapper = mountDrawer(trigger)
    const content = wrapper.findComponent({ name: 'DialogContentStub' })

    content.vm.$emit('interactOutside', new Event('interactOutside', { cancelable: true }))
    outside.focus()
    content.vm.$emit('closeAutoFocus', new Event('closeAutoFocus', { cancelable: true }))

    expect(document.activeElement).toBe(outside)
    trigger.remove()
    outside.remove()
  })
})

describe('企业详情抽屉的差异原因', () => {
  it.each([
    ['not_queried', '未查询'],
    ['query_failed', '查询失败'],
    ['no_record', '无记录'],
    ['confirmed_no_diff', '已确认无差异'],
    ['confirmed_reason', '已确认原因'],
    ['needs_review', '待核实'],
  ])('%s 状态在抽屉里显示中文状态', (status, label) => {
    queryData.value = detailWithDifference({ status })
    queryLoading.value = false
    const wrapper = mountDrawer()
    const statusLabel = wrapper.get('[data-testid="enterprise-difference-status"]')

    expect(statusLabel.text()).toBe(label)
  })

  it('confirmed_no_diff 没有 reason_code 时显示「无需原因」', () => {
    queryData.value = detailWithDifference()
    queryLoading.value = false
    const wrapper = mountDrawer()

    expect(wrapper.get('[data-testid="difference-reason-chain"]').text()).toContain('无需原因')
    expect(wrapper.get('[data-testid="difference-reason-chain"]').text()).not.toContain('待核实')
  })

  it('其他无已知原因的差异仍显示「待核实」', () => {
    queryData.value = detailWithDifference({ status: 'needs_review', measureCode: null })
    queryLoading.value = false
    const wrapper = mountDrawer()

    expect(wrapper.get('[data-testid="difference-reason-chain"]').text()).toContain('待核实')
  })
})

describe('企业详情抽屉的复核年份', () => {
  it('只有下次复核年份对应的称号锚点待核时才标记该年份', () => {
    queryData.value = {
      ...detailWithDifference(),
      enterprise: {
        ...detailWithDifference().enterprise,
        nextReviewYear: 2023,
        anchorNeedsReview: true,
      },
      records: [
        { id: 1, titleCode: 'little_giant', source: 'jxj', district: null, lifecycle: { dueYear: 2023, needsReview: false, firstRecognitionYear: 2020, state: 'active' } },
        { id: 2, titleCode: 'specialized_sme', source: 'jxj', district: null, lifecycle: { dueYear: 2029, needsReview: true, firstRecognitionYear: 2021, state: 'active' } },
      ],
    }
    queryLoading.value = false
    const wrapper = mountDrawer()

    expect(wrapper.get('[data-testid="next-review-year"][data-review-year="2023"]').text()).toContain('2023')
    expect(wrapper.get('[data-testid="next-review-year"][data-review-year="2023"]').text()).not.toContain('待核')
  })

  it('下次复核年份本身的锚点待核时显示待核标记', () => {
    queryData.value = {
      ...detailWithDifference(),
      enterprise: {
        ...detailWithDifference().enterprise,
        nextReviewYear: 2023,
        anchorNeedsReview: false,
      },
      records: [
        { id: 1, titleCode: 'little_giant', source: 'jxj', district: null, lifecycle: { dueYear: 2023, needsReview: true, firstRecognitionYear: 2020, state: 'active' } },
      ],
    }
    queryLoading.value = false
    const wrapper = mountDrawer()

    expect(wrapper.get('[data-testid="next-review-year"][data-review-year="2023"]').text()).toContain('2023')
    expect(wrapper.get('[data-testid="next-review-year"][data-review-year="2023"]').text()).toContain('待核')
  })
})

describe('企业详情抽屉的曾用名', () => {
  it.each([
    {
      enterpriseId: 987,
      name: '宁波芯速联光电科技有限公司',
    },
    {
      enterpriseId: 1207,
      name: '宁波九纵智能科技有限公司',
    },
  ])('不把企业 $enterpriseId 的现名显示成曾用名', ({ name }) => {
    const detail = detailWithDifference()
    queryData.value = {
      ...detail,
      enterprise: { ...detail.enterprise, name, aliasNames: [name] },
    }
    queryLoading.value = false

    const wrapper = mountDrawer()
    const aliasValue = wrapper.get('dl').findAll('dd')[1]!

    expect(aliasValue.text()).toBe('—')
  })

  it('真实历史曾用名仍会显示', () => {
    const detail = detailWithDifference()
    queryData.value = {
      ...detail,
      enterprise: {
        ...detail.enterprise,
        name: '宁波上航测绘股份有限公司',
        aliasNames: ['宁波上航测绘股份有限公司', '宁波上航测绘有限公司'],
      },
    }
    queryLoading.value = false

    const wrapper = mountDrawer()
    const aliasValue = wrapper.get('dl').findAll('dd')[1]!
    expect(aliasValue.text()).toBe('宁波上航测绘有限公司')
  })
})


describe('企业详情抽屉的称号时间线', () => {
  function timelineDetail(types: string[]) {
    return {
      ...detailWithDifference(),
      records: [{id:1,titleCode:'little_giant',source:'jxj',district:null,lifecycle:{firstRecognitionYear:2020,dueYear:null,needsReview:false,state:'active'}}],
      events: types.map((eventType,index)=>({id:index+1,recordId:1,eventType,year:2020+index,decidedYear:null,batchSeq:1,reviewOutcome:null})),
    }
  }

  it('维护与复核按原始事件类型区分，时间线和出处显示一致',async()=>{
    const detail=timelineDetail(['award','maintain','review'])
    queryData.value={...detail,evidence:[{eventId:2,sourceFile:'名单.pdf',attachment:null,listNo:1,page:null}]}
    queryLoading.value=false
    const wrapper=mountDrawer()
    const events=wrapper.findAll('[data-testid="timeline-event"]')
    expect(events[0]!.text()).toContain('认定')
    expect(events[1]!.text()).toContain('维护')
    expect(events[1]!.text()).not.toContain('复核')
    expect(events[2]!.text()).toContain('复核')
    await wrapper.get('[data-testid="enterprise-evidence"] [data-slot="accordion-trigger"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="enterprise-evidence"] li p').text()).toBe('2021 · 专精特新“小巨人” · 维护')
    expect(wrapper.text()).not.toContain('维持')
    expect(detail.events.map(event=>event.eventType)).toEqual(['award','maintain','review'])
  })

  it('单个事件仍显示年份与事件，不需要装饰节点',()=>{
    queryData.value=timelineDetail(['award'])
    queryLoading.value=false
    const wrapper=mountDrawer()
    const events=wrapper.findAll('[data-testid="timeline-event"]')
    expect(events).toHaveLength(1)
    expect(events[0]!.text()).toContain('认定')
  })

  it('抽屉展示四个业务来源并卸载核对入口', () => {
    queryData.value = detailWithDifference()
    queryLoading.value = false
    const wrapper = mountDrawer()
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['公布资料', '认定目录', '关联办理', '申报记录'])
    expect(wrapper.find('[data-testid="drawer-review-summary"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('在企业详情中核对')
  })

})


describe('企业详情抽屉的复核称号与认定批次',()=>{
  const lifecycle={firstRecognitionYear:2021,dueYear:2027,state:'active',needsReview:false,anchorEventId:2}
  const award: RosterEventRow={id:1,recordId:1,eventType:'award',year:2021,decidedYear:2021,batchSeq:3,reviewOutcome:null}
  const review: RosterEventRow={id:2,recordId:1,eventType:'review',year:2021,decidedYear:2024,batchSeq:1,reviewOutcome:'passed'}
  function reviewDetail(events: RosterEventRow[]=[award,review]) {
    return {...detailWithDifference(),records:[{id:1,titleCode:'specialized_sme',source:'jxj',district:null,lifecycle}],events}
  }

  it('逐称号展示复核年与原认定年批次，同称号跨来源只显示一次',()=>{
    queryData.value={...detailWithDifference(),records:[
      {id:2,titleCode:'little_giant',source:'miit',district:null,lifecycle:{...lifecycle,anchorEventId:10,firstRecognitionYear:2024}},
      {id:1,titleCode:'little_giant',source:'jxj',district:null,lifecycle:{...lifecycle,anchorEventId:10,firstRecognitionYear:2024}},
      {id:3,titleCode:'specialized_sme',source:'jxj',district:null,lifecycle:{...lifecycle,anchorEventId:20,dueYear:2024,needsReview:true}},
    ],events:[{...award,id:10,year:2024,decidedYear:2024,batchSeq:6},{...award,id:20,recordId:3,batchSeq:2}]}
    queryLoading.value=false
    const view=mountDrawer()
    const items=view.findAll('[data-testid="next-review-item"]')
    expect(items.map(item=>item.attributes('data-title-code'))).toEqual(['specialized_sme','little_giant'])
    expect(items[0]!.text()).toContain('专精特新中小企业')
    expect(items[0]!.get('[data-testid="next-review-year"]').text()).toBe('2024年复核 · 待核')
    expect(items[0]!.get('[data-testid="next-review-cohort"]').text()).toBe('原认定：2021年 · 第2批')
    expect(items[1]!.text()).toContain('专精特新“小巨人”')
    expect(items[1]!.get('[data-testid="next-review-year"]').text()).toBe('2027年复核')
    expect(items[1]!.get('[data-testid="next-review-cohort"]').text()).toBe('原认定：2024年 · 第6批')
  })

  it('复核锚点关联原认定批次，不把复核批次当认定批次',()=>{
    queryData.value=reviewDetail()
    queryLoading.value=false
    const view=mountDrawer()
    expect(view.get('[data-testid="next-review-cohort"]').text()).toBe('原认定：2021年 · 第3批')
    expect(view.get('[data-testid="next-review-year"]').text()).toBe('2027年复核')
    expect(review.batchSeq).toBe(1)
  })

  it.each([
    ['缺失', [{...award,batchSeq:null},review]],
    ['冲突', [award,{...award,id:3,batchSeq:4},review]],
  ])('认定批次%s时明确待核，不猜测',(_label,events)=>{
    queryData.value=reviewDetail(events)
    queryLoading.value=false
    const view=mountDrawer()
    expect(view.get('[data-testid="next-review-cohort"]').text()).toBe('原认定：2021年 · 批次待核')
  })

  it('锚点事件缺失时不拿首次认定年份冒充当前复核批次',()=>{
    const detail=reviewDetail()
    queryData.value={...detail,records:[{...detail.records[0],lifecycle:{...lifecycle,anchorEventId:99}}]}
    queryLoading.value=false
    const view=mountDrawer()
    expect(view.get('[data-testid="next-review-cohort"]').text()).toBe('原认定：年份待核 · 批次待核')
    expect(view.get('[data-testid="next-review-year"]').text()).toBe('2027年复核')
  })

  it('已终止资格不显示下次复核安排',()=>{
    const detail=reviewDetail()
    queryData.value={...detail,records:[{...detail.records[0],lifecycle:{...lifecycle,state:'terminated',dueYear:null}}]}
    queryLoading.value=false
    const view=mountDrawer()
    expect(view.findAll('[data-testid="next-review-item"]')).toHaveLength(0)
    expect(view.get('[data-testid="next-review-value"]').text()).toBe('—')
  })
})

it('saves the filtered expanded ledger and both scroll layers when opening the complete enterprise page', async () => {
  queryData.value = detailWithDifference()
  queryLoading.value = false
  const table = mount(EnterpriseListTable, { attachTo: document.body, props: { rows: [], loading: false, hasError: false, selectedId: 1, filtered: true } })
  const scroller = table.get('[data-testid="enterprise-table-scroll"]').element
  scroller.scrollTop = 530; scroller.scrollLeft = 80
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 96 })
  sessionStorage.clear()
  const wrapper = mountDrawer()
  await wrapper.setProps({ backQuery: 'district=海曙区&page=2&pageSize=100&expand=1' })
  await wrapper.findAll('a').find(a => a.text().includes('完整企业页'))!.trigger('click', { button: 0 })
  expect(JSON.parse(sessionStorage.getItem('roster:evidence-preview-return') ?? 'null')).toEqual([
    { back: '/roster?district=海曙区&page=2&pageSize=100&expand=1', scrollY: 96, scrollTop: 530, scrollLeft: 80 },
  ])
  sessionStorage.clear()
  await wrapper.findAll('a').find(a => a.text().includes('完整企业页'))!.trigger('click', { button: 0, metaKey: true })
  expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()
  table.unmount()
})

it('企业详情读取失败可重试，不把失败当作平台零记录', async () => {
 queryLoading.value = false
 queryError.value = new Error('synthetic failed read')
 const wrapper = mountDrawer()
 expect(wrapper.text()).toContain('未能加载该企业详情')
 expect(wrapper.text()).not.toContain('平台未返回记录')
 await wrapper.get('[data-testid="table-retry"]').trigger('click')
 expect(refetch).toHaveBeenCalledTimes(1)
})
