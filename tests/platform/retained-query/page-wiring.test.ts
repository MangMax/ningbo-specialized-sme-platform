// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { ref, watch } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from '@pinia/colada'
import RosterPage from '../../../layers/sme-roster/app/pages/roster.vue'
import FilesPage from '../../../layers/core/app/pages/files.vue'

vi.mock('@pinia/colada', () => ({ useQuery: vi.fn(), useQueryCache: () => ({ invalidateQueries: vi.fn() }) }))
vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn() }))
const pagination = { props: ['page', 'pageSize', 'total', 'loading'], template: '<div />' }
const failure = { props: ['description'], emits: ['retry'], template: '<button data-testid="retry" @click="$emit(\'retry\')">重试</button>' }
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe.each([
  { name: '企业列表', path: '/roster', component: RosterPage, namespace: 'ledger-enterprises', size: 25 },
  { name: '文件列表', path: '/files', component: FilesPage, namespace: 'files', size: 50 },
])('$name retained page behavior', ({ path, component, namespace, size }) => {
  it('retains successful rows and pagination after failure, then switches both on explicit retry', async () => {
    vi.stubGlobal('useRoute', () => ({ path, fullPath: path, query: {} }))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn(async () => {}) }))
    vi.stubGlobal('useHead', vi.fn())
    vi.stubGlobal('definePageMeta', vi.fn())
    const enterprise = (id: number, name: string) => ({ enterpriseId: id, name, uscc: null, district: '海曙区', aliasNames: [], titles: [], firstRecognition: [], difference: { count: 0, status: null, reasonCode: null, anyCurrent: false } })
    const file = (id: number, name: string) => ({ id, relativePath: name + '.pdf', displayName: name, originalName: name, bytes: 10, parts: [], categoryState: 'unset', parseState: 'pending' })
    let rejectPage = true
    const fetch = vi.fn(async (url: string, options: any) => {
      if (options.query.page === 2 && rejectPage) throw new Error('second page unavailable')
      const second = options.query.page === 2
      const name = second ? '成功第二页' : '保留第一页'
      return { rows: [namespace === 'files' ? file(second ? 2 : 1, name) : enterprise(second ? 2 : 1, name)], total: second ? 160 : 120, counts: { total: second ? 160 : 120, titlePairs: 0, titles: {}, recognitionPairs: 0, differences: 0 } }
    })
    vi.stubGlobal('$fetch', fetch)
    vi.mocked(useQuery).mockImplementation((options: any) => {
      if (options.key()[0] !== namespace) return { data: ref({ years: [], firstYears: [] }), isLoading: ref(false), error: ref(null) } as any
      const data = ref(), isLoading = ref(false), error = ref<unknown>(null)
      const refetch = async () => {
        isLoading.value = true; error.value = null
        try { data.value = await options.query({ entry: { key: options.key() } }) }
        catch (cause) { error.value = cause }
        finally { isLoading.value = false }
      }
      watch(options.key, refetch, { immediate: true, deep: true })
      return { data, isLoading, error, refetch } as any
    })
    const view = mount(component as any, { global: { stubs: {
      TablePagination: pagination, TableFailureState: failure, TableLoadingStatus: true,
      PageHeader: { template: '<header><slot/><slot name="actions"/></header>' },
      RosterEnterpriseDrawer: true, RosterEnterpriseDifferenceRefresh: true, MultiSelectFilter: true,
      EditFileDialog: true, DeleteFileDialog: true, UploadDialog: true, PdfViewDialog: true,
      FileSegmentsEditor: true, NuxtLink: { template: '<a><slot/></a>' },
    } } })
    try {
      await flushPromises()
      const pager = () => view.findComponent(pagination)
      expect(view.text()).toContain('保留第一页')
      expect(pager().props()).toMatchObject({ page: 1, pageSize: size, total: 120 })
      pager().vm.$emit('update:page', 2)
      await flushPromises()
      expect(view.text()).toContain('保留第一页')
      expect(view.text()).not.toContain('成功第二页')
      expect(pager().props()).toMatchObject({ page: 1, pageSize: size, total: 120 })
      expect(view.findComponent(failure).props('description')).toBeTruthy()
      rejectPage = false
      await view.get('[data-testid="retry"]').trigger('click')
      await flushPromises()
      expect(view.text()).toContain('成功第二页')
      expect(view.text()).not.toContain('保留第一页')
      expect(pager().props()).toMatchObject({ page: 2, pageSize: size, total: 160 })
      expect(fetch.mock.calls.at(-1)![1].query.page).toBe(2)
    } finally { view.unmount() }
  })
})
