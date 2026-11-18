// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { ref, watch } from 'vue'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from '@pinia/colada'
import { Toaster, toast } from 'vue-sonner'
import { defineComponent, h } from 'vue'
import * as registry from '../../../lib/app-file-category-ui'
import FilesPage from '../../../pages/files.vue'

// Happy DOM lacks WAAPI; exercise vue-sonner's JS fallback (same setup as
// tests/ui/settings/credential-controls.ui.test.ts).
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })

vi.mock('@pinia/colada', () => ({ useQuery: vi.fn(), useQueryCache: () => ({ invalidateQueries: vi.fn(async () => {}) }) }))
vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn() }))

const file = (id: number, name: string) => ({
  id, relPath: `jxj/announcement/2024/1/${name}.pdf`, displayName: name, filename: `${name}.pdf`,
  ext: 'pdf', bytes: 10, sha256: 'a'.repeat(64), source: 'jxj', kind: 'announcement',
  year: 2024, batch: 1, titleCode: null, categoryState: 'set', parseState: 'parsed',
  createdAt: '2026-10-17T00:00:00.000Z', removedAt: null, referenceCount: 0,
  registeredSummary: { count: 0, declarations: [] }, parts: [],
})

function toastText() {
  return [...document.querySelectorAll('[data-sonner-toast]')].map(el => el.textContent ?? '').join('\n')
}
async function see(expected: string) {
  await vi.waitFor(() => expect(toastText()).toContain(expected))
}
function toastRetryButton() {
  return [...document.querySelectorAll('[data-sonner-toast] button')]
    .find(el => el.textContent?.includes('重试')) as HTMLButtonElement | undefined
}
/** 按文字找按钮(VTU 没有 :has-text;与 credential-controls 测试的 tab() 同一套路)。 */
function button(view: ReturnType<typeof mount>, label: string) {
  const match = view.findAll('button').find(b => b.text() === label)
  if (!match) throw new Error(`missing button: ${label}`)
  return match
}

/**
 * 真实挂页面、桩掉子弹窗(Edit/Delete/UploadDialog 换成透传 emit 的替身),
 * 让 save/delete/registered 三条写路径直接走 `pages/files.vue` 里的真实实现。
 */
const stubs = {
  PageHeader: { template: '<header><slot/><slot name="actions"/></header>' },
  MultiSelectFilter: { name: 'MultiSelectFilter', props: ['modelValue', 'placeholder'], emits: ['update:modelValue'], template: '<button>{{ placeholder }}</button>' }, TablePagination: true, TableFailureState: true,
  TableLoadingStatus: true, FileSegmentsEditor: true, PdfViewDialog: true,
  FilePreviewDialog: true, NuxtLink: { template: '<a><slot/></a>' },
  EditFileDialog: {
    props: ['open'], emits: ['save', 'rename'],
    template: '<button data-testid="emit-save" @click="$emit(\'save\', { source: \'jxj\', kind: \'announcement\', year: 2024, batch: 1, titleCode: null })">save</button><button data-testid="emit-rename" @click="$emit(\'rename\', \'新名称.pdf\')">rename</button>',
  },
  DeleteFileDialog: {
    props: ['open'], emits: ['confirm'],
    template: '<button data-testid="emit-confirm" @click="$emit(\'confirm\', false)">confirm</button>',
  },
  UploadDialog: true,
}

