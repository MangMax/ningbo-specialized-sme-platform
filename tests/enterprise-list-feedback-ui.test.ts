// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EnterpriseListTable, { type EnterpriseListRow } from '../components/EnterpriseListTable.vue'

const row: EnterpriseListRow = {
  enterpriseId: 1, name: '宁波测试企业', uscc: null, district: null,
  aliasNames: ['旧名一', '旧名二', '旧名三'],
  titles: ['little_giant', 'specialized_sme', 'innovative_sme'],
  firstRecognition: [{ titleCode: 'little_giant', year: 2021, needsReview: false }],
  awards: [
    { titleCode: 'little_giant', year: 2021, batchSeq: 3 },
    { titleCode: 'specialized_sme', year: 2020, batchSeq: 2 },
    { titleCode: 'innovative_sme', year: 2019, batchSeq: 1 },
  ],
  difference: { count: 1, status: 'confirmed_reason', reasonCode: 'platform_stale', anyCurrent: true },
}
const render = (patch: Partial<EnterpriseListRow> = {}) => mount(EnterpriseListTable, {
  props: { rows: [{ ...row, ...patch }], loading: false, hasError: false, selectedId: null, filtered: false },
})
describe('企业列表紧凑信息展示', () => {
  it('移除行前状态块并直接显示已知原因', () => {
    const view = render()
    expect(view.get('[data-testid="enterprise-difference-cell"]').text()).toBe('平台未更新')
    view.unmount()
  })
  it('年份未知时仍保留已知批次', () => {
    const view = render({titles: ['little_giant'], firstRecognition: [], awards: [{titleCode: 'little_giant',year: null,batchSeq: 3}]})
    expect(view.get('[data-testid="title-recognition-list"]').text()).toContain('年待核-3')
    view.unmount()
  })
  it('称号保留年份批次标签并用数量折叠余项，曾用名只显示一项与余项数量', () => {
    const view = render()
    expect(view.get('[data-testid="title-recognition-list"]').text()).toContain('2021-3')
    expect(view.get('[data-testid="title-overflow-trigger"]').text()).toBe('+2')
    expect(view.get('[data-testid="alias-summary"]').text()).toContain('旧名一')
    expect(view.get('[data-testid="alias-overflow-trigger"]').text()).toBe('+2')
    expect(view.get('[data-testid="alias-summary"]').text()).not.toContain('旧名二')
    view.unmount()
  })
})
