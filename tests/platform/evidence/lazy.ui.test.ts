// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import PlatformEvidenceChunk from '../../../components/PlatformEvidenceChunk.vue'
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.unstubAllGlobals() })
function part(offset: number, bytes: number[], more: boolean) {
  return { queryId: 7, field: 'rawResponse', encoding: 'base64', offset, byteLength: bytes.length, totalBytes: 5, isNull: false, hasMore: more, data: Buffer.from(bytes).toString('base64') }
}
it('loads only on demand, retries the failed byte offset and decodes split Unicode without losing successful text', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(part(0, [65, 240, 159], true)).mockRejectedValueOnce(new Error('synthetic chunk failure')).mockResolvedValueOnce(part(3, [153, 130], false))
  vi.stubGlobal('$fetch', fetch)
  const w = mount(PlatformEvidenceChunk, { props: { queryId: 7, field: 'rawResponse', title: '响应原文' } }); wrappers.push(w)
  expect(fetch).not.toHaveBeenCalled()
  expect(w.text()).toContain('尚未加载')
  await w.get('button').trigger('click'); await flushPromises()
  expect(w.text()).toContain('3 / 5 字节')
  expect(w.get('pre').text()).toBe('A')
  await w.get('[data-action="chunk-next"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('synthetic chunk failure')
  expect(w.get('pre').text()).toBe('A')
  await w.get('[data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(fetch.mock.calls[2]![1].query.offset).toBe(3)
  expect(w.get('pre').text()).toBe('A🙂')
  expect(w.text()).toContain('完整')
})

import PlatformQueryEvidence from '../../../components/PlatformQueryEvidence.vue'
it.each([
  { name: 'one chunk', chunks: [[239, 187, 191, 232, 175, 129, 230, 141, 174]] },
  { name: 'BOM split after byte one', chunks: [[239], [187, 191, 232, 175, 129, 230, 141, 174]] },
  { name: 'BOM split after byte two', chunks: [[239, 187], [191, 232, 175, 129, 230, 141, 174]] },
  { name: 'BOM split across three chunks', chunks: [[239], [187], [191, 232, 175, 129, 230, 141, 174]] },
])('preserves the leading BOM in original evidence ($name)', async ({ chunks }) => {
  const fetch = vi.fn()
  let offset = 0
  for (const bytes of chunks) {
    fetch.mockResolvedValueOnce({ ...part(offset, bytes, offset + bytes.length < 9), totalBytes: 9 })
    offset += bytes.length
  }
  vi.stubGlobal('$fetch', fetch)
  const w = mount(PlatformEvidenceChunk, { props: { queryId: 7, field: 'rawResponse', title: '响应原文' } }); wrappers.push(w)
  for (let index = 0; index < chunks.length; index++) {
    await w.get('[data-action="chunk-next"]').trigger('click'); await flushPromises()
    if (index < chunks.length - 1) {
      expect(w.get('pre').element.textContent).toBe('')
      expect(w.text()).toContain('部分，尚未读完')
    }
  }
  // .text() trims U+FEFF, so inspect the original DOM text without normalization.
  const original = w.get('pre').element.textContent
  expect(original).toBe('\uFEFF证据')
  expect(Array.from(Buffer.from(original!, 'utf8'))).toEqual([239, 187, 191, 232, 175, 129, 230, 141, 174])
  expect(w.text()).toContain('9 / 9 字节 · 完整')
  expect(w.find('[data-action="chunk-next"]').exists()).toBe(false)
})
it('opens relationship pages lazily, retains page one on page-two failure, and reuses successful reads after collapse', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ queryId: 7, field: 'relations', rows: [{ id: 71, sequenceNo: 1 }], total: 2, page: 1, pageSize: 1 })
    .mockRejectedValueOnce(new Error('page two unavailable'))
    .mockResolvedValueOnce({ queryId: 7, field: 'relations', rows: [{ id: 72, sequenceNo: 2 }], total: 2, page: 2, pageSize: 1 })
  vi.stubGlobal('$fetch', fetch)
  const w = mount(PlatformQueryEvidence, { props: { queryId: 7 } }); wrappers.push(w)
  expect(fetch).not.toHaveBeenCalled()
  await w.get('button').trigger('click'); await flushPromises()
  expect(w.text()).toContain('关系 #71')
  expect(w.text()).toContain('1 / 2')
  await w.get('[data-action="relations-next"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('page two unavailable')
  expect(w.text()).toContain('关系 #71')
  await w.get('[data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(fetch.mock.calls[2]![1].query.page).toBe(2)
  expect(w.text()).toContain('关系 #72')
  expect(w.text()).toContain('关系目录完整')
  await w.get('button').trigger('click'); await w.get('button').trigger('click'); await flushPromises()
  expect(fetch).toHaveBeenCalledTimes(3)
})