describe('文件页写路径操作反馈', () => {
  let view: ReturnType<typeof mount>
  let fetch: ReturnType<typeof vi.fn>
  let toaster: ReturnType<typeof mount>

  beforeEach(async () => {
    toaster = mount(Toaster, { attachTo: document.body })
    vi.stubGlobal('useRoute', () => ({ path: '/files', fullPath: '/files', query: {} }))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn(async () => {}) }))
    vi.stubGlobal('useHead', vi.fn())
    vi.stubGlobal('definePageMeta', vi.fn())
    fetch = vi.fn(async (_url: string, options?: { method?: string }) => {
      if (!options?.method || options.method === 'GET') return { rows: [file(1, '公告一')], total: 1 }
      return {}
    })
    vi.stubGlobal('$fetch', fetch)
    // 与 tests/platform/retained-query/page-wiring.test.ts 同一 mock 套路。
    vi.mocked(useQuery).mockImplementation(((options: any) => {
      const data = ref(), isLoading = ref(false), error = ref<unknown>(null)
      const refetch = async () => {
        isLoading.value = true; error.value = null
        try { data.value = await options.query({ entry: { key: options.key() } }) }
        catch (cause) { error.value = cause }
        finally { isLoading.value = false }
      }
      watch(options.key, refetch, { immediate: true, deep: true })
      return { data, isLoading, error, refetch }
    }) as never)
    view = mount(FilesPage as never, { attachTo: document.body, global: { stubs } })
    await flushPromises()
  })
  afterEach(() => { view.unmount(); toast.dismiss(); toaster.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.clearAllMocks() })

  it('renders added filters and detail panels alongside the existing module', async () => {
    view.unmount()
    const modules = registry.getFileCategoryUi()
    const registration = vi.spyOn(registry, 'getFileCategoryUi').mockReturnValue([
      ...modules,
      {
        id: 'catalog',
        name: '馆藏',
        filters: [{
          key: 'collection', label: '馆藏', placeholder: '全部馆藏', width: 'w-28',
          options: [{ value: 'local', label: '本地馆藏' }],
        }],
        detailPanel: defineComponent({
          setup: () => () => h('p', '由模块登记的文件详情'),
        }),
        uploadDialog: defineComponent({
          props: ['open'],
          setup: props => () => props.open ? h('p', '馆藏上传窗口') : null,
        }),
      },
    ])
    try {
      view = mount(FilesPage as never, {
        attachTo: document.body,
        global: { stubs: { ...stubs, EditFileDialog: false } },
      })
      const filters = view.findAllComponents({ name: 'MultiSelectFilter' })
      expect(filters.map(filter => filter.props('placeholder'))).toContain('全部来源')
      const filter = filters.find(filter => filter.props('placeholder') === '全部馆藏')!
      filter.vm.$emit('update:modelValue', ['local'])
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/files', expect.objectContaining({
        query: expect.objectContaining({ collection: 'local' }),
      })))
      expect(view.text()).toContain('馆藏 · 本地馆藏')
      await button(view, '上传 · 馆藏').trigger('click')
      expect(view.text()).toContain('馆藏上传窗口')
      await button(view, '文件信息').trigger('click')
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('由模块登记的文件详情')
        expect(document.body.textContent).toContain('文件发布年份')
      })
    } finally {
      registration.mockRestore()
    }
  })

  it('保存文件信息成功给出成功 toast;失败给带「重试」的失败 toast,重试重发同一 PATCH', async () => {
    // 打开编辑弹窗 → 由替身 emit 一次 save
    await button(view, '文件信息').trigger('click')
    await view.get('[data-testid="emit-save"]').trigger('click')
    await flushPromises()
    expect(fetch.mock.calls.some(([, o]) => o?.method === 'PATCH')).toBe(true)
    await see('已保存文件信息')
    expect(toastText()).not.toContain('失败')

    // 再来一次,这次服务端拒绝 → 失败 toast 带重试
    fetch.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'PATCH') throw Object.assign(new Error('conflict'), { data: { message: '版本冲突' } })
      return { rows: [file(1, '公告一')], total: 1 }
    })
    await view.get('[data-testid="emit-save"]').trigger('click')
    await flushPromises()
    await see('保存文件信息失败')
    expect(toastText()).toContain('版本冲突')
    const retry = toastRetryButton()
    expect(retry, '失败 toast 必须带「重试」动作').toBeTruthy()

    // 点重试 → 重发同一 PATCH(这次放行)
    const before = fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length
    fetch.mockImplementation(async () => ({}))
    retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').length).toBe(before + 1)
    await see('已保存文件信息')
  })

  it('移出文件成功给出成功 toast;失败给带「重试」的失败 toast', async () => {
    await button(view, '移出').trigger('click')
    await view.get('[data-testid="emit-confirm"]').trigger('click')
    await flushPromises()
    expect(fetch.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(true)
    await see('已移出文件')

    fetch.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'DELETE') throw Object.assign(new Error('in use'), { data: { message: '文件被引用' } })
      return { rows: [file(1, '公告一')], total: 1 }
    })
    await button(view, '移出').trigger('click')
    await view.get('[data-testid="emit-confirm"]').trigger('click')
    await flushPromises()
    await see('移出文件失败')
    expect(toastText()).toContain('文件被引用')
    expect(toastRetryButton(), '失败 toast 必须带「重试」动作').toBeTruthy()
  })

})
