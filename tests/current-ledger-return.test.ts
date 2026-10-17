// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { useQuery } from '@pinia/colada'
import IndexPage from '../pages/index.vue'
import { captureQueryRequest } from '../composables/useRetainedQuerySnapshot'
vi.mock('@pinia/colada', () => ({ useQuery: vi.fn() }))

it('restores current ledger expansion and both scroll layers only after its rows are ready', async () => {
  const path = '/?q=RL10&page=2&pageSize=100&expand=91'
  history.replaceState(null, '', path)
  sessionStorage.setItem('roster:evidence-preview-return', JSON.stringify([{ back: path, scrollY: 96, scrollTop: 530, scrollLeft: 0 }]))
  const frames: FrameRequestCallback[] = []
  const scrollTo = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('scrollTo', scrollTo)
  vi.stubGlobal('useRoute', () => ({ path: '/', fullPath: path, query: { q: 'RL10', page: '2', pageSize: '100', expand: '91' } }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn(async () => {}) }))
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('$fetch', vi.fn())
  const loading = ref(true)
  const data = ref<unknown>(null)
  let params = { page: 2, pageSize: 100 }
  vi.mocked(useQuery).mockImplementation((options: any) => {
    const key = options.key()
    if (key[0] === 'ledger-enterprises') { params = key[1]; return { data, isLoading: loading, error: ref(null), refetch: vi.fn() } as any }
    return { data: ref({ years: [], firstYears: [] }), isLoading: ref(false), error: ref(null) } as any
  })
  const wrapper = mount(IndexPage, { attachTo: document.body, global: { stubs: {
    EnterpriseDrawer: { props: ['enterpriseId'], template: '<div aria-label="当前展开企业">{{ enterpriseId }}</div>' },
    PageHeader: { template: '<header><slot/><slot name="actions"/></header>' },
    MultiSelectFilter: true, TablePagination: true, TableLoadingStatus: true, TableFailureState: true,
  } } })
  await flushPromises()
  expect(frames).toHaveLength(0)
  expect(scrollTo).not.toHaveBeenCalled()
  data.value = {
    rows: [{ enterpriseId: 91, name: '宁波 RL10', uscc: null, district: '海曙区', aliasNames: [], titles: [], firstRecognition: [], difference: { count: 0, status: null, reasonCode: null, anyCurrent: false } }],
    counts: { total: 220, titlePairs: 220, titles: {}, recognitionPairs: 0, differences: 0 },
    request: captureQueryRequest('ledger-enterprises', params),
  }
  loading.value = false
  await flushPromises()
  expect(frames).toHaveLength(1)
  frames[0]!(0)
  expect(wrapper.get('[data-testid="enterprise-table-scroll"]').element.scrollTop).toBe(530)
  expect(scrollTo).toHaveBeenCalledWith({ top: 96, behavior: 'instant' })
  expect(wrapper.get('[aria-label="当前展开企业"]').text()).toBe('91')
  expect(sessionStorage.getItem('roster:evidence-preview-return')).toBeNull()
  wrapper.unmount()
  vi.unstubAllGlobals()
})