it.each([true, false])('distinguishes missing raw evidence from an empty string (isNull=%s)', async isNull => {
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ ...part(0, [], false), totalBytes: 0, isNull }))
  const w = mount(PlatformEvidenceChunk, { props: { queryId: 7, field: 'rawResponse', title: '响应原文' } }); wrappers.push(w)
  await w.get('button').trigger('click'); await flushPromises()
  expect(w.text()).toContain(isNull ? '未记录（null）' : '空字符串')
  expect(w.text()).toContain('完整')
})
it('refuses chunks with changed total bytes without appending a different archive', async () => {
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValueOnce(part(0, [65], true)).mockResolvedValueOnce({ ...part(1, [66], true), totalBytes: 6 }))
  const w = mount(PlatformEvidenceChunk, { props: { queryId: 7, field: 'rawResponse', title: '响应原文' } }); wrappers.push(w)
  await w.get('button').trigger('click'); await flushPromises()
  await w.get('[data-action="chunk-next"]').trigger('click'); await flushPromises()
  expect(w.get('pre').text()).toBe('A')
  expect(w.text()).toContain('原档范围已变化')
})
it('does not attach a delayed original to a replacement source', async () => {
  let resolve: (value: unknown) => void = () => {}
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r }))
  vi.stubGlobal('$fetch', fetch)
  const old = mount(PlatformEvidenceChunk, { props: { queryId: 7, field: 'rawResponse', title: '旧来源' } })
  await old.get('button').trigger('click'); old.unmount()
  const current = mount(PlatformEvidenceChunk, { props: { queryId: 8, field: 'rawResponse', title: '新来源' } }); wrappers.push(current)
  resolve(part(0, [65], true)); await flushPromises()
  expect(current.text()).toContain('尚未加载')
  expect(current.find('pre').exists()).toBe(false)
})
it('an explicitly empty relation directory is complete without claiming a query was no_record', async () => {
  const fetch = vi.fn().mockResolvedValue({ queryId: 7, field: 'relations', rows: [], total: 0, page: 1, pageSize: 25 })
  vi.stubGlobal('$fetch', fetch)
  const w = mount(PlatformQueryEvidence, { props: { queryId: 7 } }); wrappers.push(w)
  await w.get('button').trigger('click'); await flushPromises()
  expect(w.text()).toContain('0 / 0')
  expect(w.text()).toContain('关系目录完整')
  expect(w.text()).not.toContain('无记录')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('keeps the action label short even when a relation identity has a long title', () => {
  const w = mount(PlatformEvidenceChunk, { props: { queryId: 7, field: 'relation', relationId: 71, title: '第 100 条 · 关系 #710000 原档（含企业名称与原字段）' } }); wrappers.push(w)
  expect(w.get('button').text()).toBe('读取首段')
})
it('can explicitly restart a changed query archive, clearing prior directory and original chunks', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ queryId: 7, field: 'relations', rows: [{ id: 71, sequenceNo: 1 }], total: 2, page: 1, pageSize: 1 })
    .mockResolvedValueOnce({ queryId: 7, field: 'relations', rows: [{ id: 72, sequenceNo: 2 }], total: 3, page: 2, pageSize: 1 })
    .mockResolvedValueOnce({ queryId: 7, field: 'relations', rows: [{ id: 73, sequenceNo: 1 }], total: 1, page: 1, pageSize: 25 })
  vi.stubGlobal('$fetch', fetch)
  const w = mount(PlatformQueryEvidence, { props: { queryId: 7 } }); wrappers.push(w)
  await w.get('button').trigger('click'); await flushPromises()
  await w.get('[data-action="relations-next"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('范围已变化')
  await w.get('[data-action="query-restart"]').trigger('click'); await flushPromises()
  expect(w.text()).not.toContain('关系 #71')
  expect(w.text()).toContain('关系 #73')
  expect(fetch.mock.calls[2]![1].query.page).toBe(1)
})
