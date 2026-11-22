// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { ref, watch } from 'vue'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from '@pinia/colada'
import { Toaster, toast } from 'vue-sonner'
import FilesPage from '../../../layers/core/app/pages/files.vue'
import RosterFilesPage from '../../../layers/sme-roster/app/pages/sme-roster/files.vue'

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
    props: ['open', 'file', 'title', 'panels', 'pending', 'failure', 'namePending', 'nameFailure'], emits: ['save', 'rename', 'update:open'],
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
    vi.stubGlobal('matchMedia', (media: string) => ({
      media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }))
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

  it('sets the file table minimum width to the sum of its rendered columns', () => {
    view.unmount()
    view = mount(RosterFilesPage, { attachTo: document.body, global: { stubs } })
    const table = view.get('table')
    const widths = table.findAll('thead th').map(header => {
      const inline = (header.element as HTMLElement).style.width.match(/^(\d+)px$/)
      if (inline) return Number(inline[1])
      for (const name of header.classes()) {
        const pixels = name.match(/^w-\[(\d+)px\]$/)
        if (pixels) return Number(pixels[1])
        const spacing = name.match(/^w-(\d+(?:\.\d+)?)$/)
        if (spacing) return Number(spacing[1]) * 4
      }
      throw new Error(`missing width for file table header: ${header.element.textContent}`)
    })
    expect(widths.length).toBeGreaterThan(3)
    expect((view.get('[data-slot=table-container]').element as HTMLElement).style.minWidth).toBe(`${widths.reduce((sum, width) => sum + width, 0)}px`)
  })

  it('keeps platform file operations separate from roster fields and filters', async () => {
    const headers = () => view.findAll('thead th').map(header => header.text())
    expect(headers()).toEqual(['文件名', '大小', '操作'])
    expect(view.findAllComponents({ name: 'MultiSelectFilter' })).toHaveLength(0)
    expect(fetch).toHaveBeenCalledWith('/api/file-library', expect.anything())
    expect(button(view, '上传文件')).toBeDefined()

    view.unmount()
    view = mount(RosterFilesPage, { attachTo: document.body, global: { stubs } })
    const rosterFilters = view.findAllComponents({ name: 'MultiSelectFilter' })
    expect(rosterFilters.map(filter => filter.props('placeholder'))).toEqual(['全部来源', '全部分类状态', '全部解析状态'])
    rosterFilters[0]!.vm.$emit('update:modelValue', ['jxj'])
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/sme-roster/files', expect.objectContaining({
      query: expect.objectContaining({ source: 'jxj' }),
    })))
    expect(headers()).toEqual(expect.arrayContaining(['文件发布', '内容年份', '内容批次', '分类状态', '解析状态', '被引用']))
    expect(view.text()).toContain('来源 · 经信局')
    expect(button(view, '上传名单文件')).toBeDefined()
    expect(view.findAll('button').some(button => button.text() === '移出')).toBe(false)
  })

  it('保存文件信息成功给出成功 toast;失败给带「重试」的失败 toast,重试重发同一 PATCH', async () => {
    view.unmount()
    view = mount(RosterFilesPage, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    // 打开编辑弹窗 → 由替身 emit 一次 save
    await button(view, '名单信息').trigger('click')
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
