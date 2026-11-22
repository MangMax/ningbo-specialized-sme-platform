// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonSourcePicker from '../../../layers/sme-roster/app/components/record-correspondence/ComparisonSourcePicker.vue'
import { Tabs } from '../../../layers/core/app/components/ui/tabs'

const rows = {
  official_document: [{ kind: 'official_document', id: 3, label: '关于公布 2024 年专精特新企业名单的公告', subtitle: '甬经信〔2024〕1号', titleCode: null, titleName: null, observedAt: '2024-10-01', status: 'available', selectable: true, path: 'jxj/a.pdf' }],
  query: [{ kind: 'query', id: 7, label: '申报流程 · 专精特新中小企业 · 合成企业', subtitle: 'apply_list', titleCode: 'specialized_sme', titleName: '专精特新中小企业', observedAt: '2025-01-02T00:00:00Z', status: 'partial', selectable: true, rdjb: '2', completeness: 'partial', fullRange: false, conditions: { combination: 'and', uscc: '913300000000000004' }, confirmedEnterprises: [{ relationId: 21, sequenceNo: 1, enterpriseId: 7, enterpriseName: '合成111-归并', nameRaw: '合成111-归并旧主体', matchBasis: 'manual', aliasConfirmed: true, mergedFromEnterpriseId: 8 }], recordNames: [] }],
  export_batch: [{ kind: 'export_batch', id: 8, label: '专精特新中小企业 · 2025 · export.xlsx', subtitle: 'export.xlsx', titleCode: 'specialized_sme', titleName: '专精特新中小企业', observedAt: '2025-02-01', status: 'failed', selectable: false, sha256: 'a'.repeat(64), rowCount: 0, replacedBatchId: null }],
}
const queryTitle = (name: string) => `申报办理记录 · ${name} · 按统一社会信用代码查询 · 条件同时满足`
const wrapperList: ReturnType<typeof mount>[] = []
afterEach(() => { for (const wrapper of wrapperList.splice(0)) wrapper.unmount(); vi.unstubAllGlobals() })

it('offers an explicit route to every query and preserves selection when the catalog is collapsed', async () => {
  const queries = Array.from({ length: 14 }, (_, index) => ({ ...rows.query[0], id: index + 1, titleName: `平台查询 ${index + 1}` }))
  vi.stubGlobal('$fetch', vi.fn(async () => ({ rows: queries, total: 14, page: 1, pageSize: 25 })))
  const wrapper = mount(ComparisonSourcePicker, { props: { kind: 'query', selection: { queryIds: [], exportBatchIds: [], officialSourceDocumentIds: [] } }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  wrapperList.push(wrapper)
  await flushPromises()
  expect(wrapper.find(`[aria-label="选择${queryTitle('平台查询 14')}"]`).exists()).toBe(false)
  await wrapper.findAll('button').find(button => button.text().includes('查看全部 14'))!.trigger('click')
  await wrapper.get(`[aria-label="选择${queryTitle('平台查询 14')}"]`).trigger('click')
  expect(wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ queryIds: [14] })
  await wrapper.setProps({ selection: { queryIds: [14], exportBatchIds: [], officialSourceDocumentIds: [] } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text().includes('收起，只看前'))!.trigger('click')
  await wrapper.get('[aria-label="已选来源"] [data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[aria-label="已选来源"]').text()).toContain('平台查询 14')
  expect(wrapper.emitted('change')).toHaveLength(1)
})

it('shows human source names and times, permits partial queries, and blocks failed export batches', async () => {
  vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: { kind: keyof typeof rows; page: number; pageSize: number } }) => ({ rows: rows[options.query.kind], total: 1, page: options.query.page, pageSize: options.query.pageSize, counts: { official_document: 1, query: 1, export_batch: 1 }, selection: 'explicit', completeness: 'not_implied_by_catalog' })))
  const wrapper = mount(ComparisonSourcePicker, { props: { selection: { queryIds: [], exportBatchIds: [], officialSourceDocumentIds: [] } }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  wrapperList.push(wrapper)
  await flushPromises()
  expect(wrapper.get('[role=tab][data-state=active]').text()).toBe('公布名单 · 0')
  expect(wrapper.text()).toContain('关于公布 2024 年专精特新企业名单的公告')
  expect(wrapper.text()).toContain('2024-10-01')
  await wrapper.get('[aria-label="选择关于公布 2024 年专精特新企业名单的公告"]').trigger('click')
  expect(wrapper.emitted('change')?.[0]?.[0]).toMatchObject({ officialSourceDocumentIds: [3] })
  wrapper.findComponent(Tabs).vm.$emit('update:modelValue', 'query')
  await flushPromises()
  expect(wrapper.text()).toContain('部分采集')
  expect(wrapper.text()).toContain('2025-01-02')
  expect(wrapper.get('[data-testid="source-enterprise-identity"]').text()).toBe('已确认主体 1 家：合成111-归并（#7）')
  expect(wrapper.get('[data-testid="source-raw-name"]').text()).toContain('平台原行名称：合成111-归并旧主体 → 合成111-归并（#7）')
  expect(wrapper.get('[data-testid="source-raw-name"]').text()).toContain('归并自 #8')
  expect(wrapper.text()).not.toContain('未关联企业名称')
  expect(wrapper.get(`[aria-label="选择${queryTitle('专精特新中小企业')}"]`).attributes('disabled')).toBeUndefined()
  wrapper.findComponent(Tabs).vm.$emit('update:modelValue', 'export_batch')
  await flushPromises()
  expect(wrapper.get('[aria-label="选择专精特新中小企业 · 2025 · export.xlsx"]').attributes('disabled')).toBeDefined()
})

