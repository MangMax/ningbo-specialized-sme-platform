// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, disposePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import FilesPage from '../pages/files.vue'
import TablePagination from '../components/TablePagination.vue'
import TableFailureState from '../components/TableFailureState.vue'
import TableLoadingStatus from '../components/TableLoadingStatus.vue'
import PageHeader from '../components/PageHeader.vue'
import MultiSelectFilter from '../components/MultiSelectFilter.vue'
import FilterChip from '../components/FilterChip.vue'
import type { StoredFileRow } from '../server/utils/stored-files'

// Dialog workflows are outside this read-only listing seam. Keep their imports
// inert; the real page, query, search input, rows and pager execute unchanged.
vi.mock('../components/files/UploadDialog.vue', () => ({ default: { render: () => null } }))
vi.mock('../components/files/EditFileDialog.vue', () => ({ default: { render: () => null } }))
vi.mock('../components/files/RenameFileDialog.vue', () => ({ default: { render: () => null } }))
vi.mock('../components/files/DeleteFileDialog.vue', () => ({ default: { render: () => null } }))
vi.mock('../components/files/PdfViewDialog.vue', () => ({ default: { render: () => null } }))

type Response = { rows: StoredFileRow[]; total: number }
const first: Response = {
  rows: [{ id: 101, displayName: 'notice.pdf', filename: 'notice.pdf', relPath: 'notice.pdf', ext: '.pdf', bytes: 1024, sha256: 'a'.repeat(64), source: null, kind: null, year: null, batch: null, titleCode: null, categoryState: 'unset', parseState: 'unparsed', createdAt: '2026-01-01', removedAt: null, referenceCount: 0, parts: [] }],
  total: 123,
}
const second: Response = {
  rows: [{ id: 202, displayName: 'second.pdf', filename: 'second.pdf', relPath: 'second.pdf', ext: '.pdf', bytes: 2048, sha256: 'b'.repeat(64), source: null, kind: null, year: null, batch: null, titleCode: null, categoryState: 'unset', parseState: 'unparsed', createdAt: '2026-01-02', removedAt: null, referenceCount: 0, parts: [] }],
  total: 124,
}
const filtered: Response = {
  rows: [{ id: 303, displayName: 'filtered-notice.pdf', filename: 'filtered-notice.pdf', relPath: 'filtered-notice.pdf', ext: '.pdf', bytes: 3072, sha256: 'c'.repeat(64), source: null, kind: null, year: null, batch: null, titleCode: null, categoryState: 'unset', parseState: 'unparsed', createdAt: '2026-01-03', removedAt: null, referenceCount: 0, parts: [] }],
  total: 125,
}
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).reverse().forEach(fn => fn())
  vi.unstubAllGlobals()
})

async function openFiles() {
  const pending: { query: Record<string, unknown>; resolve: (value: Response) => void; reject: (error: Error) => void }[] = []
  // Only the transport is controlled. Colada owns keys, pending/error state and
  // callback execution; the page captures request metadata and retains results.
  vi.stubGlobal('$fetch', (url: string, options?: { query: Record<string, unknown> }) => {
    if (url !== '/api/files') throw new Error(`Unexpected request: ${url}`)
    return new Promise<Response>((resolve, reject) => pending.push({ query: structuredClone(options!.query), resolve, reject }))
  })
  const pinia = createPinia()
  cleanup.push(() => disposePinia(pinia))
  const wrapper = mount(FilesPage, {
    global: {
      plugins: [pinia, PiniaColada],
      components: { TablePagination, TableFailureState, TableLoadingStatus, PageHeader, MultiSelectFilter, FilterChip },
      stubs: { FilePreviewDialog: true, SourceChip: true, TitleBadge: true, EventChip: true },
    },
  })
  cleanup.push(() => wrapper.unmount())
  await flushPromises()
  expect(pending[0]!.query).toMatchObject({ page: 1, pageSize: 50 })
  pending[0]!.resolve(first)
  await flushPromises()
  expect(wrapper.get('[data-testid="table-total"]').text()).toBe('共 123 个文件')
  expectSnapshot(wrapper, 'notice.pdf', '共 123 个文件', '1')
  return { wrapper, pending }
}

function expectSnapshot(wrapper: VueWrapper, name: string, total: string, page: string) {
  expect(wrapper.findAll('[data-slot="table-body"] [data-slot="table-row"] > td:nth-child(2) span').map(row => row.text())).toEqual([name])
  expect(wrapper.get('[data-testid="table-total"]').text()).toBe(total)
  expect(wrapper.get('[data-slot="pagination-item"][aria-current="page"]').text()).toBe(page)
}

describe('files page retained query results', () => {
  it('retains page one rows total and page after page two fails and commits retry together', async () => {
    const { wrapper, pending } = await openFiles()
    await wrapper.get('[aria-label="下一页"]').trigger('click')
    await flushPromises()
    expect(pending[1]!.query).toMatchObject({ page: 2, pageSize: 50 })
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeDefined()
    expectSnapshot(wrapper, 'notice.pdf', '共 123 个文件', '1')
    pending[1]!.reject(new Error('controlled page two failure'))
    await flushPromises()
    expectSnapshot(wrapper, 'notice.pdf', '共 123 个文件', '1')
    expect(wrapper.get('[data-testid="table-failure-state"]').text()).toContain('显示上次成功的第 1 页；当前筛选请求的第 2 页未加载成功。')
    await wrapper.get('[data-testid="table-retry"]').trigger('click')
    await flushPromises()
    expect(pending[2]!.query).toMatchObject({ page: 2, pageSize: 50 })
    expectSnapshot(wrapper, 'notice.pdf', '共 123 个文件', '1')
    pending[2]!.resolve(second)
    await flushPromises()
    expectSnapshot(wrapper, 'second.pdf', '共 124 个文件', '2')
    expect(wrapper.find('[data-testid="table-failure-state"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeUndefined()
  })
  it('keeps filtered results when a superseded page two response arrives late', async () => {
    const { wrapper, pending } = await openFiles()
    await wrapper.get('[aria-label="下一页"]').trigger('click')
    await flushPromises()
    expect(pending[1]!.query).toMatchObject({ page: 2, pageSize: 50 })
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeDefined()
    expectSnapshot(wrapper, 'notice.pdf', '共 123 个文件', '1')
    const search = wrapper.get('input[placeholder="搜索文件名"]')
    expect(search.attributes('disabled')).toBeUndefined()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await search.setValue('filtered-notice')
      await vi.advanceTimersByTimeAsync(299)
      expect(pending).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      vi.useRealTimers()
    }
    await flushPromises()
    expect(pending).toHaveLength(3)
    expect(pending[2]!.query).toMatchObject({ q: 'filtered-notice', page: 1, pageSize: 50 })
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeDefined()
    pending[2]!.resolve(filtered)
    await flushPromises()
    expectSnapshot(wrapper, 'filtered-notice.pdf', '共 125 个文件', '1')
    pending[1]!.resolve(second)
    await flushPromises()
    expectSnapshot(wrapper, 'filtered-notice.pdf', '共 125 个文件', '1')
    expect(wrapper.find('[data-testid="table-failure-state"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeUndefined()
  })
})
