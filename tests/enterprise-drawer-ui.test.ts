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

function mountDrawer() {
  const wrapper = mount(EnterpriseDrawer, {
    props: { enterpriseId: 1, backQuery: '' },
    global: {
      stubs: {
        DialogRoot: { template: '<div><slot /></div>' },
        DialogContent: { template: '<section><slot /></section>' },
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