it('marks unconfirmed platform names and keeps large confirmed lists out of the row until expanded', async () => {
  const confirmedEnterprises = Array.from({ length: 5 }, (_, index) => ({
    relationId: 100 + index,
    sequenceNo: index + 1,
    enterpriseId: index + 1,
    enterpriseName: `企业${index + 1}`,
    nameRaw: `原行${index + 1}`,
    matchBasis: 'uscc',
    aliasConfirmed: false,
    mergedFromEnterpriseId: null,
  }))
  const queryRows = [
    { ...rows.query[0], id: 9, confirmedEnterprises: [], recordNames: ['平台原行待关联'] },
    { ...rows.query[0], id: 10, confirmedEnterprises, recordNames: ['另一个未确认名称'] },
  ]
  vi.stubGlobal('$fetch', vi.fn(async () => ({ rows: queryRows, total: 2, page: 1, pageSize: 25 })))
  const wrapper = mount(ComparisonSourcePicker, { props: { kind: 'query', selection: { queryIds: [], exportBatchIds: [], officialSourceDocumentIds: [] } }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  wrapperList.push(wrapper)
  await flushPromises()
  const identities = wrapper.findAll('[data-testid="source-enterprise-identity"]').map(node => node.text())
  const unconfirmed = wrapper.findAll('[data-testid="source-unconfirmed-name"]').map(node => node.text())
  expect(unconfirmed).toContain('平台记录名称（未确认主体）：平台原行待关联')
  expect(unconfirmed).toContain('平台记录名称（未确认主体）：另一个未确认名称')
  expect(identities).toContain('已确认主体 5 家：企业1（#1）、企业2（#2）、企业3（#3） 等')
  expect(wrapper.find('[data-testid="source-enterprise-details"]').exists()).toBe(false)
  await wrapper.findAll('button').find(button => button.text().includes('查看全部 6 条主体信息'))!.trigger('click')
  const details = wrapper.get('[data-testid="source-enterprise-details"]').findAll('li').map(node => node.text())
  expect(details).toHaveLength(6)
  expect(details[0]).toContain('平台原行名称：原行1')
  expect(details.at(-1)).toBe('平台记录名称（未确认主体）：另一个未确认名称')
})
it('keeps bookmarked selection after name hydration fails and offers a retry', async () => {
  let failSelected = true
  vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: { query: { kind: keyof typeof rows; pageSize: number; page: number } }) => {
    if (options.query.kind === 'query' && options.query.pageSize === 200 && failSelected) throw new Error('offline')
    return { rows: rows[options.query.kind], total: 1, page: options.query.page, pageSize: options.query.pageSize, counts: { official_document: 1, query: 1, export_batch: 1 }, selection: 'explicit', completeness: 'not_implied_by_catalog' }
  }))
  const wrapper = mount(ComparisonSourcePicker, { props: { selection: { queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [] } }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  wrapperList.push(wrapper)
  await flushPromises()
  await wrapper.get('[aria-label="已选来源"] [data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('来源名称暂不可读')
  expect(wrapper.text()).toContain('重试读取已选来源名称')
  failSelected = false
  await wrapper.findAll('button').find(button => button.text() === '重试读取已选来源名称')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain(queryTitle('专精特新中小企业'))
})


it('does not let an older selected label response settle or replace the current selection layout', async () => {
  const pending: ((value: unknown) => void)[] = []
  vi.stubGlobal('$fetch', vi.fn((_url: string, options: { query: { pageSize: number } }) => {
    if (options.query.pageSize === 25) return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 })
    return new Promise(resolve => { pending.push(resolve) })
  }))
  const selection = { queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [] }
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
  pending[1]!({ rows: [{ ...rows.query[0], id: 9, titleName: '当前查询名称' }], total: 1, page: 1, pageSize: 200 })
  await flushPromises()
  expect(wrapper.emitted('settled')?.at(-1)).toEqual([JSON.stringify(next), true])
  expect(wrapper.get('[aria-label="已选来源"]').text()).toContain('当前查询名称')
  expect(wrapper.get('[aria-label="已选来源"]').text()).not.toContain('合成企业')
})

it('hydrates a bookmarked source by its explicit ID without walking unrelated catalog pages', async () => {
  const calls: any[] = []
  vi.stubGlobal('$fetch', vi.fn(async (_url: string, options: any) => {
    calls.push(options.query)
    if (options.query.ids) return { rows: [{ ...rows.query[0], id: 39000, titleName: '精确所选查询' }], total: 1, page: 1, pageSize: 200 }
    return { rows: [], total: 39303, page: 1, pageSize: options.query.pageSize }
  }))
  const wrapper = mount(ComparisonSourcePicker, { props: { kind: 'query', selection: { queryIds: [39000], exportBatchIds: [], officialSourceDocumentIds: [] } }, global: { stubs: { TableLoadingStatus: true, TableFailureState: true, TablePagination: true } } })
  wrapperList.push(wrapper)
  await flushPromises()
  await wrapper.get('[aria-label="已选来源"] [data-slot="accordion-trigger"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[aria-label="已选来源"]').text()).toContain('精确所选查询')
  expect(calls.filter(query => query.pageSize === 200)).toEqual([{ kind: 'query', page: 1, pageSize: 200, ids: '39000' }])
})
