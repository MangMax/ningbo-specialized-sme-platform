// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from '@pinia/colada'
import EnterpriseDrawer from '../components/EnterpriseDrawer.vue'

vi.mock('@pinia/colada', () => ({ useQuery: vi.fn() }))

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
        DialogRoot: { template: '<div><slot /></div>' },
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

  it('抽屉关闭状态落定时恢复触发器焦点', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    const wrapper = mountDrawer(trigger)

    await wrapper.setProps({ enterpriseId: null })

    expect(document.activeElement).toBe(trigger)
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
  it('锚点年份退回时明确标为待核', () => {
    queryData.value = {
      ...detailWithDifference(),
      enterprise: {
        ...detailWithDifference().enterprise,
        nextReviewYear: 2023,
        anchorNeedsReview: true,
      },
    }
    queryLoading.value = false
    const wrapper = mountDrawer()

    expect(wrapper.get('[data-testid="next-review-value"]').text()).toContain('2023')
    expect(wrapper.get('[data-testid="next-review-value"]').text()).toContain('待核')
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
