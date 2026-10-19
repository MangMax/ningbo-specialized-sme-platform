// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonSourcePicker from '../components/record-correspondence/ComparisonSourcePicker.vue'
import { Tabs } from '../components/ui/tabs'

const rows = {
  official_document: [{ kind: 'official_document', id: 3, label: '2024 年专精特新公布名单', subtitle: '甬经信〔2024〕1号', titleCode: null, titleName: null, observedAt: '2024-10-01', status: 'available', selectable: true, path: 'jxj/a.pdf' }],
  query: [{ kind: 'query', id: 7, label: '申报流程 · 专精特新中小企业 · 合成企业', subtitle: 'apply_list', titleCode: 'specialized_sme', titleName: '专精特新中小企业', observedAt: '2025-01-02T00:00:00Z', status: 'partial', selectable: true, rdjb: '2', completeness: 'partial', fullRange: false, conditions: { combination: 'and', uscc: '913300000000000004' } }],
  export_batch: [{ kind: 'export_batch', id: 8, label: '专精特新中小企业 · 2025 · export.xlsx', subtitle: 'export.xlsx', titleCode: 'specialized_sme', titleName: '专精特新中小企业', observedAt: '2025-02-01', status: 'failed', selectable: false, sha256: 'a'.repeat(64), rowCount: 0, replacedBatchId: null }],
}
const wrapperList: ReturnType<typeof mount>[] = []
afterEach(() => { for (const wrapper of wrapperList.splice(0)) wrapper.unmount(); vi.unstubAllGlobals() })

it('offers an explicit route to every query and preserves selection when the catalog is collapsed', async () => {
  const queries = Array.from({ length: 14 }, (_, index) => ({ ...rows.query[0], id: index + 1, label: `平台查询 ${index + 1}` }))
  vi.stubGlobal('$fetch', vi.fn(async () => ({ rows: queries, total: 14, page: 1, pageSize: 25 })))
  const wrapper = mount(ComparisonSourcePicker, { props: { kind: 'query', selection: { queryIds: [], exportBatchIds: [], officialSourceDocumentIds: [], proofIds: [] } }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  wrapperList.push(wrapper)
  await flushPromises()
  expect(wrapper.find('[aria-label="选择平台查询 14"]').exists()).toBe(false)
  await wrapper.findAll('button').find(button => button.text().includes('查看全部 14'))!.trigger('click')
  await wrapper.get('[aria-label="选择平台查询 14"]').trigger('click')
  expect(wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ queryIds: [14] })
  await wrapper.setProps({ selection: { queryIds: [14], exportBatchIds: [], officialSourceDocumentIds: [], proofIds: [] } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text().includes('收起，只看前'))!.trigger('click')
  await wrapper.get('[aria-label="已选来源"] [data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[aria-label="已选来源"]').text()).toContain('平台查询 14')
  expect(wrapper.emitted('change')).toHaveLength(1)
})

it('shows human source names and times, permits partial queries, and blocks failed export batches', async () => {
  vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: { kind: keyof typeof rows; page: number; pageSize: number } }) => ({ rows: rows[options.query.kind], total: 1, page: options.query.page, pageSize: options.query.pageSize, counts: { official_document: 1, query: 1, export_batch: 1 }, selection: 'explicit', completeness: 'not_implied_by_catalog' })))
  const wrapper = mount(ComparisonSourcePicker, { props: { selection: { queryIds: [], exportBatchIds: [], officialSourceDocumentIds: [], proofIds: [] } }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  wrapperList.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('2024 年专精特新公布名单')
  expect(wrapper.text()).toContain('2024-10-01')
  await wrapper.get('[aria-label="选择2024 年专精特新公布名单"]').trigger('click')
  expect(wrapper.emitted('change')?.[0]?.[0]).toMatchObject({ officialSourceDocumentIds: [3] })
  wrapper.findComponent(Tabs).vm.$emit('update:modelValue', 'query')
  await flushPromises()
  expect(wrapper.text()).toContain('部分采集')
  expect(wrapper.text()).toContain('2025-01-02')
  expect(wrapper.get('[aria-label="选择申报流程 · 专精特新中小企业 · 合成企业"]').attributes('disabled')).toBeUndefined()
  wrapper.findComponent(Tabs).vm.$emit('update:modelValue', 'export_batch')
  await flushPromises()
  expect(wrapper.get('[aria-label="选择专精特新中小企业 · 2025 · export.xlsx"]').attributes('disabled')).toBeDefined()
})

it('keeps bookmarked selection after name hydration fails and offers a retry', async () => {
  let failSelected = true
  vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: { kind: keyof typeof rows; pageSize: number; page: number } }) => {
    if (options.query.kind === 'query' && options.query.pageSize === 200 && failSelected) throw new Error('offline')
    return { rows: rows[options.query.kind], total: 1, page: options.query.page, pageSize: options.query.pageSize, counts: { official_document: 1, query: 1, export_batch: 1 }, selection: 'explicit', completeness: 'not_implied_by_catalog' }
  }))
  const wrapper = mount(ComparisonSourcePicker, { props: { selection: { queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [], proofIds: [] } }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  wrapperList.push(wrapper)
  await flushPromises()
  await wrapper.get('[aria-label="已选来源"] [data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('来源名称暂不可读')
  expect(wrapper.text()).toContain('重试读取已选来源名称')
  failSelected = false
  await wrapper.findAll('button').find(button => button.text() === '重试读取已选来源名称')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('申报流程 · 专精特新中小企业 · 合成企业')
})


it('does not let an older selected label response settle or replace the current selection layout', async () => {
  const pending: ((value: unknown) => void)[] = []
  vi.stubGlobal('$fetch', vi.fn((_url: string, options: { query: { pageSize: number } }) => {
    if (options.query.pageSize === 25) return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 })
    return new Promise(resolve => { pending.push(resolve) })
  }))
  const selection = { queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [], proofIds: [] }
  const wrapper = mount(ComparisonSourcePicker, { props: { selection }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  wrapperList.push(wrapper)
  await flushPromises()
  expect(wrapper.emitted('settled')?.at(-1)?.[1]).toBe(false)
  const next = { ...selection, queryIds: [9] }
  await wrapper.setProps({ selection: next })
  pending[0]!({ rows: rows.query, total: 1, page: 1, pageSize: 200 })
  await flushPromises()
  expect(wrapper.emitted('settled')?.at(-1)).toEqual([JSON.stringify(next), false])
  await wrapper.get('[aria-label="已选来源"] [data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[aria-label="已选来源"]').text()).toContain('正在读取来源名称')
  pending[1]!({ rows: [{ ...rows.query[0], id: 9, label: '当前查询名称' }], total: 1, page: 1, pageSize: 200 })
  await flushPromises()
  expect(wrapper.emitted('settled')?.at(-1)).toEqual([JSON.stringify(next), true])
  expect(wrapper.get('[aria-label="已选来源"]').text()).toContain('当前查询名称')
  expect(wrapper.get('[aria-label="已选来源"]').text()).not.toContain('合成企业')
})
