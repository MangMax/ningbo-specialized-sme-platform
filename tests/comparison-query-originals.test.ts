// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonQueryOriginals from '../components/ComparisonQueryOriginals.vue'
import TablePagination from '../components/TablePagination.vue'
let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })
it('reads every original relation page only after expansion and concatenates UTF-8 bytes before decoding originals', async () => {
  const encoded = new TextEncoder().encode('原始中😀文')
  const fetch = vi.fn(async (_url: string, options: { query: any }) => {
    const q = options.query
    if (q.field === 'relations') return { rows: q.page === 1 ? [{ id: 91, sequenceNo: 1 }] : [{ id: 992, sequenceNo: 201 }], total: 201, page: q.page, pageSize: 200 }
    if (q.field === 'collectionEvidence') return { isNull: true, data: '', hasMore: false, byteLength: 0, offset: 0, totalBytes: 0 }
    const bytes = q.offset === 0 ? encoded.slice(0, 4) : encoded.slice(4)
    return { isNull: false, data: btoa(String.fromCharCode(...bytes)), hasMore: q.offset === 0, offset: q.offset, byteLength: bytes.length, totalBytes: encoded.length }
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(ComparisonQueryOriginals, { props: { queryId: 8 } })
  expect(fetch).not.toHaveBeenCalled()
  await wrapper.get('[data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[0]![1].query).toEqual({ field: 'relations', page: 1, pageSize: 200 })
  expect(wrapper!.text()).toContain('201')
  wrapper.findComponent(TablePagination).vm.$emit('update:page', 2)
  await flushPromises()
  expect(wrapper.text()).toContain('来源行 201')
  await wrapper.findAll('button').find(button => button.text().includes('来源行 201'))!.trigger('click')
  await flushPromises()
  expect(wrapper.get('pre').text()).toBe('原始中😀文')
  expect(fetch.mock.calls.slice(-2).map(([, opts]) => opts.query)).toEqual([
    { field: 'relation', relationId: 992, offset: 0, length: 65536 },
    { field: 'relation', relationId: 992, offset: 4, length: 65536 },
  ])
  await wrapper.findAll('button').find(button => button.text() === '采集证据原文')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('原档未保存（null）')
  expect(wrapper.find('pre').exists()).toBe(false)
})

it('keeps the last source page on failure, retries it explicitly, and ignores originals from a prior query', async () => {
  let rejectNext!: (reason: Error) => void
  let resolveOld!: (value: unknown) => void
  let attempts = 0
  const fetch = vi.fn((_url: string, options: { query: any }) => {
    if (options.query.field === 'relations') {
      if (options.query.page === 2 && ++attempts === 1) return new Promise((_, reject) => { rejectNext = reject })
      return Promise.resolve({ rows: [{ id: options.query.page, sequenceNo: options.query.page === 2 ? 201 : 1 }], total: 201, page: options.query.page, pageSize: 200 })
    }
    if (_url.includes('/8/')) return new Promise(resolve => { resolveOld = resolve })
    return Promise.resolve({ isNull: false, data: '', hasMore: false, byteLength: 0, offset: 0, totalBytes: 0 })
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(ComparisonQueryOriginals, { props: { queryId: 8 } })
  await wrapper.get('[data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  wrapper.findComponent(TablePagination).vm.$emit('update:page', 2)
  await flushPromises()
  rejectNext(Error('synthetic unavailable'))
  await flushPromises()
  expect(wrapper.text()).toContain('来源行目录读取失败')
  expect(wrapper.text()).toContain('保留第 1 页；目标第 2 页尚未读取')
  expect(wrapper.text()).toContain('来源行 1 · #1')
  await wrapper.get('[data-testid="table-retry"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('来源行 201')
  await wrapper.findAll('button').find(button => button.text() === '查询响应原文')!.trigger('click')
  await wrapper.setProps({ queryId: 9 })
  await flushPromises()
  expect(wrapper.text()).not.toContain('正在读取完整原文')
  await wrapper.findAll('button').find(button => button.text() === '查询响应原文')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('原档为空字符串')
  resolveOld({ isNull: true, data: '', hasMore: false, byteLength: 0, offset: 0, totalBytes: 0 })
  await flushPromises()
  expect(wrapper.text()).toContain('原档为空字符串')
  expect(wrapper.text()).not.toContain('原档未保存（null）')
})


it('retains the successful original on same-source refresh failure, retries the failed target and clears a changed source', async () => {
  let fail = false
  const fetch = vi.fn(async (_url: string, options: { query: any }) => {
    if (options.query.field === 'relations') return { rows: [], total: 0, page: 1, pageSize: 200 }
    if (fail) throw Error('synthetic offline')
    const bytes = new TextEncoder().encode('已读取原文')
    return { isNull: false, data: btoa(String.fromCharCode(...bytes)), hasMore: false, offset: 0, byteLength: bytes.length, totalBytes: bytes.length }
  })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(ComparisonQueryOriginals, { props: { queryId: 8 } })
  await wrapper.get('[data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  const read = () => wrapper!.findAll('button').find(button => button.text() === '查询响应原文')!.trigger('click')
  await read()
  await flushPromises()
  expect(wrapper.get('pre').text()).toBe('已读取原文')
  fail = true
  await read()
  await flushPromises()
  expect(wrapper.get('pre').text()).toBe('已读取原文')
  expect(wrapper.text()).toContain('保留上次成功原文：查询 #8 · 查询响应原文')
  expect(wrapper.get('[role="alert"]').text()).toContain('读取目标：查询 #8 · 查询响应原文')
  fail = false
  await wrapper.findAll('button').find(button => button.text() === '重试读取原文')!.trigger('click')
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  fail = true
  await wrapper.findAll('button').find(button => button.text() === '采集证据原文')!.trigger('click')
  await flushPromises()
  expect(wrapper.find('pre').exists()).toBe(false)
  expect(wrapper.get('[role="alert"]').text()).toContain('读取目标：查询 #8 · 采集证据原文')
  await wrapper.setProps({ queryId: 9 })
  await flushPromises()
  expect(wrapper.text()).not.toContain('已读取原文')
  expect(wrapper.text()).not.toContain('读取目标：查询 #8')
})
