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
