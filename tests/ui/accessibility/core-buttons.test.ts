// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import EnterpriseListTable from '../../../layers/sme-roster/app/components/EnterpriseListTable.vue'
import EnterpriseAliasSummary from '../../../layers/sme-roster/app/components/EnterpriseAliasSummary.vue'
import EnterpriseTitleSummary from '../../../layers/sme-roster/app/components/EnterpriseTitleSummary.vue'
import PreviewToolbar from '../../../layers/core/app/components/preview/PreviewToolbar.vue'

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

const enterpriseListRow = {
  enterpriseId: 7289,
  name: '宁波上航测绘股份有限公司',
  uscc: null,
  district: null,
  aliasNames: ['旧名一'],
  titles: ['little_giant'],
  firstRecognition: [{ titleCode: 'little_giant', year: 2021, needsReview: false }],
  difference: { count: 0, status: null, reasonCode: null, anyCurrent: false },
}

/**
 * 核心交互按钮的统一交互态(#869):要么渲染成 ui/button(自带
 * default/hover/focus-visible/disabled 一整套),要么手写类里补齐
 * focus-visible 环与 disabled 半透——不再有只吃全局兜底环的裸 <button>。
 */
describe('核心交互按钮的完整交互态', () => {
  it('企业名触发器渲染为 ui/button(data-slot),自带完整状态', () => {
    const wrapper = mount(EnterpriseListTable, {
      props: { rows: [enterpriseListRow], loading: false, hasError: false, selectedId: null, filtered: false },
    })
    mounted.push(wrapper)
    const trigger = wrapper.get('[data-testid="enterprise-name-trigger"]')
    expect(trigger.attributes('data-slot')).toBe('button')
  })

  it('曾用名按钮保留 data-testid/aria-label,并带显式 focus-visible 与 disabled 态', () => {
    const wrapper = mount(EnterpriseAliasSummary, { props: { names: ['旧名一', '旧名二'] } })
    mounted.push(wrapper)
    const btn = wrapper.get('[data-testid="alias-summary"]')
    expect(btn.attributes('aria-label')).toBe('查看全部曾用名')
    const cls = btn.classes().join(' ')
    expect(cls).toContain('focus-visible:ring-3')
    expect(cls).toContain('disabled:opacity-50')
  })

  it('称号徽标按钮保留 data-testid/aria-label,并带显式 focus-visible 与 disabled 态', () => {
    const wrapper = mount(EnterpriseTitleSummary, {
      props: { titles: ['little_giant'], firstRecognition: [{ titleCode: 'little_giant', year: 2021 }] },
    })
    mounted.push(wrapper)
    const btn = wrapper.get('[data-testid="title-recognition-list"]')
    expect(btn.attributes('aria-label')).toBe('查看全部称号年份批次')
    const cls = btn.classes().join(' ')
    expect(cls).toContain('focus-visible:ring-3')
    expect(cls).toContain('disabled:opacity-50')
  })

  it('名录表企业名按钮渲染为 ui/button,并标出当前打开抽屉的行', () => {
    const wrapper = mount(EnterpriseListTable, {
      props: { rows: [enterpriseListRow], loading: false, hasError: false, selectedId: null, filtered: false },
    })
    mounted.push(wrapper)
    const nameBtn = wrapper.get('[data-testid="enterprise-name-trigger"]')
    expect(nameBtn.attributes('data-slot')).toBe('button')
    expect(nameBtn.element.tagName).toBe('BUTTON')

    const openRow = mount(EnterpriseListTable, {
      props: { rows: [enterpriseListRow], loading: false, hasError: false, selectedId: 7289, filtered: false },
    })
    mounted.push(openRow)
    const row = openRow.get('tbody tr')
    expect(row.attributes('aria-current')).toBe('true')
    expect(row.classes()).toContain('bg-accent')
  })

  it('预览工具栏缩放重置按钮渲染为 ui/button,保留 aria-label 文案', () => {
    const wrapper = mount(PreviewToolbar, { props: { title: 'a.pdf', zoom: 1, href: null } })
    mounted.push(wrapper)
    const btn = wrapper.get('[aria-label="100% · 恢复到 100%"]')
    expect(btn.attributes('data-slot')).toBe('button')
  })
})
